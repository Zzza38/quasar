import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { classSchema, gradeSchema, gradesSchema, GRADES } from '@/domain/schedule';
import { directoryCandidates, similarClassName } from '@/domain/class-match';
import type { Service } from './service';

export const directoryDetailsSchema = classSchema.pick({ name: true, room: true, teacher: true }).extend({ grades: gradesSchema });
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
export type DirectoryClass = z.infer<typeof directoryDetailsSchema> & { id: string; version: number };

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
    return { accountId, canEdit, classes: rows.map(row => ({ ...directoryDetailsSchema.parse(JSON.parse(row.data)), id: row.id, version: row.version } satisfies DirectoryClass)) };
  }
  save(accountId: string, raw: z.infer<typeof directorySaveSchema>) {
    const input = directorySaveSchema.parse(raw);
    return this.service.db.transaction(() => {
      this.access(accountId, input.schoolId, true);
      const existing = input.id ? this.service.db.prepare('SELECT * FROM school_classes WHERE id=? AND school_id=? AND deleted=0').get(input.id, input.schoolId) as Row | undefined : undefined;
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'This directory class was removed. Reload the directory.' });
      if (existing && existing.version !== input.expectedVersion) throw new TRPCError({ code: 'CONFLICT', message: 'This directory class changed. Reload and review it before saving.' });
      if (!existing) {
        const count = this.service.db.prepare('SELECT count(*) n FROM school_classes WHERE school_id=? AND deleted=0').get(input.schoolId) as { n: number };
        if (count.n >= 1000) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The directory can contain up to 1,000 classes.' });
      }
      const id = existing?.id ?? randomUUID();
      const version = (existing?.version ?? 0) + 1;
      const now = new Date().toISOString();
      this.service.db.prepare(`INSERT INTO school_classes(id,school_id,data,version,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at`)
        .run(id, input.schoolId, JSON.stringify(input.details), version, now);
      this.audit(accountId, input.schoolId, existing ? 'directory.update' : 'directory.create', { id, version, details: input.details });
      return { ...input.details, id, version };
    }).immediate();
  }
  /** Reconcile reviewed scan rows in one transaction. Retries reuse entries; only confirmed spelling corrections edit them. */
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
              const updated = this.save(accountId, { schoolId: input.schoolId, id: entry.id, expectedVersion: entry.version, details: { name: row.name, teacher: entry.teacher, room: entry.room, grades: entry.grades } });
              entries[entries.indexOf(entry)] = updated;
              entry = updated;
            } else skipped++;
          }
        }
        if (!entry && directory.canEdit) {
          entry = this.save(accountId, { schoolId: input.schoolId, details: { name: row.name, teacher: row.teacher, room: row.room, grades: input.grade ? [input.grade] : [...GRADES] } });
          entries.push(entry);
        } else if (!entry) skipped++;
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
    this.service.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)')
      .run(actorId, action, schoolId, JSON.stringify(detail), new Date().toISOString());
  }
}
