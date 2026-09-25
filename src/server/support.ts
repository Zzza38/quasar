import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { personalScheduleSchema, emptyPersonalSchedule, type PersonalSchedule } from '@/domain/schedule';
import { stampCompletion, taskSchema, type Task } from '@/domain/task';
import type { Entity } from '@/domain/sync';
import { CalendarService, listSubscriptions, type FeedSubscription } from './calendar';
import { CommunityService } from './community';
import { namesSchema, reservedDisplayName, type Service } from './service';
import { readEntity, writeEntity } from './entities';

/**
 * The owner's user console (/admin → People). One member's account, school, classes, tasks and social graph, and
 * the edits support can make to them. Every read of a member and every write is written to audit_log.
 *
 * What it never returns: one-to-one chat text (chat_messages.body, reports.evidence). Chats appear as metadata
 * only (who, how many messages, when); the only path from chat text to the owner stays admin.showEvidence on a
 * report (docs/CHAT.md). Calendar feed URLs and push endpoints are secrets and are never returned either.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
/** A view of one member within this long of the owner's previous view of them is not logged again (the page reloads after each edit). */
export const VIEW_AUDIT_WINDOW_MS = 10 * 60_000;
/** How many rows each list in a member's record shows (the newest first). */
const LIST_LIMIT = 200;

/** Why the owner made a destructive change; kept in the audit log. */
export const supportReasonSchema = z.string().trim().min(3, 'Give a reason of at least 3 characters for the audit log.').max(500);
const userIdSchema = z.object({ userId: z.uuid() });
/** Opening a member's record needs a reason, kept with the audit row, because it shows their tasks, classes and social graph. */
export const supportViewSchema = userIdSchema.extend({ reason: supportReasonSchema });
export const userSearchSchema = z.object({ query: z.string().trim().max(200).default(''), schoolId: z.uuid().optional() });
export const accountEditSchema = userIdSchema.extend({ displayName: namesSchema.shape.displayName, fullName: namesSchema.shape.fullName, chatPush: z.boolean() });
export const personalEditSchema = userIdSchema.extend({ expectedVersion: z.number().int().min(0), data: personalScheduleSchema });
const taskIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** The fields support edits on a task. Calendar metadata and the checklist stay as they are. */
export const taskEditFieldsSchema = z.object({
  title: z.string().trim().min(1).max(300), notes: z.string().max(10000), completed: z.boolean(),
  dueDate: taskSchema.shape.dueDate, dueTime: taskSchema.shape.dueTime, priority: z.enum(['low', 'normal', 'high']),
});
export const taskEditSchema = userIdSchema.extend({ taskId: taskIdSchema, expectedVersion: z.number().int().positive(), data: taskEditFieldsSchema });
export const taskDeleteSchema = userIdSchema.extend({ taskId: taskIdSchema, expectedVersion: z.number().int().positive() });
/** `keepPrivateTimetable` keeps a member's private copy of their old school's timetable when they move into a school; by default they follow the new school's, as a join does. */
export const schoolMoveSchema = userIdSchema.extend({ schoolId: z.uuid().nullable(), keepPrivateTimetable: z.boolean().default(false), reason: supportReasonSchema });
export const verificationSetSchema = userIdSchema.extend({ verified: z.boolean() });
export const unbanSchema = userIdSchema.extend({ schoolId: z.uuid(), reason: supportReasonSchema });
export const friendshipRemoveSchema = userIdSchema.extend({ otherId: z.uuid(), reason: supportReasonSchema });
export const feedActionSchema = userIdSchema.extend({ subscriptionId: z.uuid(), action: z.enum(['enable', 'disable', 'remove']) });
export const suspendSchema = userIdSchema.extend({ suspended: z.boolean(), reason: supportReasonSchema });
export const reasonedUserSchema = userIdSchema.extend({ reason: supportReasonSchema });
export const schoolDetailsSchema = z.object({ schoolId: z.uuid(), name: z.string().trim().min(2).max(160), location: z.string().trim().min(2).max(200) });
export const auditQuerySchema = z.object({ userId: z.uuid().optional(), before: z.number().int().positive().optional() });

export type SupportUserRow = {
  id: string; email: string; displayName: string; fullName: string; createdAt: string;
  schoolId: string | null; schoolName: string | null; verified: boolean; suspended: boolean; paused: boolean; openReports: number;
};
export type SupportTask = { id: string; version: number; title: string; notes: string; completed: boolean; completedAt: string | null;
  dueDate: string | null; dueTime: string | null; priority: 'low' | 'normal' | 'high'; imported: boolean; subtasks: number; recurring: boolean };
export type SupportPeer = { userId: string; displayName: string; email: string };
export type AuditEntry = { id: number; action: string; createdAt: string; actorId: string; actorName: string; actorEmail: string;
  schoolId: string | null; schoolName: string | null; detail: unknown; ip: string | null; userAgent: string | null;
  /** The member the row is about (its detail's userId or senderId), when it is not the actor's own row. */
  target: SupportPeer | null };

type UserRow = { id: string; email: string; display_name: string; full_name: string; google_name: string; school_id: string | null; reviewed_version: number | null;
  created_at: string; chat_push: number; suspended_at: string | null; suspended_reason: string | null; session_epoch: number };
type AuditRow = { id: number; action: string; created_at: string; actor_id: string; actor_name: string | null; actor_email: string | null;
  school_id: string | null; school_name: string | null; detail: string; ip: string | null; user_agent: string | null;
  target_id: string | null; target_name: string | null; target_email: string | null };

function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }
function toTask(entity: Entity): SupportTask | null {
  const parsed = taskSchema.safeParse(entity.data);
  if (!parsed.success) return null;
  const task = parsed.data;
  return { id: entity.id, version: entity.version, title: task.title, notes: task.notes, completed: task.completed, completedAt: task.completedAt ?? null,
    dueDate: task.dueDate, dueTime: task.dueTime, priority: task.priority ?? 'normal', imported: !!task.imported, subtasks: task.subtasks?.length ?? 0, recurring: !!task.recurrence };
}

export class SupportService {
  constructor(private readonly service: Service) {}
  private get db() { return this.service.db; }
  private get community() { return new CommunityService(this.service); }

  /** Written in the caller's transaction. `detail.userId` names the member, so their record lists it under Activity. */
  private audit(adminId: string, action: string, schoolId: string | null, detail: Record<string, unknown>): void {
    this.service.audit(adminId, action, schoolId, detail);
  }
  private row(userId: string): UserRow {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(userId) as UserRow | undefined;
    if (!row) return fail('NOT_FOUND', 'Member not found.');
    return row;
  }
  /** Whether the owner is pinned by Google account ID (OWNER_GOOGLE_SUB), and the owner's ID to pin it with. */
  security(adminId: string): { pinned: boolean; googleSub: string } {
    this.service.admin(adminId);
    const row = this.db.prepare('SELECT google_sub FROM users WHERE id=?').get(adminId) as { google_sub: string };
    return { pinned: !!this.service.ownerSub.trim(), googleSub: row.google_sub };
  }
  /** Support can read the owner's own record, but not suspend it (that would lock the console until someone edits the database). */
  private notOwner(userId: string): void {
    if (this.service.isAdmin(userId)) fail('BAD_REQUEST', 'This is the owner account. Change it from your own settings.');
  }

  /* ---------- Reads ---------- */

  /** Members matching an email, a name or an exact ID, optionally at one school; newest accounts first. */
  search(adminId: string, raw: z.input<typeof userSearchSchema>): SupportUserRow[] {
    this.service.admin(adminId);
    const input = userSearchSchema.parse(raw);
    const rows = this.db.prepare(`SELECT u.id, u.email, u.display_name displayName, u.full_name fullName, u.created_at createdAt, u.school_id schoolId, s.name schoolName,
        EXISTS (SELECT 1 FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) verified,
        u.suspended_at IS NOT NULL suspended,
        EXISTS (SELECT 1 FROM chat_pauses p WHERE p.user_id=u.id AND (p.until IS NULL OR p.until>@now)) paused,
        (SELECT count(*) FROM reports r WHERE r.reported_id=u.id AND r.resolved_at IS NULL) openReports
      FROM users u LEFT JOIN schools s ON s.id=u.school_id
      WHERE (@school IS NULL OR u.school_id=@school)
        AND (@query='' OR u.id=@query OR instr(lower(u.email || ' ' || u.display_name || ' ' || u.full_name || ' ' || u.google_name), lower(@query)) > 0)
      ORDER BY u.created_at DESC, u.id LIMIT 100`).all({ query: input.query, school: input.schoolId ?? null, now: now() }) as
      (Omit<SupportUserRow, 'verified' | 'suspended' | 'paused'> & { verified: number; suspended: number; paused: number })[];
    return rows.map(row => ({ ...row, verified: !!row.verified, suspended: !!row.suspended, paused: !!row.paused }));
  }

  /**
   * One member's whole record. It is a mutation in the router because it writes a `support.viewUser` audit row with
   * the owner's reason (at most one per VIEW_AUDIT_WINDOW_MS for the same member, reason, address and browser, since
   * the console reloads the record after each edit).
   */
  view(adminId: string, raw: z.input<typeof supportViewSchema>) {
    this.service.admin(adminId);
    const { userId, reason } = supportViewSchema.parse(raw);
    return this.db.transaction(() => {
      const user = this.row(userId);
      const since = new Date(Date.now() - VIEW_AUDIT_WINDOW_MS).toISOString();
      // Only a reload from the same address and browser is folded in, so an open from another device is always logged.
      const recent = this.db.prepare(`SELECT 1 FROM audit_log WHERE actor_id=? AND action='support.viewUser' AND created_at>? AND json_extract(detail,'$.userId')=? AND json_extract(detail,'$.reason')=?
        AND ip IS ? AND user_agent IS ?`).get(adminId, since, userId, reason, this.service.request?.ip ?? null, this.service.request?.userAgent ?? null);
      if (!recent) this.audit(adminId, 'support.viewUser', user.school_id, { userId, reason });
      return this.record(user);
    }).immediate();
  }

  private record(user: UserRow) {
    const userId = user.id;
    const school = user.school_id ? this.service.school(user.school_id) : null;
    const verification = user.school_id ? this.db.prepare('SELECT method, verified_at verifiedAt FROM school_verifications WHERE user_id=? AND school_id=?').get(userId, user.school_id) as { method: 'domain' | 'support'; verifiedAt: string } | undefined : undefined;
    const personalEntity = this.service.entity(userId, 'personal');
    const personalParsed = personalEntity && !personalEntity.deleted ? personalScheduleSchema.safeParse(personalEntity.data) : null;
    const personal: PersonalSchedule = personalParsed?.success ? personalParsed.data : emptyPersonalSchedule();
    const taskRows = this.db.prepare("SELECT * FROM entities WHERE owner_id=? AND kind='task' AND deleted=0 ORDER BY id").all(userId) as { id: string; kind: 'task'; version: number; data: string; deleted: number }[];
    const tasks = taskRows.map(row => toTask({ id: row.id, kind: row.kind, version: row.version, data: JSON.parse(row.data), deleted: false }));
    const deletedTasks = (this.db.prepare("SELECT count(*) n FROM entities WHERE owner_id=? AND kind='task' AND deleted=1").get(userId) as { n: number }).n;
    const peer = 'u.id AS userId, u.display_name AS displayName, u.email';
    const friendships = this.db.prepare(`SELECT ${peer}, f.status, f.requester_id=? AS outgoing, f.created_at createdAt, f.responded_at respondedAt
      FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END
      WHERE f.user_low=? OR f.user_high=? ORDER BY f.status, u.display_name COLLATE NOCASE LIMIT ${LIST_LIMIT}`).all(userId, userId, userId, userId) as (SupportPeer & { status: 'pending' | 'accepted'; outgoing: number; createdAt: string; respondedAt: string | null })[];
    const blocks = this.db.prepare(`SELECT ${peer}, b.blocker_id=? AS byThem, b.created_at createdAt FROM blocks b JOIN users u ON u.id = CASE WHEN b.blocker_id=? THEN b.blocked_id ELSE b.blocker_id END
      WHERE b.blocker_id=? OR b.blocked_id=? ORDER BY b.created_at DESC LIMIT ${LIST_LIMIT}`).all(userId, userId, userId, userId) as (SupportPeer & { byThem: number; createdAt: string })[];
    // Chat metadata only: never chat_messages.body.
    const chats = this.db.prepare(`SELECT ${peer}, t.created_at createdAt, t.last_message_at lastMessageAt,
        (SELECT count(*) FROM chat_messages c WHERE c.thread_id=t.id AND c.sender_id=@user) sent,
        (SELECT count(*) FROM chat_messages c WHERE c.thread_id=t.id AND c.sender_id<>@user) received
      FROM chat_threads t JOIN users u ON u.id = CASE WHEN t.user_low=@user THEN t.user_high ELSE t.user_low END
      WHERE t.user_low=@user OR t.user_high=@user ORDER BY t.last_message_at DESC NULLS LAST LIMIT ${LIST_LIMIT}`).all({ user: userId }) as (SupportPeer & { createdAt: string; lastMessageAt: string | null; sent: number; received: number })[];
    // The global room is public to every member, so its text is shown like any member sees it.
    const globalMessages = this.db.prepare(`SELECT id, seq, body, created_at createdAt, edited_at editedAt, deleted_at deletedAt, deleted_by deletedBy, reason
      FROM global_messages WHERE sender_id=? ORDER BY seq DESC LIMIT ${LIST_LIMIT}`).all(userId) as { id: string; seq: number; body: string; createdAt: string; editedAt: string | null; deletedAt: string | null; deletedBy: 'sender' | 'owner' | null; reason: string | null }[];
    const reportColumns = `r.id, r.reason, r.category, r.created_at createdAt, r.resolved_at resolvedAt, r.outcome, r.thread_id IS NOT NULL isChat, s.name schoolName`;
    const reportsAbout = this.db.prepare(`SELECT ${reportColumns}, u.id otherId, u.display_name otherName FROM reports r JOIN users u ON u.id=r.reporter_id LEFT JOIN schools s ON s.id=r.school_id
      WHERE r.reported_id=? ORDER BY r.created_at DESC LIMIT ${LIST_LIMIT}`).all(userId) as ReportRow[];
    const reportsBy = this.db.prepare(`SELECT ${reportColumns}, u.id otherId, u.display_name otherName FROM reports r JOIN users u ON u.id=r.reported_id LEFT JOIN schools s ON s.id=r.school_id
      WHERE r.reporter_id=? ORDER BY r.created_at DESC LIMIT ${LIST_LIMIT}`).all(userId) as ReportRow[];
    const supportRequests = this.db.prepare(`SELECT r.id, r.message, r.created_at createdAt, r.resolved_at resolvedAt, s.name schoolName FROM support_requests r LEFT JOIN schools s ON s.id=r.school_id
      WHERE r.user_id=? ORDER BY r.created_at DESC LIMIT ${LIST_LIMIT}`).all(userId) as { id: string; message: string; createdAt: string; resolvedAt: string | null; schoolName: string | null }[];
    const verificationRequests = this.db.prepare(`SELECT r.id, r.proof, r.created_at createdAt, r.resolved_at resolvedAt, r.decision, s.name schoolName FROM verification_requests r JOIN schools s ON s.id=r.school_id
      WHERE r.user_id=? ORDER BY r.created_at DESC LIMIT ${LIST_LIMIT}`).all(userId) as { id: string; proof: string; createdAt: string; resolvedAt: string | null; decision: string | null; schoolName: string }[];
    const bans = this.db.prepare(`SELECT b.school_id schoolId, s.name schoolName, b.reason, b.created_at createdAt FROM school_bans b JOIN schools s ON s.id=b.school_id WHERE b.user_id=? ORDER BY b.created_at DESC`).all(userId) as { schoolId: string; schoolName: string; reason: string; createdAt: string }[];
    const proposals = this.db.prepare(`SELECT p.id, p.summary, p.status, p.created_at createdAt, s.name schoolName FROM schedule_proposals p JOIN schools s ON s.id=p.school_id
      WHERE p.proposer_id=? ORDER BY p.created_at DESC LIMIT ${LIST_LIMIT}`).all(userId) as { id: string; summary: string; status: string; createdAt: string; schoolName: string }[];
    const pause = this.db.prepare('SELECT until, reason, created_at createdAt FROM chat_pauses WHERE user_id=? AND (until IS NULL OR until>?)').get(userId, now()) as { until: string | null; reason: string; createdAt: string } | undefined;
    const browsers = (this.db.prepare('SELECT count(*) n FROM push_subscriptions WHERE owner_id=?').get(userId) as { n: number }).n;
    const feeds: FeedSubscription[] = listSubscriptions(this.db, userId);
    return {
      account: { id: userId, email: user.email, googleName: user.google_name, displayName: user.display_name, fullName: user.full_name, createdAt: user.created_at,
        chatPush: user.chat_push !== 0, isOwner: this.service.isAdmin(userId), suspended: user.suspended_at ? { at: user.suspended_at, reason: user.suspended_reason ?? '' } : null, browsers },
      school: school ? { id: school.id, name: school.name, location: school.location, version: school.version, reviewedVersion: user.reviewed_version, schedule: school.schedule,
        verification: verification ?? null, verificationPending: !verification && !!this.db.prepare('SELECT 1 FROM verification_requests WHERE user_id=? AND school_id=? AND resolved_at IS NULL').get(userId, school.id) } : null,
      personal: { version: personalEntity && !personalEntity.deleted ? personalEntity.version : 0, data: personal, valid: personalParsed ? personalParsed.success : true },
      tasks: tasks.filter((task): task is SupportTask => task !== null), unreadableTasks: tasks.filter(task => task === null).length, deletedTasks,
      friendships: friendships.map(row => ({ ...row, outgoing: !!row.outgoing })),
      blocks: blocks.map(row => ({ ...row, byThem: !!row.byThem })),
      chats, globalMessages, pause: pause ?? null,
      reportsAbout: reportsAbout.map(reportFromRow), reportsBy: reportsBy.map(reportFromRow),
      supportRequests, verificationRequests, bans, proposals, feeds,
      activity: this.auditRows({ userId }),
    };
  }

  /**
   * The audit log, newest first, 100 rows a page (`before` is the last row's id). With `userId`, only rows about
   * that member: ones they wrote, and ones whose detail names them.
   */
  auditLog(adminId: string, raw: z.infer<typeof auditQuerySchema>): AuditEntry[] {
    this.service.admin(adminId);
    return this.auditRows(auditQuerySchema.parse(raw));
  }
  private auditRows({ userId, before }: z.infer<typeof auditQuerySchema>): AuditEntry[] {
    // Owner rows name the member they are about in their detail (userId, or senderId for Global chat moderation).
    const target = "CASE WHEN json_valid(a.detail) THEN coalesce(json_extract(a.detail,'$.userId'), json_extract(a.detail,'$.senderId')) END";
    const rows = this.db.prepare(`SELECT a.id, a.action, a.created_at, a.actor_id, u.display_name actor_name, u.email actor_email, a.school_id, s.name school_name, a.detail, a.ip, a.user_agent,
        t.id target_id, t.display_name target_name, t.email target_email
      FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN schools s ON s.id=a.school_id LEFT JOIN users t ON t.id=${target}
      WHERE (@before IS NULL OR a.id<@before)
        AND (@user IS NULL OR a.actor_id=@user OR (json_valid(a.detail) AND (json_extract(a.detail,'$.userId')=@user OR json_extract(a.detail,'$.senderId')=@user)))
      ORDER BY a.id DESC LIMIT 100`).all({ user: userId ?? null, before: before ?? null }) as AuditRow[];
    return rows.map(row => ({ id: row.id, action: row.action, createdAt: row.created_at, actorId: row.actor_id, actorName: row.actor_name ?? '', actorEmail: row.actor_email ?? '',
      schoolId: row.school_id, schoolName: row.school_name, detail: parseJson(row.detail), ip: row.ip, userAgent: row.user_agent,
      target: row.target_id && row.target_id !== row.actor_id ? { userId: row.target_id, displayName: row.target_name ?? '', email: row.target_email ?? '' } : null }));
  }

  /* ---------- Account ---------- */

  updateAccount(adminId: string, raw: z.input<typeof accountEditSchema>): void {
    this.service.admin(adminId);
    const input = accountEditSchema.parse(raw);
    this.db.transaction(() => {
      const user = this.row(input.userId);
      // The same rule as a student's own edit: support never hands a member a name that poses as Quasar or support.
      if (input.displayName !== user.display_name && !this.service.isAdmin(input.userId) && reservedDisplayName(input.displayName)) fail('BAD_REQUEST', 'Choose a display name that doesn’t mention Quasar or support.');
      this.db.prepare('UPDATE users SET display_name=?, full_name=?, chat_push=? WHERE id=?').run(input.displayName, input.fullName, Number(input.chatPush), input.userId);
      this.audit(adminId, 'support.editAccount', user.school_id, { userId: input.userId,
        from: { displayName: user.display_name, fullName: user.full_name, chatPush: user.chat_push !== 0 },
        to: { displayName: input.displayName, fullName: input.fullName, chatPush: input.chatPush } });
    }).immediate();
  }
  /** Suspended accounts are signed out everywhere and every API call refuses them until support lifts it. */
  setSuspended(adminId: string, raw: z.input<typeof suspendSchema>): void {
    this.service.admin(adminId);
    const input = suspendSchema.parse(raw);
    this.notOwner(input.userId);
    this.db.transaction(() => {
      const user = this.row(input.userId);
      if (input.suspended) this.db.prepare('UPDATE users SET suspended_at=?, suspended_reason=?, session_epoch=session_epoch+1 WHERE id=?').run(now(), input.reason, input.userId);
      else this.db.prepare('UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id=?').run(input.userId);
      this.audit(adminId, input.suspended ? 'support.suspend' : 'support.unsuspend', user.school_id, { userId: input.userId, reason: input.reason });
    }).immediate();
  }
  /**
   * Ends every session of the member at their next request (authFromSession in src/server/auth.ts). Allowed on the
   * owner's own account too, as the response to a session the owner does not recognize; it ends this one as well.
   */
  signOutEverywhere(adminId: string, raw: z.input<typeof reasonedUserSchema>): void {
    this.service.admin(adminId);
    const input = reasonedUserSchema.parse(raw);
    this.db.transaction(() => {
      const user = this.row(input.userId);
      this.db.prepare('UPDATE users SET session_epoch=session_epoch+1 WHERE id=?').run(input.userId);
      this.audit(adminId, 'support.signOut', user.school_id, { userId: input.userId, reason: input.reason });
    }).immediate();
  }
  /** Forgets every browser enrolled for reminders; the member can enable them again on each device. */
  removeBrowsers(adminId: string, raw: z.input<typeof reasonedUserSchema>): number {
    this.service.admin(adminId);
    const input = reasonedUserSchema.parse(raw);
    return this.db.transaction(() => {
      const user = this.row(input.userId);
      const { changes } = this.db.prepare('DELETE FROM push_subscriptions WHERE owner_id=?').run(input.userId);
      this.audit(adminId, 'support.removeBrowsers', user.school_id, { userId: input.userId, count: changes, reason: input.reason });
      return changes;
    }).immediate();
  }

  /* ---------- School membership ---------- */

  /**
   * Moves the member to another school, or out of theirs, without a ban (compare admin.removeMember). Like a join,
   * their classes and personal settings stay, open proposals at the old school are withdrawn, and a matching email
   * domain verifies them at the new one. A private timetable is a copy of the old school's, so moving into a school
   * drops it unless `keepPrivateTimetable` is set; without it the member would keep following the old bell times.
   * Moving out of a school keeps it: it is then the only timetable they have.
   */
  moveSchool(adminId: string, raw: z.input<typeof schoolMoveSchema>): void {
    this.service.admin(adminId);
    const input = schoolMoveSchema.parse(raw);
    this.db.transaction(() => {
      const user = this.row(input.userId);
      if (user.school_id === input.schoolId) return;
      let timetable: 'school' | 'private' | null = null;
      if (input.schoolId) {
        const school = this.service.school(input.schoolId);
        if (this.community.isBanned(input.userId, school.id)) fail('CONFLICT', 'Support removed this member from that school. Lift the removal first.');
        this.db.prepare('UPDATE users SET school_id=?, reviewed_version=? WHERE id=?').run(school.id, school.version, input.userId);
        this.db.prepare('UPDATE schools SET member_locked=1 WHERE id=? AND (SELECT count(*) FROM users WHERE school_id=?) >= 10').run(school.id, school.id);
        const existing = readEntity(this.db, input.userId, 'personal');
        const personal = existing && !existing.deleted ? personalScheduleSchema.safeParse(existing.data) : null;
        if (personal?.success && personal.data.customSchedule) {
          timetable = input.keepPrivateTimetable ? 'private' : 'school';
          if (!input.keepPrivateTimetable) writeEntity(this.db, input.userId, { id: 'personal', kind: 'personal', version: existing!.version + 1, data: { ...personal.data, customSchedule: null }, deleted: false });
        }
      } else this.db.prepare('UPDATE users SET school_id=NULL, reviewed_version=NULL WHERE id=?').run(input.userId);
      if (user.school_id) this.community.withdrawProposals(input.userId, user.school_id);
      this.audit(adminId, 'support.moveSchool', input.schoolId, { userId: input.userId, fromSchoolId: user.school_id, toSchoolId: input.schoolId, ...(timetable ? { timetable } : {}), reason: input.reason });
    }).immediate();
    // A domain match verifies at once, as on a join. Outside the transaction: verifyByDomain runs its own.
    if (input.schoolId) this.community.onJoin(input.userId, input.schoolId);
  }
  setVerified(adminId: string, raw: z.input<typeof verificationSetSchema>): void {
    this.service.admin(adminId);
    const input = verificationSetSchema.parse(raw);
    this.db.transaction(() => {
      const user = this.row(input.userId);
      if (!user.school_id) fail('BAD_REQUEST', 'This member has no school to be verified at.');
      if (input.verified) {
        if (this.community.isBanned(input.userId, user.school_id!)) fail('CONFLICT', 'Support removed this member from this school.');
        this.db.prepare('INSERT OR IGNORE INTO school_verifications(user_id,school_id,method,actor_id,verified_at) VALUES(?,?,?,?,?)').run(input.userId, user.school_id, 'support', adminId, now());
        this.db.prepare("UPDATE verification_requests SET resolved_at=?, decision='approved', actor_id=? WHERE user_id=? AND school_id=? AND resolved_at IS NULL").run(now(), adminId, input.userId, user.school_id);
      } else {
        // Their next page load would verify them again by email domain, so that has to change first.
        if (this.community.domainMatches(input.userId, user.school_id!)) fail('BAD_REQUEST', 'Their email is on one of this school’s domains, so they would be verified again at once. Remove the domain from the school first, or remove them from the school.');
        this.db.prepare('DELETE FROM school_verifications WHERE user_id=? AND school_id=?').run(input.userId, user.school_id);
        this.community.withdrawProposals(input.userId, user.school_id!);
      }
      this.audit(adminId, input.verified ? 'support.verify' : 'support.unverify', user.school_id, { userId: input.userId });
    }).immediate();
  }
  /** Lifts a support removal, so the member may join that school again. It does not rejoin them. */
  unban(adminId: string, raw: z.input<typeof unbanSchema>): void {
    this.service.admin(adminId);
    const input = unbanSchema.parse(raw);
    this.db.transaction(() => {
      this.row(input.userId);
      const { changes } = this.db.prepare('DELETE FROM school_bans WHERE user_id=? AND school_id=?').run(input.userId, input.schoolId);
      if (!changes) fail('NOT_FOUND', 'This member is not removed from that school.');
      // An open appeal against the removal (docs/CHAT.md §14) is answered by lifting it.
      this.db.prepare("UPDATE support_requests SET resolved_at=? WHERE user_id=? AND school_id=? AND kind='appeal:ban' AND resolved_at IS NULL").run(new Date().toISOString(), input.userId, input.schoolId);
      this.audit(adminId, 'support.unban', input.schoolId, { userId: input.userId, reason: input.reason });
    }).immediate();
  }

  /* ---------- Classes and tasks ---------- */

  /**
   * Replaces the member's personal schedule (classes, period assignments, grade, overrides) with a new version, the
   * way a sync would, so their devices pick it up and merge it with any offline edits on their next sync.
   */
  savePersonal(adminId: string, raw: z.input<typeof personalEditSchema>): { version: number } {
    this.service.admin(adminId);
    const input = personalEditSchema.parse(raw);
    if (JSON.stringify(input.data).length > 1_000_000) fail('BAD_REQUEST', 'This change is too large.');
    return this.db.transaction(() => {
      const user = this.row(input.userId);
      const current = readEntity(this.db, input.userId, 'personal');
      const version = current && !current.deleted ? current.version : 0;
      if (version !== input.expectedVersion) fail('CONFLICT', 'This member’s classes changed since you opened them. Reload and try again.');
      const next = (current?.version ?? 0) + 1;
      writeEntity(this.db, input.userId, { id: 'personal', kind: 'personal', version: next, data: input.data, deleted: false });
      this.audit(adminId, 'support.editClasses', user.school_id, { userId: input.userId, version: next, classes: input.data.classes.length });
      return { version: next };
    }).immediate();
  }
  saveTask(adminId: string, raw: z.input<typeof taskEditSchema>): { version: number } {
    this.service.admin(adminId);
    const input = taskEditSchema.parse(raw);
    return this.db.transaction(() => {
      const user = this.row(input.userId);
      const current = this.liveTask(input.userId, input.taskId, input.expectedVersion);
      const edited = { ...current.data, ...input.data } as Record<string, unknown>;
      // A cleared due date takes the time, reminder and repeat with it, which need one.
      if (!input.data.dueDate) { edited.dueTime = null; edited.reminder = null; edited.recurrence = null; }
      const parsed = taskSchema.safeParse(stampCompletion(edited, current.data, new Date()));
      if (!parsed.success) return fail('BAD_REQUEST', parsed.error.issues.find(issue => issue.code === 'custom')?.message ?? 'This task isn’t in a form Quasar can save.');
      const version = current.version + 1;
      writeEntity(this.db, input.userId, { id: input.taskId, kind: 'task', version, data: parsed.data as Task, deleted: false });
      // Checking off a repeating task brings up its next one, as it does when the member checks it off.
      if (!current.data.completed && parsed.data.completed) this.service.addSuccessor(input.userId, input.taskId, parsed.data);
      this.audit(adminId, 'support.editTask', user.school_id, { userId: input.userId, taskId: input.taskId, version });
      return { version };
    }).immediate();
  }
  deleteTask(adminId: string, raw: z.input<typeof taskDeleteSchema>): void {
    this.service.admin(adminId);
    const input = taskDeleteSchema.parse(raw);
    this.db.transaction(() => {
      const user = this.row(input.userId);
      const current = this.liveTask(input.userId, input.taskId, input.expectedVersion);
      writeEntity(this.db, input.userId, { ...current, version: current.version + 1, deleted: true });
      this.audit(adminId, 'support.deleteTask', user.school_id, { userId: input.userId, taskId: input.taskId, version: current.version + 1 });
    }).immediate();
  }
  private liveTask(userId: string, taskId: string, expectedVersion: number): Entity {
    const current = readEntity(this.db, userId, taskId);
    if (!current || current.kind !== 'task' || current.deleted) return fail('NOT_FOUND', 'This task was deleted. Reload the member.');
    if (current.version !== expectedVersion) fail('CONFLICT', 'This task changed since you opened it. Reload and try again.');
    return current;
  }
  feedAction(adminId: string, raw: z.input<typeof feedActionSchema>): void {
    this.service.admin(adminId);
    const input = feedActionSchema.parse(raw);
    const user = this.row(input.userId);
    const calendar = new CalendarService(this.db);
    // CalendarService checks that the feed belongs to this member (NOT_FOUND otherwise).
    if (input.action === 'remove') calendar.remove(input.userId, input.subscriptionId);
    else calendar.setEnabled(input.userId, input.subscriptionId, input.action === 'enable');
    this.audit(adminId, `support.feed.${input.action}`, user.school_id, { userId: input.userId, subscriptionId: input.subscriptionId });
  }

  /* ---------- Friendships ---------- */

  /** Ends a friendship or drops a pending request, which also closes the pair's chat. Support never creates one. */
  removeFriendship(adminId: string, raw: z.input<typeof friendshipRemoveSchema>): void {
    this.service.admin(adminId);
    const input = friendshipRemoveSchema.parse(raw);
    this.db.transaction(() => {
      const user = this.row(input.userId);
      const [low, high] = pair(input.userId, input.otherId);
      const { changes } = this.db.prepare('DELETE FROM friendships WHERE user_low=? AND user_high=?').run(low, high);
      if (!changes) fail('NOT_FOUND', 'These members are not friends.');
      this.audit(adminId, 'support.removeFriendship', user.school_id, { userId: input.userId, otherId: input.otherId, reason: input.reason });
    }).immediate();
  }

  /* ---------- Schools ---------- */

  renameSchool(adminId: string, raw: z.input<typeof schoolDetailsSchema>): void {
    this.service.admin(adminId);
    const input = schoolDetailsSchema.parse(raw);
    this.db.transaction(() => {
      const school = this.service.school(input.schoolId);
      this.db.prepare('UPDATE schools SET name=?, location=? WHERE id=?').run(input.name, input.location, school.id);
      this.audit(adminId, 'support.renameSchool', school.id, { from: { name: school.name, location: school.location }, to: { name: input.name, location: input.location } });
    }).immediate();
  }
}

type ReportRow = { id: string; reason: string; category: string | null; createdAt: string; resolvedAt: string | null; outcome: string | null; isChat: number; schoolName: string | null; otherId: string; otherName: string };
function reportFromRow(row: ReportRow) { return { ...row, isChat: !!row.isChat }; }
export type SupportRecord = ReturnType<SupportService['view']>;
