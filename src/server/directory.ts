import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { classSchema, gradeSchema, gradesSchema, GRADES } from '@/domain/schedule';
import { classKey, couldBeClass, directoryCandidates, directoryForms, isFreePeriodName, maybeSameClass, resolveDirectoryEntry, sameClass, similarClassName, type DirectoryDetails } from '@/domain/class-match';
import { readEntity, writeEntity } from './entities';
import type { Db } from './db';
import type { Service } from './service';

export const directoryDetailsSchema = classSchema.pick({ name: true, room: true, teacher: true }).extend({ grades: gradesSchema });
const spellingSchema = classSchema.pick({ name: true, room: true, teacher: true });
/**
 * What a row stores: the editable details, other spellings students confirmed as this class, and spellings support
 * decided are a different class (a student cannot confirm those again).
 */
const storedSchema = directoryDetailsSchema.extend({ aliases: z.array(spellingSchema).max(20).optional(), separate: z.array(spellingSchema).max(50).optional() });
type Spelling = z.infer<typeof spellingSchema>;
/** A support request (kind MERGE_KIND) to review spellings students linked to an entry, and duplicate entries to fold in. */
const mergeDetailSchema = z.object({ entryId: z.uuid(), aliases: z.array(spellingSchema), duplicateIds: z.array(z.uuid()) });
export type MergeDetail = z.infer<typeof mergeDetailSchema>;
export const MERGE_KIND = 'directory:merge';
export const directoryMergeSchema = z.object({ requestId: z.uuid(), decision: z.enum(['merge', 'separate']), name: z.string().trim().max(120).optional() });
const ownClassSchema = spellingSchema.extend({ directoryId: z.uuid().optional() });
/** A student's own classes, sent so each can be linked to its directory entry. */
export const directoryPublishSchema = z.object({ schoolId: z.uuid(), grade: gradeSchema.optional(), classes: z.array(ownClassSchema.extend({ id: z.string().min(1).max(120) })).max(100) });
/** A student's class and a schoolmate's class the student confirmed are one class. */
export const directoryConfirmSchema = z.object({ schoolId: z.uuid(), grade: gradeSchema.optional(), mine: ownClassSchema, theirs: ownClassSchema });
export const directorySaveSchema = z.object({ schoolId: z.uuid(), id: z.uuid().optional(), expectedVersion: z.number().int().positive().optional(), details: directoryDetailsSchema });
export const directoryRemoveSchema = z.object({ schoolId: z.uuid(), id: z.uuid(), expectedVersion: z.number().int().positive() });
export const directoryImportSchema = z.object({
  schoolId: z.uuid(), grade: gradeSchema.optional(),
  rows: z.array(directoryDetailsSchema.omit({ grades: true }).extend({
    directoryId: z.uuid().optional(), expectedVersion: z.number().int().positive().optional(),
    correctName: z.boolean().default(false), separate: z.boolean().default(false),
  }).refine(row => !row.correctName || (!!row.directoryId && !!row.expectedVersion), 'Review the directory class before correcting it.')).min(1).max(100),
});
type Row = { id: string; school_id: string; data: string; version: number; deleted: number };
export type DirectoryClass = z.infer<typeof storedSchema> & { id: string; version: number };

export class DirectoryService {
  constructor(private readonly service: Service) {}
  private access(accountId: string, schoolId: string, write = false) {
    const user = this.service.ready(accountId);
    const admin = this.service.isAdmin(accountId);
    if (user.schoolId !== schoolId && !admin) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only school members can access this class directory.' });
    const school = this.service.school(schoolId);
    const canEdit = admin || (!school.memberLocked && !school.supportLocked && school.memberCount < 10);
    if (write && !canEdit) throw new TRPCError({ code: 'FORBIDDEN', message: 'The school directory is locked. Edit your personal copy or request a correction from support.' });
    return canEdit;
  }
  list(accountId: string, schoolId: string) {
    const canEdit = this.access(accountId, schoolId);
    const rows = this.service.db.prepare('SELECT * FROM school_classes WHERE school_id=? AND deleted=0 ORDER BY json_extract(data, \'$.name\') COLLATE NOCASE, id').all(schoolId) as Row[];
    return { accountId, canEdit, classes: rows.map(row => ({ ...storedSchema.parse(JSON.parse(row.data)), id: row.id, version: row.version } satisfies DirectoryClass)) };
  }
  /**
   * Any member may add a class: a missing class costs every classmate their matches, while an added one changes no
   * one's data. Edits stay behind the lock, since they change what other students already picked.
   */
  save(accountId: string, raw: z.infer<typeof directorySaveSchema>) {
    const input = directorySaveSchema.parse(raw);
    return this.service.db.transaction(() => {
      this.access(accountId, input.schoolId, !!input.id);
      const existing = input.id ? this.service.db.prepare('SELECT * FROM school_classes WHERE id=? AND school_id=? AND deleted=0').get(input.id, input.schoolId) as Row | undefined : undefined;
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'This directory class was removed. Reload the directory.' });
      if (existing && existing.version !== input.expectedVersion) throw new TRPCError({ code: 'CONFLICT', message: 'This directory class changed. Reload and review it before saving.' });
      // An edit keeps the confirmed and the rejected spellings; the edit form never shows them.
      const { aliases, separate } = existing ? storedSchema.parse(JSON.parse(existing.data)) : {};
      return this.write(accountId, input.schoolId, existing, { ...input.details, ...(aliases?.length ? { aliases } : {}), ...(separate?.length ? { separate } : {}) });
    }).immediate();
  }
  private write(accountId: string, schoolId: string, existing: Row | undefined, details: z.infer<typeof storedSchema>, action?: string): DirectoryClass {
    if (!existing) {
      const count = this.service.db.prepare('SELECT count(*) n FROM school_classes WHERE school_id=? AND deleted=0').get(schoolId) as { n: number };
      if (count.n >= 1000) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The directory can contain up to 1,000 classes.' });
    }
    const id = existing?.id ?? randomUUID();
    const version = (existing?.version ?? 0) + 1;
    const now = new Date().toISOString();
    this.service.db.prepare(`INSERT INTO school_classes(id,school_id,data,version,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at`)
      .run(id, schoolId, JSON.stringify(details), version, now);
    this.audit(accountId, schoolId, action ?? (existing ? 'directory.update' : 'directory.create'), { id, version, details });
    return { ...details, id, version };
  }
  private add(accountId: string, schoolId: string, details: DirectoryDetails, grade: z.infer<typeof gradeSchema> | undefined, action?: string) {
    return this.write(accountId, schoolId, undefined, {
      name: details.name.trim(), ...(details.teacher?.trim() ? { teacher: details.teacher.trim() } : {}), ...(details.room?.trim() ? { room: details.room.trim() } : {}),
      grades: grade ? [grade] : [...GRADES],
    }, action);
  }
  /** Records another spelling of an entry, unless the entry already lists that name for that section. */
  private addAlias(accountId: string, schoolId: string, entry: DirectoryClass, spelling: DirectoryDetails): DirectoryClass {
    const alias = { name: spelling.name.trim(), ...(spelling.teacher?.trim() ? { teacher: spelling.teacher.trim() } : {}), ...(spelling.room?.trim() ? { room: spelling.room.trim() } : {}) };
    const known = directoryForms(entry).some(form => sameSpelling(form, alias));
    if (known || (entry.aliases?.length ?? 0) >= 20) return entry;
    const row = this.service.db.prepare('SELECT * FROM school_classes WHERE id=? AND school_id=? AND deleted=0').get(entry.id, schoolId) as Row;
    const { id: _id, version: _version, ...details } = entry;
    return this.write(accountId, schoolId, row, { ...details, aliases: [...(entry.aliases ?? []), alias] }, 'directory.alias');
  }
  /**
   * Links a student's own classes to the directory and adds the ones it does not list yet, so classmates who typed
   * the class differently still find each other. A class that only resembles an entry (a likely typo) stays unlinked
   * for the student to confirm; free periods and classes with neither a teacher nor a room are skipped. Returns the
   * class IDs that now have an entry.
   */
  publish(accountId: string, raw: z.input<typeof directoryPublishSchema>) {
    const input = directoryPublishSchema.parse(raw);
    return this.service.db.transaction(() => {
      const all = this.list(accountId, input.schoolId).classes;
      const known = new Set(all.map(entry => entry.id));
      const entries = all.filter(entry => !input.grade || entry.grades.includes(input.grade));
      const links: Array<{ id: string; directoryId: string }> = [];
      for (const cls of input.classes) {
        if (cls.directoryId && known.has(cls.directoryId)) continue;
        // Without a teacher or room an entry would match every section of the course, so those classes keep matching by name.
        if (!cls.name.trim() || isFreePeriodName(cls.name) || (!cls.teacher?.trim() && !cls.room?.trim())) continue;
        let entry = resolveDirectoryEntry(cls, entries);
        if (!entry) {
          const { matches, similar } = directoryCandidates(cls, entries);
          if (matches.length || similar.length) continue;
          entry = this.add(accountId, input.schoolId, cls, input.grade, 'directory.publish');
          entries.push(entry);
        }
        links.push({ id: cls.id, directoryId: entry.id });
      }
      return { links };
    }).immediate();
  }
  /**
   * The student says their class and a schoolmate's are one class. Both get one entry: the schoolmate's, else the
   * student's, else a new one. The other spelling becomes an alias, so the schoolmate's class links to the same entry
   * the next time it is published and every classmate's matching agrees. Returns the entry for the student's class.
   */
  confirmSame(accountId: string, raw: z.input<typeof directoryConfirmSchema>) {
    const input = directoryConfirmSchema.parse(raw);
    const { directoryId: mineId, ...mine } = input.mine;
    const { directoryId: theirsId, ...theirs } = input.theirs;
    if (!maybeSameClass(mine, theirs) && !sameClass(mine, theirs)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'These classes have different teachers, rooms or names, so they cannot be linked.' });
    return this.service.db.transaction(() => {
      const all = this.list(accountId, input.schoolId).classes;
      const byId = (id?: string) => id ? all.find(entry => entry.id === id) : undefined;
      const entries = all.filter(entry => !input.grade || entry.grades.includes(input.grade));
      const theirsEntry = byId(theirsId), mineEntry = byId(mineId);
      let entry = theirsEntry ?? mineEntry ?? resolveDirectoryEntry(theirs, entries) ?? resolveDirectoryEntry(mine, entries)
        ?? this.add(accountId, input.schoolId, theirs, input.grade);
      if ([theirs, mine].some(spelling => (entry.separate ?? []).some(kept => sameSpelling(kept, spelling)))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Support reviewed these and keeps them as different classes.' });
      }
      const before = entry.aliases?.length ?? 0;
      for (const spelling of [theirs, mine]) entry = this.addAlias(accountId, input.schoolId, entry, spelling);
      // A new spelling or a second entry for the class goes to support, who merges it for good or keeps them apart.
      const added = (entry.aliases ?? []).slice(before);
      const duplicate = theirsEntry && mineEntry && theirsEntry.id !== mineEntry.id ? mineEntry.id : undefined;
      if (added.length || duplicate) requestMerge(this.service.db, accountId, input.schoolId, entry, added, duplicate ? [duplicate] : []);
      return { directoryId: entry.id, entry };
    }).immediate();
  }
  /**
   * Support's answer to a merge request. "merge" keeps the confirmed spellings, folds each duplicate entry into this
   * one (its names become aliases and its students' classes move here) and can rename the entry to any of its
   * spellings. "separate" drops the spellings, unlinks the classes only they matched, and remembers them so students
   * cannot link them again; duplicates stay as they are. Either way the request is resolved.
   */
  resolveMerge(adminId: string, raw: z.input<typeof directoryMergeSchema>) {
    this.service.admin(adminId);
    const input = directoryMergeSchema.parse(raw);
    const db = this.service.db;
    return db.transaction(() => {
      const request = db.prepare('SELECT * FROM support_requests WHERE id=? AND kind=? AND resolved_at IS NULL').get(input.requestId, MERGE_KIND) as { school_id: string; user_id: string; detail: string } | undefined;
      if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'This merge request was already resolved.' });
      const detail = mergeDetailSchema.parse(JSON.parse(request.detail));
      const schoolId = request.school_id;
      const row = activeRow(db, schoolId, detail.entryId);
      let moved = 0;
      if (row) {
        let entry = toClass(row);
        if (input.decision === 'merge') {
          const aliases = [...(entry.aliases ?? [])];
          for (const duplicateId of detail.duplicateIds) {
            const duplicateRow = duplicateId === entry.id ? undefined : activeRow(db, schoolId, duplicateId);
            if (!duplicateRow) continue;
            const duplicate = toClass(duplicateRow);
            for (const form of directoryForms(duplicate)) if (!directoryForms({ ...entry, aliases }).some(known => sameSpelling(known, form))) aliases.push(spelling(form));
            db.prepare('UPDATE school_classes SET deleted=1,version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(), duplicate.id);
            moved += relink(db, schoolId, cls => cls.directoryId === duplicate.id ? entry.id : cls.directoryId);
          }
          const name = input.name && directoryForms({ ...entry, aliases }).some(form => form.name === input.name) ? input.name : entry.name;
          // The old name stays matchable as an alias when support picks another spelling.
          const renamed = name === entry.name ? aliases : [...aliases.filter(alias => alias.name !== name), spelling(entry)];
          entry = this.write(adminId, schoolId, row, { ...entryDetails(entry), name, aliases: renamed.slice(0, 20), ...(entry.separate ? { separate: entry.separate } : {}) }, 'directory.merge');
        } else {
          const dropped = (alias: Spelling) => detail.aliases.some(rejected => sameSpelling(rejected, alias));
          const aliases = (entry.aliases ?? []).filter(alias => !dropped(alias));
          const separate = [...(entry.separate ?? []), ...detail.aliases].slice(-50);
          entry = this.write(adminId, schoolId, row, { ...entryDetails(entry), ...(aliases.length ? { aliases } : {}), separate }, 'directory.separate');
          const kept = entry;
          moved = relink(db, schoolId, cls => cls.directoryId === kept.id && !directoryForms(kept).some(form => couldBeClass(cls.name, form.name)) ? undefined : cls.directoryId);
        }
      }
      db.prepare('UPDATE support_requests SET resolved_at=? WHERE id=?').run(new Date().toISOString(), input.requestId);
      this.audit(adminId, schoolId, 'support.resolveMerge', { requestId: input.requestId, decision: input.decision, entryId: detail.entryId, classesChanged: moved });
      return { classesChanged: moved };
    }).immediate();
  }
  /** Reconcile reviewed scan rows in one transaction. Retries reuse entries; new classes are added even when the directory is locked, and only confirmed spelling corrections edit entries. */
  importClasses(accountId: string, raw: z.input<typeof directoryImportSchema>) {
    const input = directoryImportSchema.parse(raw);
    return this.service.db.transaction(() => {
      const directory = this.list(accountId, input.schoolId);
      const entries = directory.classes.filter(entry => !input.grade || entry.grades.includes(input.grade));
      let skipped = 0;
      const rows = input.rows.map(row => {
        let entry = row.directoryId ? entries.find(candidate => candidate.id === row.directoryId) : undefined;
        if (row.directoryId && !entry) throw new TRPCError({ code: 'CONFLICT', message: 'A selected directory class changed or was removed. Reload the directory and review it.' });
        if (!entry) {
          const candidates = directoryCandidates(row, entries);
          if (candidates.matches.length === 1) entry = candidates.matches[0];
          else if (!row.separate && (candidates.matches.length || candidates.similar.length)) {
            throw new TRPCError({ code: 'CONFLICT', message: `The directory has a possible match for “${row.name}”. Review whether it is the same class before adding it.` });
          }
        }
        if (entry && row.correctName) {
          if (!similarClassName(row.name, entry.name)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a confirmed spelling correction can rename this directory class.' });
          // A repeated request after a successful correction is harmless, even with its original version.
          if (entry.name !== row.name) {
            if (entry.version !== row.expectedVersion) throw new TRPCError({ code: 'CONFLICT', message: 'This directory class changed. Reload and review the correction again.' });
            if (directory.canEdit) {
              const updated = this.save(accountId, { schoolId: input.schoolId, id: entry.id, expectedVersion: entry.version, details: { name: row.name, ...(entry.teacher ? { teacher: entry.teacher } : {}), ...(entry.room ? { room: entry.room } : {}), grades: entry.grades } });
              entries[entries.indexOf(entry)] = updated;
              entry = updated;
            } else skipped++;
          }
        }
        if (!entry) {
          entry = this.add(accountId, input.schoolId, row, input.grade);
          entries.push(entry);
        }
        return {
          name: row.correctName ? row.name : entry?.name ?? row.name,
          teacher: row.teacher ?? entry?.teacher, room: row.room ?? entry?.room,
          ...(entry ? { directoryId: entry.id } : {}),
        };
      });
      return { rows, canEdit: directory.canEdit, skipped };
    }).immediate();
  }
  remove(accountId: string, raw: z.infer<typeof directoryRemoveSchema>) {
    const input = directoryRemoveSchema.parse(raw);
    this.service.db.transaction(() => {
      this.access(accountId, input.schoolId, true);
      const result = this.service.db.prepare('UPDATE school_classes SET deleted=1,version=version+1,updated_at=? WHERE id=? AND school_id=? AND version=? AND deleted=0')
        .run(new Date().toISOString(), input.id, input.schoolId, input.expectedVersion);
      if (!result.changes) throw new TRPCError({ code: 'CONFLICT', message: 'This directory class changed or was removed. Reload the directory.' });
      this.audit(accountId, input.schoolId, 'directory.remove', { id: input.id, version: input.expectedVersion + 1 });
    }).immediate();
  }
  private audit(actorId: string, schoolId: string, action: string, detail: unknown) {
    this.service.audit(actorId, action, schoolId, detail);
  }
}

const key = (value?: string) => classKey(value ?? '');
/** Same name words, and the same teacher and room where both list one. */
function sameSpelling(left: DirectoryDetails, right: DirectoryDetails): boolean {
  return key(left.name) === key(right.name) && (['teacher', 'room'] as const).every(field => !left[field]?.trim() || !right[field]?.trim() || key(left[field]) === key(right[field]));
}
const spelling = (form: DirectoryDetails): Spelling => ({ name: form.name, ...(form.teacher ? { teacher: form.teacher } : {}), ...(form.room ? { room: form.room } : {}) });
const entryDetails = (entry: DirectoryClass) => ({ name: entry.name, ...(entry.teacher ? { teacher: entry.teacher } : {}), ...(entry.room ? { room: entry.room } : {}), grades: entry.grades });
const activeRow = (db: Db, schoolId: string, id: string) => db.prepare('SELECT * FROM school_classes WHERE id=? AND school_id=? AND deleted=0').get(id, schoolId) as Row | undefined;
const toClass = (row: Row): DirectoryClass => ({ ...storedSchema.parse(JSON.parse(row.data)), id: row.id, version: row.version });

/**
 * Opens a merge request for support, or adds to the open one for this entry, so one entry never has two. Filed in the
 * confirming student's name but outside their five-request limit: the student did not write it.
 */
function requestMerge(db: Db, userId: string, schoolId: string, entry: DirectoryClass, aliases: Spelling[], duplicateIds: string[]) {
  const open = db.prepare('SELECT id, detail FROM support_requests WHERE kind=? AND school_id=? AND resolved_at IS NULL AND json_extract(detail, \'$.entryId\')=?').get(MERGE_KIND, schoolId, entry.id) as { id: string; detail: string } | undefined;
  const previous = open ? mergeDetailSchema.parse(JSON.parse(open.detail)) : { entryId: entry.id, aliases: [], duplicateIds: [] };
  const detail: MergeDetail = {
    entryId: entry.id,
    aliases: [...previous.aliases, ...aliases.filter(alias => !previous.aliases.some(known => sameSpelling(known, alias)))],
    duplicateIds: [...new Set([...previous.duplicateIds, ...duplicateIds])],
  };
  const describe = (form: DirectoryDetails) => `“${form.name}”${[form.teacher, form.room].some(Boolean) ? ` (${[form.teacher, form.room].filter(Boolean).join(' · ')})` : ''}`;
  const message = `Students linked ${detail.aliases.map(describe).join(', ') || 'another directory entry'} to the directory class ${describe(entry)}.${detail.duplicateIds.length ? ` ${detail.duplicateIds.length === 1 ? 'Another entry looks like' : `${detail.duplicateIds.length} other entries look like`} the same class.` : ''} Merge to keep them together, or keep them separate.`;
  if (open) db.prepare('UPDATE support_requests SET detail=?, message=? WHERE id=?').run(JSON.stringify(detail), message, open.id);
  else db.prepare('INSERT INTO support_requests(id,school_id,user_id,message,created_at,kind,detail) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), schoolId, userId, message, new Date().toISOString(), MERGE_KIND, JSON.stringify(detail));
}

/** What support sees for a merge request: the entry, the spellings, each duplicate, and how many classes each holds. */
export function mergeRequestView(db: Db, schoolId: string | null, raw: string) {
  const detail = mergeDetailSchema.parse(JSON.parse(raw));
  const linked = new Map<string, number>();
  if (schoolId) for (const row of db.prepare("SELECT e.data FROM entities e JOIN users u ON u.id=e.owner_id WHERE e.kind='personal' AND e.deleted=0 AND u.school_id=?").all(schoolId) as { data: string }[]) {
    for (const cls of (JSON.parse(row.data) as { classes?: { directoryId?: string }[] }).classes ?? []) if (cls.directoryId) linked.set(cls.directoryId, (linked.get(cls.directoryId) ?? 0) + 1);
  }
  const view = (id: string) => { const row = schoolId ? activeRow(db, schoolId, id) : undefined; return row ? { ...toClass(row), linked: linked.get(id) ?? 0 } : null; };
  return { entry: view(detail.entryId), aliases: detail.aliases, duplicates: detail.duplicateIds.map(view).filter(entry => entry !== null) };
}

/** Rewrites every school member's class links with `next`, saving only the schedules that change. Returns classes changed. */
function relink(db: Db, schoolId: string, next: (cls: { name: string; directoryId?: string }) => string | undefined): number {
  let changed = 0;
  for (const { id } of db.prepare('SELECT id FROM users WHERE school_id=?').all(schoolId) as { id: string }[]) {
    const current = readEntity(db, id, 'personal');
    if (!current || current.deleted) continue;
    const data = current.data as { classes?: { name: string; directoryId?: string }[] };
    let touched = false;
    const classes = (data.classes ?? []).map(cls => {
      const directoryId = next(cls);
      if (directoryId === cls.directoryId) return cls;
      touched = true; changed++;
      const { directoryId: _old, ...rest } = cls;
      return directoryId ? { ...rest, directoryId } : rest;
    });
    if (touched) writeEntity(db, id, { ...current, version: current.version + 1, data: { ...data, classes } });
  }
  return changed;
}
