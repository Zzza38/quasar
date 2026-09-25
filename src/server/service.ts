import { randomUUID, createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Db } from './db';
import { applyScheduleToGrades, gradeSchema, gradesSchema, scheduleSchema, personalScheduleSchema, emptyPersonalSchedule, type Schedule } from '@/domain/schedule';
import { completionTime, nextRecurringTask, stampCompletion, taskSchema, withoutCompletionEdit } from '@/domain/task';
import { mergeMutation, type Entity, type Mutation, type SyncResult } from '@/domain/sync';
import { CalendarService, listSubscriptions, listImportConflicts } from './calendar';
import { CommunityService, emailDomainsSchema, parseEmailDomains } from './community';
import { foldConfusables } from '@/domain/chat-filter';
import { avatarUrl, usableGooglePicture } from './avatars';
export { avatarUrl, usableGooglePicture, AVATAR_COLUMNS, type AvatarRow } from './avatars';

/** `avatar` is the picture URL other members see (docs/CHAT.md §13): an uploaded picture, else the Google picture, else null for initials. */
export type User = { id: string; email: string; displayName: string; fullName: string; schoolId: string | null; suggestedNames: { displayName: string; fullName: string }; avatar: string | null;
  /** Which picture the account shows, for the account sheet's picture controls. */
  avatarSource: 'upload' | 'google' | 'none'; hasGooglePicture: boolean };
/** A support sanction the student can see and appeal (§14). */
export type Ban = { schoolId: string; schoolName: string; reason: string; createdAt: string; appealed: boolean };
export type Sanctions = { bans: Ban[]; pause: { until: string | null; reason: string; appealed: boolean } | null };
export type School = { id: string; name: string; location: string; schedule: Schedule; version: number; approved: boolean; memberLocked: boolean; supportLocked: boolean; memberCount: number; emailDomains: string[] };
/** What a school search returns: enough to pick a school, without its schedule (fetch that with `school(id)`). */
export type SchoolSummary = Omit<School, 'schedule' | 'emailDomains'>;
type UserRow = { id: string; email: string; display_name: string; full_name: string; school_id: string | null; reviewed_version: number | null; google_name: string | null;
  google_picture: string | null; avatar_version: number | null; avatar_hidden: number | null; avatar_mime: string | null };
/** Uploaded pictures are small: the client resizes to 256 px and encodes as JPEG or WebP before sending (§13). */
export const AVATAR_MAX_BYTES = 200_000;
export const AVATAR_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const avatarUploadSchema = z.object({ mime: z.enum(AVATAR_MIMES), data: z.string().max(Math.ceil(AVATAR_MAX_BYTES * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Choose an image file.') });
export const appealSchema = z.object({ kind: z.enum(['pause', 'ban']), schoolId: z.uuid().optional(), message: z.string().trim().min(10).max(2000) });
type SchoolRow = { id: string; name: string; location: string; schedule: string; version: number; approved: number; member_locked: number; support_locked: number; member_count: number; email_domains: string };
const fail = (code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'TOO_MANY_REQUESTS', message: string): never => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();
/** A school schedule is shared with every member and every searcher, so its stored size is capped (sync caps personal data at 1 MB). */
export const MAX_SCHOOL_SCHEDULE_CHARS = 256_000;
/**
 * Per-account sync quotas, so one account cannot fill the shared disk. History and receipts are kept on purpose
 * (docs/ARCHITECTURE.md, "Operational limits"), so the limits bound what an account can add instead.
 */
export const SYNC_LIMITS = { liveTasks: 5000, dailyMutations: 5000, dailyBytes: 100_000_000 } as const;
/**
 * How the server shapes what it sends a client. Bundles built before `completedAt` existed parse tasks strictly and
 * do not send TASK_CLIENT_VERSION (a tab left open across a deploy, or one started offline from the cached shell),
 * so the router sets `legacyTasks` for them and their workspace and sync replies leave that field out.
 */
export type ClientOptions = { legacyTasks?: boolean };
function forClient(entity: Entity, { legacyTasks = false }: ClientOptions): Entity {
  if (!legacyTasks || entity.kind !== 'task' || !('completedAt' in entity.data)) return entity;
  const { completedAt: _completedAt, ...data } = entity.data;
  return { ...entity, data };
}
function resultForClient(result: SyncResult, options: ClientOptions): SyncResult {
  if (result.status === 'applied') return { ...result, entity: forClient(result.entity, options) };
  return { ...result, current: result.current && forClient(result.current, options) };
}
export function checkSchoolScheduleSize(schedule: unknown): void {
  if (JSON.stringify(schedule).length > MAX_SCHOOL_SCHEDULE_CHARS) fail('BAD_REQUEST', 'This schedule is too large. Remove unused days, exceptions or grade variations, or contact support.');
}
// Control and format characters (bidi overrides, zero-width spaces, soft hyphens) are removed from names, so a
// name cannot read backwards or render blank. They go before spaces are collapsed, so "Maya<ZWSP> Chen" keeps one
// space, and a tab or line break still separates words. Some are part of real names and emoji, and are kept there:
// a zero-width joiner or non-joiner after a letter of a script that needs them (Persian, Urdu, Hindi, Malayalam;
// not Latin, where it would only hide a lookalike), a joiner inside an emoji sequence (skin tones included), and
// the tag characters of a subdivision flag.
const NAME_INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
function keptInvisible(char: string, before: string, after: string): string {
  if (char !== '\uFEFF' && /\s/u.test(char)) return ' ';
  if ((char === '\u200C' || char === '\u200D') && /(?!\p{Script=Latin})\p{L}\p{M}*$/u.test(before)) return char;
  if (char === '\u200D' && /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*$/u.test(before) && /^\p{Extended_Pictographic}/u.test(after)) return char;
  if (/^[\u{E0020}-\u{E007F}]$/u.test(char) && /\u{1F3F4}[\u{E0020}-\u{E007E}]*$/u.test(before)) return char;
  return '';
}
/** Only a short stretch around each character is examined, so a long run of them costs linear time. */
function cleanName(raw: string): string {
  return raw.replace(NAME_INVISIBLE, (char, at: number, whole: string) => keptInvisible(char, whole.slice(Math.max(0, at - 32), at), whole.slice(at + char.length, at + char.length + 2)))
    .replace(/\s+/gu, ' ').trim();
}
// The raw string is bounded before cleaning: the cleaner walks every control or format character, so a multi-megabyte
// run of them would otherwise cost seconds of CPU on the one event loop. Eight times the limit still lets a name
// padded with invisible characters clean down to a valid one.
const nameSchema = (max: number) => z.string().max(max * 8).transform(cleanName).pipe(z.string().min(1).max(max)
  .regex(/[\p{L}\p{N}]/u, 'Names need at least one letter or number.'));
export const namesSchema = z.object({ displayName: nameSchema(80), fullName: nameSchema(160) });
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
/** True when the whole piece splits exactly into reserved words ("quasarsupport"), so "stafford" still passes. */
function onlyReservedWords(piece: string): boolean {
  const ends = [true];
  for (let end = 1; end <= piece.length; end += 1) {
    ends[end] = [...RESERVED_WORDS].some(word => word.length <= end && ends[end - word.length] && piece.startsWith(word, end - word.length));
  }
  return piece.length > 0 && !!ends[piece.length];
}
/**
 * True when any whole word of the name is reserved, so nobody can pose as Quasar or support in chat.
 * Words are folded first (NFKD, lowercase, invisible characters and accents removed, Cyrillic and Greek
 * lookalikes mapped to Latin, and, in a second pass, digits standing in for letters: "Ѕuррort", "Supp0rt"),
 * and punctuation inside the word is removed ("s.u.p.p.o.r.t"). Each punctuation-separated piece is checked too
 * ("Quasar-Support"), as are spaced-out letters ("S u p p o r t"), words made only of reserved words
 * ("QuasarSupport"), and reserved words with digits stuck to either end ("Support2", "Staff99"), which are read
 * both as digits and, in the second pass, as letters. "Stafford" and "Badminton" pass because only whole words count.
 */
export function reservedDisplayName(name: string): boolean {
  const spaced = name.replace(/\s+/gu, ' ');
  // Digits at the start or end of each run of letters and digits removed: "Supp0rt2" is read as "Supp0rt".
  const trimmed = spaced.replace(/(?<![\p{L}\p{N}])\p{N}+|\p{N}+(?![\p{L}\p{N}])/gu, '');
  return [spaced, trimmed].flatMap(text => [foldConfusables(text), foldConfusables(text, { leet: true })]).some(folded => {
    const words = folded.split(' ').filter(Boolean);
    const pieces: string[] = [];
    let letters = '';
    for (const word of words) {
      const joined = word.replace(/[^\p{L}\p{N}]/gu, '');
      pieces.push(joined, ...word.split(/[^\p{L}\p{N}]+/u));
      // Runs of single letters are read together.
      if (joined.length === 1) letters += joined;
      else { pieces.push(letters); letters = ''; }
    }
    pieces.push(letters);
    return pieces.some(onlyReservedWords);
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Where a request came from, recorded on the owner's audit rows (Service.audit). */
export type RequestInfo = { ip: string | null; userAgent: string | null };

export class Service {
  /** Set per request by the tRPC route; absent in the worker and in tests. */
  request: RequestInfo | null = null;
  /**
   * The owner is the account whose Google email is OWNER_EMAIL and, when OWNER_GOOGLE_SUB is set, whose Google
   * account ID (the `sub` claim, users.google_sub) is that value too. The ID never changes or gets reissued, so it
   * pins the owner even if the email address is ever given to a different Google account.
   */
  constructor(readonly db: Db, readonly ownerEmail = process.env.OWNER_EMAIL || '', readonly ownerSub = process.env.OWNER_GOOGLE_SUB || '') {}
  user(id: string | null): User {
    if (!id) return fail('UNAUTHORIZED', 'Sign in with Google to continue.');
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined;
    if (!row) return fail('UNAUTHORIZED', 'Sign in with Google to continue.');
    return { id: row.id, email: row.email, displayName: row.display_name, fullName: row.full_name, schoolId: row.school_id, suggestedNames: suggestNames(row.google_name ?? '', row.email),
      avatar: avatarUrl(row), avatarSource: row.avatar_hidden ? 'none' : row.avatar_version ? 'upload' : usableGooglePicture(row.google_picture) ? 'google' : 'none', hasGooglePicture: usableGooglePicture(row.google_picture) };
  }
  /* ---------- Profile pictures (docs/CHAT.md §13) ---------- */

  /** Stores an uploaded picture (already resized by the client) and shows it instead of the Google one. */
  setAvatar(id: string, raw: z.infer<typeof avatarUploadSchema>): User {
    this.user(id);
    const input = avatarUploadSchema.parse(raw);
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length) fail('BAD_REQUEST', 'Choose an image file.');
    if (bytes.length > AVATAR_MAX_BYTES) fail('BAD_REQUEST', 'That picture is too large. Choose a smaller one.');
    if (!imageBytesMatch(bytes, input.mime)) fail('BAD_REQUEST', 'Choose an image file.');
    this.db.prepare('UPDATE users SET avatar=?, avatar_mime=?, avatar_version=avatar_version+1, avatar_hidden=0 WHERE id=?').run(bytes, input.mime, id);
    return this.user(id);
  }
  /** Drops the uploaded picture; `source` says what shows instead: the Google picture, or initials. */
  clearAvatar(id: string, source: 'google' | 'none'): User {
    this.user(id);
    this.db.prepare('UPDATE users SET avatar=NULL, avatar_mime=\'\', avatar_version=0, avatar_hidden=? WHERE id=?').run(source === 'none' ? 1 : 0, id);
    return this.user(id);
  }
  /** The uploaded picture's bytes for /api/avatars/<id>, or null when the member shows no uploaded picture. */
  avatarImage(id: string): { bytes: Buffer; mime: string; version: number } | null {
    const row = this.db.prepare('SELECT avatar, avatar_mime, avatar_version, avatar_hidden FROM users WHERE id=?').get(id) as { avatar: Buffer | null; avatar_mime: string; avatar_version: number; avatar_hidden: number } | undefined;
    if (!row || !row.avatar || row.avatar_hidden || !row.avatar_version) return null;
    return { bytes: row.avatar, mime: row.avatar_mime || 'image/jpeg', version: row.avatar_version };
  }

  /* ---------- Sanctions the student can see and appeal (docs/CHAT.md §14) ---------- */

  sanctions(id: string): Sanctions {
    // A removal's appeal belongs to that school; a pause is account-wide, so its appeal is found whatever school it names.
    const openBanAppeal = this.db.prepare("SELECT 1 FROM support_requests WHERE user_id=? AND kind='appeal:ban' AND school_id=? AND resolved_at IS NULL");
    const openPauseAppeal = this.db.prepare("SELECT 1 FROM support_requests WHERE user_id=? AND kind='appeal:pause' AND resolved_at IS NULL");
    const bans = (this.db.prepare(`SELECT b.school_id schoolId, s.name schoolName, b.reason, b.created_at createdAt FROM school_bans b JOIN schools s ON s.id=b.school_id WHERE b.user_id=? ORDER BY b.created_at DESC`).all(id) as Omit<Ban, 'appealed'>[])
      .map(ban => ({ ...ban, appealed: !!openBanAppeal.get(id, ban.schoolId) }));
    const pause = this.db.prepare('SELECT until, reason FROM chat_pauses WHERE user_id=? AND (until IS NULL OR until>?)').get(id, now()) as { until: string | null; reason: string } | undefined;
    return { bans, pause: pause ? { until: pause.until, reason: pause.reason, appealed: !!openPauseAppeal.get(id) } : null };
  }
  /**
   * An appeal against a messaging pause or a removal from a school. It lands in the owner's support inbox as a request
   * of kind 'appeal:pause' or 'appeal:ban' (with the school), one open appeal per sanction; the owner answers with
   * Lift pause or Lift removal on /admin.
   */
  appeal(id: string, raw: z.infer<typeof appealSchema>): void {
    const user = this.user(id);
    const input = appealSchema.parse(raw);
    const sanctions = this.sanctions(id);
    let schoolId: string | null = null;
    if (input.kind === 'pause') {
      if (!sanctions.pause) return fail('BAD_REQUEST', 'Your messaging is not paused.');
      if (sanctions.pause.appealed) fail('CONFLICT', 'You already sent an appeal. Support will review it.');
      schoolId = user.schoolId;
    } else {
      const ban = sanctions.bans.find(entry => entry.schoolId === input.schoolId);
      if (!ban) return fail('BAD_REQUEST', 'You were not removed from that school.');
      if (ban.appealed) fail('CONFLICT', 'You already sent an appeal. Support will review it.');
      schoolId = ban.schoolId;
    }
    const open = this.db.prepare('SELECT count(*) n FROM support_requests WHERE user_id=? AND resolved_at IS NULL').get(id) as {n: number};
    if (open.n >= 5) fail('TOO_MANY_REQUESTS', 'You already have five open requests. Wait for support to review them.');
    this.db.prepare('INSERT INTO support_requests(id,school_id,user_id,message,created_at,kind) VALUES(?,?,?,?,?,?)').run(randomUUID(), schoolId, id, input.message, now(), `appeal:${input.kind}`);
  }
  /** Owner: lifts a removal so the student can join that school again. Audited. */
  liftBan(adminId: string, userId: string, schoolId: string): void {
    this.admin(adminId);
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM school_bans WHERE user_id=? AND school_id=?').get(userId, schoolId)) fail('NOT_FOUND', 'This student is not removed from that school.');
      this.db.prepare('DELETE FROM school_bans WHERE user_id=? AND school_id=?').run(userId, schoolId);
      this.db.prepare("UPDATE support_requests SET resolved_at=? WHERE user_id=? AND school_id=? AND kind='appeal:ban' AND resolved_at IS NULL").run(now(), userId, schoolId);
      this.audit(adminId, 'member.restore', schoolId, { userId });
    }).immediate();
  }
  /** Owner: every current removal, for the "Removed members" section. */
  bans(adminId: string): { userId: string; displayName: string; email: string; schoolId: string; schoolName: string; reason: string; createdAt: string; appealed: boolean }[] {
    this.admin(adminId);
    return this.db.prepare(`SELECT b.user_id userId, u.display_name displayName, u.email, b.school_id schoolId, s.name schoolName, b.reason, b.created_at createdAt,
        EXISTS (SELECT 1 FROM support_requests r WHERE r.user_id=b.user_id AND r.school_id=b.school_id AND r.kind='appeal:ban' AND r.resolved_at IS NULL) appealed
      FROM school_bans b JOIN users u ON u.id=b.user_id JOIN schools s ON s.id=b.school_id ORDER BY b.created_at DESC`).all().map((row) => {
      const entry = row as { userId: string; displayName: string; email: string; schoolId: string; schoolName: string; reason: string; createdAt: string; appealed: number };
      return { ...entry, appealed: !!entry.appealed };
    });
  }
  ready(id: string): User {
    const user = this.user(id);
    if (!user.displayName || !user.fullName) fail('BAD_REQUEST', 'Enter your display name and full name first.');
    return user;
  }
  isAdmin(id: string): boolean {
    if (!this.ownerEmail || this.user(id).email.toLowerCase() !== this.ownerEmail.trim().toLowerCase()) return false;
    if (!this.ownerSub.trim()) return true;
    const row = this.db.prepare('SELECT google_sub FROM users WHERE id=?').get(id) as { google_sub: string };
    return row.google_sub === this.ownerSub.trim();
  }
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
  /** School search for onboarding. Only summaries: the chosen school's schedule is fetched separately. */
  schoolSummaries(query = '', limit = 100): SchoolSummary[] {
    const rows = this.db.prepare(`SELECT s.id, s.name, s.location, s.version, s.approved, s.member_locked, s.support_locked,
        (SELECT count(*) FROM users u WHERE u.school_id=s.id) member_count
      FROM schools s WHERE instr(lower(s.name || ' ' || s.location), lower(?)) > 0 ORDER BY s.name LIMIT ?`).all(query, limit) as Omit<SchoolRow, 'schedule' | 'email_domains'>[];
    return rows.map(row => ({ id: row.id, name: row.name, location: row.location, version: row.version,
      approved: !!row.approved, memberLocked: !!row.member_locked, supportLocked: !!row.support_locked, memberCount: row.member_count }));
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
  /**
   * Appends to audit_log (append-only: see migration 16 in src/server/db.ts). Rows written by the owner also keep
   * the request's address and browser, and a copy goes to the server log (journald), which the database cannot rewrite.
   */
  audit(actorId: string, action: string, schoolId: string | null, detail: unknown, createdAt = now()): void {
    const owner = this.request !== null && this.isAdmin(actorId);
    const ip = owner ? this.request!.ip : null, userAgent = owner ? this.request!.userAgent : null;
    this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at,ip,user_agent) VALUES(?,?,?,?,?,?,?)').run(actorId, action, schoolId, JSON.stringify(detail), createdAt, ip, userAgent);
    if (owner) console.info(`audit ${JSON.stringify({ actorId, action, schoolId, detail, createdAt, ip, userAgent })}`);
  }
  createSchool(id: string, raw: z.infer<typeof createSchoolSchema>): School {
    this.ready(id);
    const input = createSchoolSchema.parse(raw);
    checkSchoolScheduleSize(input.schedule);
    return this.db.transaction(() => {
      const recent = this.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='school.create' AND created_at > ?").get(id, new Date(Date.now() - 86400000).toISOString()) as {n: number};
      if (recent.n >= 5) fail('TOO_MANY_REQUESTS', 'You can create up to five schools per day. Contact support for help.');
      const schoolId = randomUUID();
      this.db.prepare('INSERT INTO schools(id,name,location,schedule,created_at) VALUES(?,?,?,?,?)').run(schoolId, input.name, input.location, JSON.stringify(input.schedule), now());
      this.db.prepare('INSERT INTO school_revisions VALUES(?,?,?,?,?)').run(schoolId, 1, JSON.stringify(input.schedule), id, now());
      this.audit(id, 'school.create', schoolId, {});
      return this.school(schoolId);
    }).immediate();
  }
  join(id: string, raw: z.infer<typeof joinSchema>): void {
    this.ready(id);
    const input = joinSchema.parse(raw);
    this.db.transaction(() => {
      const school = this.school(input.schoolId);
      const community = new CommunityService(this);
      if (community.isBanned(id, school.id)) fail('FORBIDDEN', 'Support removed you from this school. You can read the reason and appeal on the school step.');
      if (input.choice === 'approved' && !school.approved) fail('BAD_REQUEST', 'Choose the community schedule explicitly, or build your own.');
      if (input.choice === 'personal' && !input.personalSchedule) fail('BAD_REQUEST', 'Provide your personal schedule.');
      const existing = this.entity(id, 'personal');
      const data = personalScheduleSchema.parse(existing && !existing.deleted ? existing.data : emptyPersonalSchedule());
      // Joining is online and deliberately establishes the schedule source. Existing classes and overrides survive.
      const updated = personalScheduleSchema.parse({ ...data, ...(input.grade ? { grade: input.grade } : {}), customSchedule: input.choice === 'personal' ? input.personalSchedule : null });
      this.writeEntity(id, { id: 'personal', kind: 'personal', version: (existing?.version || 0) + 1, data: updated, deleted: false });
      // Switching schools ends membership of the old one, so an open proposal there is withdrawn.
      const previousSchool = this.user(id).schoolId;
      if (previousSchool && previousSchool !== school.id) community.withdrawProposals(id, previousSchool);
      this.db.prepare('UPDATE users SET school_id=?,reviewed_version=? WHERE id=?').run(school.id, school.version, id);
      this.db.prepare('UPDATE schools SET member_locked=1 WHERE id=? AND (SELECT count(*) FROM users WHERE school_id=?) >= 10').run(school.id, school.id);
      community.onJoin(id, school.id);
      this.audit(id, 'school.join', school.id, {choice: input.choice});
    }).immediate();
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
      checkSchoolScheduleSize(updatedSchedule);
      const admin = asAdmin ? input as z.infer<typeof adminUpdateSchema> : null;
      this.db.prepare('UPDATE schools SET schedule=?,version=version+1,approved=?,support_locked=? WHERE id=?')
        .run(JSON.stringify(updatedSchedule), admin ? Number(admin.approved) : 0, admin ? Number(admin.supportLocked) : Number(school.supportLocked), school.id);
      this.db.prepare('INSERT INTO school_revisions VALUES(?,?,?,?,?)').run(school.id, school.version + 1, JSON.stringify(updatedSchedule), id, now());
      // A member who was up to date has just seen this revision, so they are not asked to review their own edit.
      if (!asAdmin) this.db.prepare('UPDATE users SET reviewed_version=? WHERE id=? AND reviewed_version=?').run(school.version + 1, id, school.version);
      // Proposals built on the old revision can no longer apply, including ones awaiting support.
      this.db.prepare("UPDATE schedule_proposals SET status='superseded', closed_at=? WHERE school_id=? AND status IN ('open','awaiting-support') AND base_version<>?").run(now(), school.id, school.version + 1);
      if (admin?.emailDomains) this.db.prepare('UPDATE schools SET email_domains=? WHERE id=?').run(admin.emailDomains.join(','), school.id);
      this.audit(id, asAdmin ? 'school.adminUpdate' : 'school.update', school.id, { fromVersion: school.version, approved: admin?.approved ?? false, supportLocked: admin?.supportLocked ?? school.supportLocked,
        // Domains grant verification, so a change to them is recorded like the approval and lock.
        ...(admin?.emailDomains && admin.emailDomains.join(',') !== school.emailDomains.join(',') ? { fromDomains: school.emailDomains, toDomains: admin.emailDomains } : {}) });
      return this.school(school.id);
    }).immediate();
  }
  acknowledge(id: string, version: number) {
    const user = this.ready(id);
    if (!user.schoolId) return fail('BAD_REQUEST', 'Join a school first.');
    const school = this.school(user.schoolId);
    if (school.version !== version) fail('CONFLICT', 'A newer school correction needs review.');
    this.db.prepare('UPDATE users SET reviewed_version=? WHERE id=?').run(version, id);
  }
  workspace(id: string, options: ClientOptions = {}) {
    const user = this.user(id);
    const school = user.schoolId ? this.school(user.schoolId) : null;
    const {reviewed_version: reviewed} = this.db.prepare('SELECT reviewed_version FROM users WHERE id=?').get(id) as UserRow;
    let review: {previous: Schedule; current: Schedule; version: number} | null = null;
    if (school && reviewed && reviewed !== school.version) {
      const old = this.db.prepare('SELECT schedule FROM school_revisions WHERE school_id=? AND version=?').get(school.id, reviewed) as {schedule: string} | undefined;
      if (old) review = {previous: JSON.parse(old.schedule), current: school.schedule, version: school.version};
    }
    const rows = this.db.prepare('SELECT * FROM entities WHERE owner_id=?').all(id) as EntityRow[];
    // Calendar rows saved before keyed hashes are rekeyed here, by the web bundle that also reads them (see rekeyOnLoad).
    new CalendarService(this.db).rekeyOnLoad(id);
    return { user, school, entities: rows.map(row => forClient(entityFromRow(row), options)), review, isAdmin: this.isAdmin(id), subscriptions: listSubscriptions(this.db, id), importConflicts: listImportConflicts(this.db, id), community: new CommunityService(this).summary(id), sanctions: this.sanctions(id) };
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
  sync(id: string, raw: Mutation, options: ClientOptions = {}): SyncResult {
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
        return resultForClient(JSON.parse(receipt.result) as SyncResult, options);
      }
      const current = this.entity(id, input.id);
      if (current && current.kind !== input.kind) fail('BAD_REQUEST', 'Entity kind cannot change.');
      this.checkSyncQuota(id, input, current);
      if (input.base) {
        const history = this.db.prepare('SELECT entity FROM entity_history WHERE owner_id=? AND id=? AND version=?').get(id, input.id, input.base.version) as {entity: string} | undefined;
        const recorded = history ? JSON.parse(history.entity) as Entity : null;
        // An older client was sent this revision without completedAt, and it shares the device store with newer tabs,
        // so a base without it is accepted from any client. The merge then uses the recorded revision, so the stored
        // stamp is kept rather than read as the client removing it.
        if (!recorded || (canonical(recorded) !== canonical(input.base) && canonical(forClient(recorded, { legacyTasks: true })) !== canonical(input.base))) fail('BAD_REQUEST', 'The base revision is not recognized. Reload before retrying.');
        input.base = recorded;
      }
      if (input.data) this.validateData(input.kind, input.data);
      if (input.kind === 'task' && input.data && canonical(input.data.imported ?? null) !== canonical(input.base?.data.imported ?? null)) {
        fail('BAD_REQUEST', 'Calendar source metadata can only be changed by calendar synchronization.');
      }
      // completedAt is server-owned: a client's value (an optimistic stamp) never counts as an edit, so two devices
      // completing the same task never conflict over it, and the stored time is stamped below from the transition.
      const completedAt = completionTime(input.data?.completedAt, new Date());
      if (input.kind === 'task' && input.data) input.data = withoutCompletionEdit(input.data, input.base);
      let result = mergeMutation(input, current);
      if (result.status === 'applied') {
        if (input.kind === 'task' && !result.entity.deleted) result.entity.data = stampCompletion(result.entity.data, current && !current.deleted ? current.data : null, completedAt);
        if (!result.entity.deleted) {
          const parsed = (input.kind === 'task' ? taskSchema : personalScheduleSchema).safeParse(result.entity.data);
          if (parsed.success) result.entity.data = parsed.data;
          else result = { status: 'conflict', current, paths: parsed.error.issues.map(issue => '/' + issue.path.join('/')) };
        }
        // mergeMutation always returns the next revision, even when the merged data is unchanged (two identical edits),
        // so every applied change is written and recorded in history.
        if (result.status === 'applied') {
          this.writeEntity(id, result.entity);
          if (input.kind === 'task' && current && !current.deleted && !current.data.completed && !result.entity.deleted && result.entity.data.completed) this.addSuccessor(id, input.id, result.entity.data);
        }
      }
      // The receipt keeps the full result; a replay is shaped for whichever client asks.
      this.db.prepare('INSERT INTO mutation_receipts VALUES(?,?,?,?,?)').run(id, input.mutationId, fingerprint, JSON.stringify(result), now());
      return resultForClient(result, options);
    }).immediate();
  }
  /**
   * The next task of a repeating series, once its current task is checked off (by a sync, or by support in the user
   * console). Runs in the caller's transaction; a series only ever gets one successor per task.
   */
  addSuccessor(owner: string, taskId: string, completed: Record<string, unknown>): void {
    // A successor the schema rejects (its date steps past 2199) would be stored but hidden everywhere, so the series ends instead.
    const next = taskSchema.safeParse(nextRecurringTask(taskSchema.parse(completed)));
    const existing = this.db.prepare('SELECT successor_id FROM recurring_successors WHERE owner_id=? AND parent_id=?').get(owner, taskId);
    if (!next.success || existing) return;
    const successorId = 'repeat_' + createHash('sha256').update(JSON.stringify([owner, taskId, next.data.dueDate])).digest('hex');
    if (this.entity(owner, successorId)) fail('CONFLICT', 'The next repeating task ID is already in use.');
    this.writeEntity(owner, { id: successorId, kind: 'task', version: 1, data: next.data, deleted: false });
    this.db.prepare('INSERT INTO recurring_successors(owner_id,parent_id,successor_id) VALUES(?,?,?)').run(owner, taskId, successorId);
  }
  /** Replays of an existing receipt never reach this, so retries of applied changes always succeed. */
  private checkSyncQuota(id: string, input: Mutation, current: Entity | null): void {
    const since = new Date(Date.now() - 86400000).toISOString();
    // octet_length reads each receipt's size from its record header; length() would read the whole text (up to 1 MB
    // each) on every sync while the write lock is held.
    const recent = this.db.prepare('SELECT count(*) n, coalesce(sum(octet_length(result)),0) bytes FROM mutation_receipts WHERE owner_id=? AND created_at > ?').get(id, since) as { n: number; bytes: number };
    if (recent.n >= SYNC_LIMITS.dailyMutations || recent.bytes + Buffer.byteLength(JSON.stringify(input.data)) > SYNC_LIMITS.dailyBytes) {
      fail('TOO_MANY_REQUESTS', 'You’ve made a lot of changes today. They’re saved on this device and will sync later.');
    }
    // Only a new (or restored) task adds to the count, so edits and deletions still go through at the limit.
    // Calendar imports do not count: the feed limits bound them, they are never deleted automatically, and a busy
    // feed must not lock the student out of adding their own tasks. Every import has an `ical_` ID and server-owned
    // `imported` metadata that a client cannot set, so the ID test only skips parsing the JSON of the other rows.
    if (input.kind === 'task' && input.data && (!current || current.deleted)) {
      const live = this.db.prepare(`SELECT count(*) n FROM entities WHERE owner_id=? AND kind='task' AND deleted=0
        AND NOT (id LIKE 'ical\\_%' ESCAPE '\\' AND json_extract(data,'$.imported') IS NOT NULL)`).get(id) as { n: number };
      if (live.n >= SYNC_LIMITS.liveTasks) fail('BAD_REQUEST', `You have ${SYNC_LIMITS.liveTasks.toLocaleString('en-US')} tasks, the most Quasar keeps. Delete tasks you’ve finished, then try again.`);
    }
  }
  private validateData(kind: 'task' | 'personal', data: Record<string, unknown>): Record<string, unknown> {
    const parsed = (kind === 'task' ? taskSchema : personalScheduleSchema).safeParse(data);
    if (!parsed.success) {
      // Students see this (a parked change says why it was refused), so only the schema's own sentences are used.
      const reasons = [...new Set(parsed.error.issues.filter(issue => issue.code === 'custom').map(issue => issue.message.replace(/\.?$/, '.')))];
      fail('BAD_REQUEST', reasons.length ? reasons.join(' ') : 'Part of this change isn’t in a form Quasar can save.');
    }
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
    return this.db.prepare(`SELECT r.id,r.user_id userId,r.school_id schoolId,r.message,r.created_at createdAt,s.name schoolName,u.email email,u.display_name displayName,r.kind
      FROM support_requests r LEFT JOIN schools s ON s.id=r.school_id JOIN users u ON u.id=r.user_id WHERE resolved_at IS NULL ORDER BY r.created_at`).all() as {id: string; userId: string; schoolId: string | null; message: string; createdAt: string; schoolName: string | null; email: string; displayName: string; kind: '' | 'appeal:pause' | 'appeal:ban'}[];
  }
  resolveRequest(id: string, requestId: string) {
    this.admin(id);
    this.db.transaction(() => {
      const request = this.db.prepare('SELECT user_id, school_id FROM support_requests WHERE id=? AND resolved_at IS NULL').get(requestId) as { user_id: string; school_id: string | null } | undefined;
      if (!request) fail('NOT_FOUND', 'This request was already resolved.');
      this.db.prepare('UPDATE support_requests SET resolved_at=? WHERE id=?').run(now(), requestId);
      this.audit(id, 'support.resolveRequest', request!.school_id, { userId: request!.user_id, requestId });
    }).immediate();
  }
}
/** The bytes really are the image type they claim: JPEG (FF D8 FF), PNG (89 50 4E 47) or WebP (RIFF....WEBP). */
export function imageBytesMatch(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mime === 'image/webp') return bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
  return false;
}
type EntityRow = { id: string; kind: Entity['kind']; version: number; data: string; deleted: number };
function entityFromRow(row: EntityRow): Entity { return { id: row.id, kind: row.kind, version: row.version, data: JSON.parse(row.data), deleted: !!row.deleted }; }
