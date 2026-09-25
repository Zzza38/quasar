import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { classSchema, gradesSchema } from '@/domain/schedule';
import type { Service } from './service';

export const directoryDetailsSchema = classSchema.pick({ name: true, room: true, teacher: true }).extend({ grades: gradesSchema });
export const directorySaveSchema = z.object({ schoolId: z.uuid(), id: z.uuid().optional(), expectedVersion: z.number().int().positive().optional(), details: directoryDetailsSchema });
export const directoryRemoveSchema = z.object({ schoolId: z.uuid(), id: z.uuid(), expectedVersion: z.number().int().positive() });
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
