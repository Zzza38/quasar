import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Entity } from '@/domain/sync';
import { taskSchema, type Task } from '@/domain/task';
import { MERGE_MAX, mergeTasks, pickKeep } from '@/domain/task-merge';
import { readEntity, writeEntity } from './entities';
import type { Service } from './service';

/**
 * Merging duplicate tasks: Tasks → Duplicates for everyone (the student picks the tasks), and the AI's duplicate
 * check in the ai-tasks beta (src/server/ai.ts). The server does the merge itself, like a calendar refresh, so a
 * calendar import keeps its link and comes back whole on Undo. Clients pick the change up on their next sync.
 *
 * Every merge is kept in task_merges with the tasks as they were. Undo puts back each removed task nobody has touched
 * since, and the kept task too when it hasn't changed. Undone merges and "Not duplicates" are remembered as pairs the
 * AI must never merge again.
 */

export const mergeSchema = z.object({
  keepId: z.string().min(1).max(100),
  removeIds: z.array(z.string().min(1).max(100)).min(1).max(MERGE_MAX - 1),
  reason: z.string().max(200).optional(),
});
export const mergeIdSchema = z.object({ id: z.uuid() });
export const notDuplicatesSchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(2).max(MERGE_MAX) });

export type MergeTaskSnapshot = {
  id: string; title: string; classId: string | null; dueDate: string | null; dueTime: string | null;
  origin: 'calendar' | 'schoology' | 'quasar';
  details: Task | null;
};
export type MergeEntry = {
  id: string; source: 'ai' | 'manual'; reason: string; createdAt: string; undoneAt: string | null;
  kept: MergeTaskSnapshot & { exists: boolean }; removed: MergeTaskSnapshot[];
  current: MergeTaskSnapshot | null;
};
type MergeRow = { id: string; source: 'ai' | 'manual'; reason: string; kept_id: string; kept_before: string; kept_version: number; removed: string; created_at: string; undone_at: string | null };

const HISTORY_LIMIT = 50;
const fail = (code: TRPCError['code'], message: string): never => { throw new TRPCError({ code, message }); };
const pairKey = (a: string, b: string) => a < b ? [a, b] as const : [b, a] as const;

export class MergeService {
  constructor(private readonly service: Service, private readonly now: () => Date = () => new Date()) {}
  private get db() { return this.service.db; }

  /** A live task, or a NOT_FOUND naming what to do: the client may not have synced a deletion yet. */
  private task(userId: string, id: string): { entity: Entity; task: Task } {
    const entity = readEntity(this.db, userId, id);
    const parsed = entity && entity.kind === 'task' && !entity.deleted ? taskSchema.safeParse(entity.data) : null;
    if (!entity || !parsed?.success) return fail('NOT_FOUND', 'One of those tasks was deleted or changed. Reload and try again.');
    return { entity, task: parsed.data };
  }

  /** Folds `removeIds` into `keepId` and deletes them, in one transaction. */
  merge(userId: string, raw: z.input<typeof mergeSchema>, source: 'ai' | 'manual' = 'manual'): MergeEntry {
    this.service.ready(userId);
    const input = mergeSchema.parse(raw);
    const ids = [input.keepId, ...input.removeIds];
    if (new Set(ids).size !== ids.length) fail('BAD_REQUEST', 'Pick each task once.');
    return this.db.transaction(() => {
      const keep = this.task(userId, input.keepId);
      const removed = input.removeIds.map((id) => this.task(userId, id));
      const merged = mergeTasks(keep.task, removed.map((entry) => entry.task));
      const at = this.now().toISOString();
      const keptVersion = keep.entity.version + 1;
      writeEntity(this.db, userId, { ...keep.entity, version: keptVersion, data: merged });
      for (const entry of removed) writeEntity(this.db, userId, { ...entry.entity, version: entry.entity.version + 1, deleted: true, data: {} });
      const id = randomUUID();
      const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      this.db.prepare('INSERT INTO task_merges(id,owner_id,source,reason,kept_id,kept_before,kept_version,removed,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, userId, source, reason, keep.entity.id, JSON.stringify(keep.entity), keptVersion, JSON.stringify(removed.map((entry) => entry.entity)), at);
      this.service.audit(userId, 'task.merge', null, { source, kept: keep.entity.id, removed: input.removeIds.length });
      return this.entry(userId, this.db.prepare('SELECT * FROM task_merges WHERE id=?').get(id) as MergeRow);
    }).immediate();
  }

  /**
   * Puts the removed tasks back, and the kept task as it was, unless either changed since the merge. Returns how
   * many removed tasks came back and whether the kept task had to stay as it is.
   */
  undo(userId: string, raw: z.input<typeof mergeIdSchema>): { restored: number; skipped: number; keptChanged: boolean } {
    this.service.ready(userId);
    const { id } = mergeIdSchema.parse(raw);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM task_merges WHERE id=? AND owner_id=?').get(id, userId) as MergeRow | undefined;
      if (!row) return fail('NOT_FOUND', 'That merge isn’t in your history any more.');
      if (row.undone_at) fail('BAD_REQUEST', 'That merge was already undone.');
      let restored = 0, skipped = 0;
      const removed = JSON.parse(row.removed) as Entity[];
      for (const before of removed) {
        const current = readEntity(this.db, userId, before.id);
        // Only a task still deleted by this merge comes back; one restored or re-added since stays as the student left it.
        if (current && current.deleted && current.version === before.version + 1) { writeEntity(this.db, userId, { ...before, version: current.version + 1, deleted: false }); restored += 1; }
        else skipped += 1;
      }
      const keptBefore = JSON.parse(row.kept_before) as Entity;
      const kept = readEntity(this.db, userId, row.kept_id);
      const keptChanged = !kept || kept.deleted || kept.version !== row.kept_version;
      if (!keptChanged) writeEntity(this.db, userId, { ...keptBefore, version: kept!.version + 1 });
      this.db.prepare('UPDATE task_merges SET undone_at=? WHERE id=?').run(this.now().toISOString(), id);
      this.remember(userId, [row.kept_id, ...removed.map((entity) => entity.id)]);
      this.service.audit(userId, 'task.mergeUndo', null, { restored, skipped, keptChanged });
      return { restored, skipped, keptChanged };
    }).immediate();
  }

  /** "Not duplicates": the AI never suggests or merges these tasks together again. */
  notDuplicates(userId: string, raw: z.input<typeof notDuplicatesSchema>): void {
    this.service.ready(userId);
    this.remember(userId, notDuplicatesSchema.parse(raw).ids);
  }

  /** Whether any two of `ids` were marked as not duplicates. */
  apart(userId: string, ids: string[]): boolean {
    const check = this.db.prepare('SELECT 1 FROM task_not_duplicates WHERE owner_id=? AND first_id=? AND second_id=?');
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) if (check.get(userId, ...pairKey(ids[i], ids[j]))) return true;
    return false;
  }

  history(userId: string): MergeEntry[] {
    this.service.user(userId);
    return (this.db.prepare('SELECT * FROM task_merges WHERE owner_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, HISTORY_LIMIT) as MergeRow[]).map((row) => this.entry(userId, row));
  }

  /** The task to keep among live tasks `ids`, by the same rule the client previews. */
  keepOf(userId: string, ids: string[]): string {
    return pickKeep(ids.map((id) => ({ id, task: this.task(userId, id).task }))).id;
  }

  private remember(userId: string, ids: string[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO task_not_duplicates(owner_id,first_id,second_id,created_at) VALUES(?,?,?,?)');
    const at = this.now().toISOString();
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) if (ids[i] !== ids[j]) insert.run(userId, ...pairKey(ids[i], ids[j]), at);
  }

  private entry(userId: string, row: MergeRow): MergeEntry {
    // Use the saved originals so later edits do not rewrite what the history says was merged.
    const snapshot = (entity: Entity): MergeTaskSnapshot => ({
      id: entity.id,
      title: typeof entity.data.title === 'string' ? entity.data.title : 'Untitled task',
      classId: typeof entity.data.classId === 'string' ? entity.data.classId : null,
      dueDate: typeof entity.data.dueDate === 'string' ? entity.data.dueDate : null,
      dueTime: typeof entity.data.dueTime === 'string' ? entity.data.dueTime : null,
      origin: entity.data.imported ? 'calendar' : entity.id.startsWith('sgy_') ? 'schoology' : 'quasar',
      details: taskSchema.safeParse(entity.data).data ?? null,
    });
    const kept = readEntity(this.db, userId, row.kept_id);
    const keptBefore = JSON.parse(row.kept_before) as Entity;
    return {
      id: row.id, source: row.source, reason: row.reason, createdAt: row.created_at, undoneAt: row.undone_at,
      kept: { ...snapshot(keptBefore), exists: !!kept && !kept.deleted },
      removed: (JSON.parse(row.removed) as Entity[]).map(snapshot),
      current: kept && !kept.deleted ? snapshot(kept) : null,
    };
  }
}
