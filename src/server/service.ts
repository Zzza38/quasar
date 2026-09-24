import { randomUUID, createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Db } from './db';
import { applyScheduleToGrades, gradeSchema, gradesSchema, scheduleSchema, personalScheduleSchema, emptyPersonalSchedule, type Schedule } from '@/domain/schedule';
import { nextRecurringTask, taskSchema } from '@/domain/task';
import { mergeMutation, type Entity, type Mutation, type SyncResult } from '@/domain/sync';
import { listSubscriptions, listImportConflicts } from './calendar';
import { CommunityService, emailDomainsSchema, parseEmailDomains } from './community';

export type User = { id: string; email: string; displayName: string; fullName: string; schoolId: string | null; suggestedNames: { displayName: string; fullName: string } };
export type School = { id: string; name: string; location: string; schedule: Schedule; version: number; approved: boolean; memberLocked: boolean; supportLocked: boolean; memberCount: number; emailDomains: string[] };
type UserRow = { id: string; email: string; display_name: string; full_name: string; school_id: string | null; reviewed_version: number | null; google_name: string | null };
type SchoolRow = { id: string; name: string; location: string; schedule: string; version: number; approved: number; member_locked: number; support_locked: number; member_count: number; email_domains: string };
const fail = (code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'TOO_MANY_REQUESTS', message: string): never => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();
export const namesSchema = z.object({ displayName: z.string().trim().min(1).max(80), fullName: z.string().trim().min(1).max(160) });
export const createSchoolSchema = z.object({ name: z.string().trim().min(2).max(160), location: z.string().trim().min(2).max(200), schedule: scheduleSchema });
export const schoolUpdateSchema = z.object({ schoolId: z.string().uuid(), expectedVersion: z.number().int().positive(), schedule: scheduleSchema, grades: gradesSchema.optional() });
export const adminUpdateSchema = schoolUpdateSchema.extend({ approved: z.boolean(), supportLocked: z.boolean(), emailDomains: emailDomainsSchema.optional() });
export const joinSchema = z.object({ schoolId: z.string().uuid(), choice: z.enum(['approved', 'community', 'personal']), personalSchedule: scheduleSchema.optional(), grade: gradeSchema.optional() });
const entitySchema = z.object({ id: z.string().min(1).max(100), kind: z.enum(['task', 'personal']), version: z.number().int().positive(), data: z.record(z.string(), z.unknown()), deleted: z.boolean() });
export const mutationSchema = z.object({ mutationId: z.string().uuid(), id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), kind: z.enum(['task', 'personal']), base: entitySchema.nullable(), data: z.record(z.string(), z.unknown()).nullable() });
/** Prefills the names step from the Google profile: first name as the display name, the whole name as the full name. */
export function suggestNames(googleName: string, email: string): { displayName: string; fullName: string } {
  const fullName = googleName.trim().replace(/\s+/g, ' ').slice(0, 160);
  const first = fullName.split(' ')[0] ?? '';
  const local = email.split('@')[0] ?? '';
  const fromEmail = local.split(/[._-]/)[0] ?? '';
  const displayName = (first || (fromEmail ? fromEmail[0].toUpperCase() + fromEmail.slice(1) : '')).slice(0, 80);
  return { displayName, fullName };
}
const RESERVED_WORDS = new Set(['quasar', 'support', 'admin', 'administrator', 'moderator', 'staff', 'official']);
/**
 * True when any whole word of the name is reserved, so nobody can pose as Quasar or support in chat.
 * Words are compared lowercased (NFKC, so full-width letters fold) and with punctuation inside the word
 * removed ("s.u.p.p.o.r.t"). Each punctuation-separated piece is checked too ("Quasar-Support").
 * "Stafford" and "Badminton" pass because only whole words count.
 */
export function reservedDisplayName(name: string): boolean {
  const words = name.normalize('NFKC').toLowerCase().replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').split(/\s+/).filter(Boolean);
  return words.some(word => {
    const pieces = [word.replace(/[^\p{L}\p{N}]/gu, ''), ...word.split(/[^\p{L}\p{N}]+/u)];
    return pieces.some(piece => RESERVED_WORDS.has(piece));
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class Service {
  constructor(readonly db: Db, readonly ownerEmail = process.env.OWNER_EMAIL || '') {}
  user(id: string | null): User {
    if (!id) return fail('UNAUTHORIZED', 'Sign in with Google to continue.');
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined;
    if (!row) return fail('UNAUTHORIZED', 'Sign in with Google to continue.');
    return { id: row.id, email: row.email, displayName: row.display_name, fullName: row.full_name, schoolId: row.school_id, suggestedNames: suggestNames(row.google_name ?? '', row.email) };
  }
  ready(id: string): User {
    const user = this.user(id);
    if (!user.displayName || !user.fullName) fail('BAD_REQUEST', 'Enter your display name and full name first.');
    return user;
  }
  isAdmin(id: string): boolean { return !!this.ownerEmail && this.user(id).email.toLowerCase() === this.ownerEmail.trim().toLowerCase(); }
  admin(id: string): void { if (!this.isAdmin(id)) fail('FORBIDDEN', 'Owner access is required.'); }
  profile(id: string, input: z.infer<typeof namesSchema>): User {
    const current = this.user(id);
    const names = namesSchema.parse(input);
    // Only a new or changed display name is checked, so an existing student can still save a new full name.
    if (names.displayName !== current.displayName && reservedDisplayName(names.displayName)) fail('BAD_REQUEST', 'Choose a display name that doesn’t mention Quasar or support.');
    this.db.prepare('UPDATE users SET display_name=?,full_name=? WHERE id=?').run(names.displayName, names.fullName, id);
    return this.user(id);
  }
  schools(query = '', limit = 100): School[] {
    const rows = this.db.prepare(`SELECT s.*, (SELECT count(*) FROM users u WHERE u.school_id=s.id) member_count
      FROM schools s WHERE instr(lower(s.name || ' ' || s.location), lower(?)) > 0 ORDER BY s.name LIMIT ?`).all(query, limit) as SchoolRow[];
    return rows.map(row => this.schoolFromRow(row));
  }
  private schoolFromRow(row: SchoolRow): School {
    return { id: row.id, name: row.name, location: row.location, schedule: JSON.parse(row.schedule), version: row.version,
      approved: !!row.approved, memberLocked: !!row.member_locked, supportLocked: !!row.support_locked, memberCount: row.member_count, emailDomains: parseEmailDomains(row.email_domains ?? '') };
  }
  school(id: string): School {
    const row = this.db.prepare(`SELECT s.*, (SELECT count(*) FROM users u WHERE u.school_id=s.id) member_count FROM schools s WHERE s.id=?`).get(id) as SchoolRow | undefined;
    if (!row) return fail('NOT_FOUND', 'School not found.');
    return this.schoolFromRow(row);
  }
  private audit(actorId: string, action: string, schoolId: string, detail: unknown) {
    this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)').run(actorId, action, schoolId, JSON.stringify(detail), now());
  }
  createSchool(id: string, raw: z.infer<typeof createSchoolSchema>): School {
    this.ready(id);
    const input = createSchoolSchema.parse(raw);
    return this.db.transaction(() => {
      const recent = this.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='school.create' AND created_at > ?").get(id, new Date(Date.now() - 86400000).toISOString()) as {n: number};
      if (recent.n >= 5) fail('TOO_MANY_REQUESTS', 'You can create up to five schools per day. Contact support for help.');
      const schoolId = randomUUID();
      this.db.prepare('INSERT INTO schools(id,name,location,schedule,created_at) VALUES(?,?,?,?,?)').run(schoolId, input.name, input.location, JSON.stringify(input.schedule), now());
      this.db.prepare('INSERT INTO school_revisions VALUES(?,?,?,?,?)').run(schoolId, 1, JSON.stringify(input.schedule), id, now());
      this.audit(id, 'school.create', schoolId, {});
      return this.school(schoolId);
    })();
  }
  join(id: string, raw: z.infer<typeof joinSchema>): void {
    this.ready(id);
    const input = joinSchema.parse(raw);
    this.db.transaction(() => {
      const school = this.school(input.schoolId);
      const community = new CommunityService(this);
      if (community.isBanned(id, school.id)) fail('FORBIDDEN', 'Support removed you from this school. Contact support if you think this is a mistake.');
      if (input.choice === 'approved' && !school.approved) fail('BAD_REQUEST', 'Choose the community schedule explicitly, or build your own.');
      if (input.choice === 'personal' && !input.personalSchedule) fail('BAD_REQUEST', 'Provide your personal schedule.');
      const existing = this.entity(id, 'personal');
      const data = personalScheduleSchema.parse(existing && !existing.deleted ? existing.data : emptyPersonalSchedule());
      // Joining is online and deliberately establishes the schedule source. Existing classes and overrides survive.
      const updated = personalScheduleSchema.parse({ ...data, ...(input.grade ? { grade: input.grade } : {}), customSchedule: input.choice === 'personal' ? input.personalSchedule : null });
      this.writeEntity(id, { id: 'personal', kind: 'personal', version: (existing?.version || 0) + 1, data: updated, deleted: false });
      this.db.prepare('UPDATE users SET school_id=?,reviewed_version=? WHERE id=?').run(school.id, school.version, id);
      this.db.prepare('UPDATE schools SET member_locked=1 WHERE id=? AND (SELECT count(*) FROM users WHERE school_id=?) >= 10').run(school.id, school.id);
      community.onJoin(id, school.id);
      this.audit(id, 'school.join', school.id, {choice: input.choice});
    })();
  }
  updateSchool(id: string, raw: z.infer<typeof schoolUpdateSchema> | z.infer<typeof adminUpdateSchema>, asAdmin = false): School {
    this.ready(id);
    if (asAdmin) this.admin(id);
    const input = asAdmin ? adminUpdateSchema.parse(raw) : schoolUpdateSchema.parse(raw);
    return this.db.transaction(() => {
      const school = this.school(input.schoolId);
      if (!asAdmin) {
        if (this.user(id).schoolId !== school.id) fail('FORBIDDEN', 'Only school members can edit this schedule.');
        if (school.memberLocked || school.supportLocked || school.memberCount >= 10) fail('FORBIDDEN', 'This schedule is locked. Send a correction to support.');
      }
      if (school.version !== input.expectedVersion) fail('CONFLICT', 'The school schedule changed. Reload and review it before saving.');
      const updatedSchedule = input.grades ? applyScheduleToGrades(school.schedule, input.schedule, input.grades) : input.schedule;
      const admin = asAdmin ? input as z.infer<typeof adminUpdateSchema> : null;
      this.db.prepare('UPDATE schools SET schedule=?,version=version+1,approved=?,support_locked=? WHERE id=?')
        .run(JSON.stringify(updatedSchedule), admin ? Number(admin.approved) : 0, admin ? Number(admin.supportLocked) : Number(school.supportLocked), school.id);
      this.db.prepare('INSERT INTO school_revisions VALUES(?,?,?,?,?)').run(school.id, school.version + 1, JSON.stringify(updatedSchedule), id, now());
      if (admin?.emailDomains) this.db.prepare('UPDATE schools SET email_domains=? WHERE id=?').run(admin.emailDomains.join(','), school.id);
      this.audit(id, asAdmin ? 'school.adminUpdate' : 'school.update', school.id, { fromVersion: school.version, approved: admin?.approved ?? false, supportLocked: admin?.supportLocked ?? school.supportLocked });
      return this.school(school.id);
    })();
  }
  acknowledge(id: string, version: number) {
    const user = this.ready(id);
    if (!user.schoolId) return fail('BAD_REQUEST', 'Join a school first.');
    const school = this.school(user.schoolId);
    if (school.version !== version) fail('CONFLICT', 'A newer school correction needs review.');
    this.db.prepare('UPDATE users SET reviewed_version=? WHERE id=?').run(version, id);
  }
  workspace(id: string) {
    const user = this.user(id);
    const school = user.schoolId ? this.school(user.schoolId) : null;
    const {reviewed_version: reviewed} = this.db.prepare('SELECT reviewed_version FROM users WHERE id=?').get(id) as UserRow;
    let review: {previous: Schedule; current: Schedule; version: number} | null = null;
    if (school && reviewed && reviewed !== school.version) {
      const old = this.db.prepare('SELECT schedule FROM school_revisions WHERE school_id=? AND version=?').get(school.id, reviewed) as {schedule: string} | undefined;
      if (old) review = {previous: JSON.parse(old.schedule), current: school.schedule, version: school.version};
    }
    const rows = this.db.prepare('SELECT * FROM entities WHERE owner_id=?').all(id) as EntityRow[];
    return { user, school, entities: rows.map(entityFromRow), review, isAdmin: this.isAdmin(id), subscriptions: listSubscriptions(this.db, id), importConflicts: listImportConflicts(this.db, id), community: new CommunityService(this).summary(id) };
  }
  entity(id: string, entityId: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE owner_id=? AND id=?').get(id, entityId) as EntityRow | undefined;
    return row ? entityFromRow(row) : null;
  }
  private writeEntity(owner: string, entity: Entity): void {
    this.db.prepare(`INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,?,?,?,?)
      ON CONFLICT(owner_id,id) DO UPDATE SET version=excluded.version,data=excluded.data,deleted=excluded.deleted`)
      .run(owner, entity.id, entity.kind, entity.version, JSON.stringify(entity.data), Number(entity.deleted));
    this.db.prepare('INSERT INTO entity_history VALUES(?,?,?,?)').run(owner, entity.id, entity.version, JSON.stringify(entity));
  }
  sync(id: string, raw: Mutation): SyncResult {
    this.ready(id);
    const input = mutationSchema.parse(raw) as Mutation;
    if (JSON.stringify(input).length > 1000000) fail('BAD_REQUEST', 'This change is too large.');
    if ((input.kind === 'personal') !== (input.id === 'personal')) fail('BAD_REQUEST', 'Invalid personal schedule ID.');
    if (input.kind === 'personal' && input.data === null) fail('BAD_REQUEST', 'Reset your personal schedule instead of deleting it.');
    if (input.base && (input.base.id !== input.id || input.base.kind !== input.kind)) fail('BAD_REQUEST', 'The change does not match its base.');
    const fingerprint = createHash('sha256').update(canonical(input)).digest('hex');
    return this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT * FROM mutation_receipts WHERE owner_id=? AND mutation_id=?').get(id, input.mutationId) as { fingerprint: string; result: string } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('BAD_REQUEST', 'A retry ID cannot be reused for a different change.');
        return JSON.parse(receipt.result) as SyncResult;
      }
      const current = this.entity(id, input.id);
      if (current && current.kind !== input.kind) fail('BAD_REQUEST', 'Entity kind cannot change.');
      if (input.base) {
        const history = this.db.prepare('SELECT entity FROM entity_history WHERE owner_id=? AND id=? AND version=?').get(id, input.id, input.base.version) as {entity: string} | undefined;
        if (!history || canonical(JSON.parse(history.entity)) !== canonical(input.base)) fail('BAD_REQUEST', 'The base revision is not recognized. Reload before retrying.');
      }
      if (input.data) this.validateData(input.kind, input.data);
      if (input.kind === 'task' && input.data && canonical(input.data.imported ?? null) !== canonical(input.base?.data.imported ?? null)) {
        fail('BAD_REQUEST', 'Calendar source metadata can only be changed by calendar synchronization.');
      }
      let result = mergeMutation(input, current);
      if (result.status === 'applied') {
        if (!result.entity.deleted) {
          const parsed = (input.kind === 'task' ? taskSchema : personalScheduleSchema).safeParse(result.entity.data);
          if (parsed.success) result.entity.data = parsed.data;
          else result = { status: 'conflict', current, paths: parsed.error.issues.map(issue => '/' + issue.path.join('/')) };
        }
        // A no-op merge may return the current revision.
        if (result.status === 'applied' && (!current || result.entity.version > current.version)) {
          this.writeEntity(id, result.entity);
          if (input.kind === 'task' && current && !current.deleted && !current.data.completed && !result.entity.deleted && result.entity.data.completed) {
            const next = nextRecurringTask(taskSchema.parse(result.entity.data));
            const existing = this.db.prepare('SELECT successor_id FROM recurring_successors WHERE owner_id=? AND parent_id=?').get(id, input.id);
            if (next && !existing) {
              const successorId = 'repeat_' + createHash('sha256').update(JSON.stringify([id, input.id, next.dueDate])).digest('hex');
              if (this.entity(id, successorId)) fail('CONFLICT', 'The next repeating task ID is already in use.');
              this.writeEntity(id, { id: successorId, kind: 'task', version: 1, data: next, deleted: false });
              this.db.prepare('INSERT INTO recurring_successors(owner_id,parent_id,successor_id) VALUES(?,?,?)').run(id, input.id, successorId);
            }
          }
        }
      }
      this.db.prepare('INSERT INTO mutation_receipts VALUES(?,?,?,?,?)').run(id, input.mutationId, fingerprint, JSON.stringify(result), now());
      return result;
    })();
  }
  private validateData(kind: 'task' | 'personal', data: Record<string, unknown>): Record<string, unknown> {
    const parsed = (kind === 'task' ? taskSchema : personalScheduleSchema).safeParse(data);
    if (!parsed.success) fail('BAD_REQUEST', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    return parsed.data!;
  }
  requestCorrection(id: string, message: string) {
    const user = this.ready(id);
    if (!user.schoolId) return fail('BAD_REQUEST', 'Join a school first.');
    return this.sendSupportRequest(id, user.schoolId, message);
  }
  /** Feedback from any signed-in student, including ones still in setup. Lands in the same support inbox. */
  feedback(id: string, message: string) {
    const user = this.user(id);
    return this.sendSupportRequest(id, user.schoolId, message);
  }
  private sendSupportRequest(id: string, schoolId: string | null, message: string) {
    const text = z.string().trim().min(10).max(5000).parse(message);
    const count = this.db.prepare('SELECT count(*) n FROM support_requests WHERE user_id=? AND resolved_at IS NULL').get(id) as {n: number};
    if (count.n >= 5) fail('TOO_MANY_REQUESTS', 'You already have five open requests. Wait for support to review them.');
    this.db.prepare('INSERT INTO support_requests(id,school_id,user_id,message,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), schoolId, id, text, now());
  }
  requests(id: string) {
    this.admin(id);
    return this.db.prepare(`SELECT r.id,r.school_id schoolId,r.message,r.created_at createdAt,s.name schoolName,u.email email
      FROM support_requests r LEFT JOIN schools s ON s.id=r.school_id JOIN users u ON u.id=r.user_id WHERE resolved_at IS NULL ORDER BY r.created_at`).all() as {id: string; schoolId: string | null; message: string; createdAt: string; schoolName: string | null; email: string}[];
  }
  resolveRequest(id: string, requestId: string) {
    this.admin(id);
    this.db.prepare('UPDATE support_requests SET resolved_at=? WHERE id=?').run(now(), requestId);
  }
}
type EntityRow = { id: string; kind: Entity['kind']; version: number; data: string; deleted: number };
function entityFromRow(row: EntityRow): Entity { return { id: row.id, kind: row.kind, version: row.version, data: JSON.parse(row.data), deleted: !!row.deleted }; }
