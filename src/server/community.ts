import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { emptyPersonalSchedule, personalScheduleSchema, type Grade, type PersonalSchedule } from '@/domain/schedule';
import type { ReportCategory } from '@/domain/chat';
import { countUnreadChats, type ChatPause } from './chat';
import { leaveAllGroups } from './group-chat';
import { avatarUrl, type AvatarRow } from './avatars';
import type { Service, User } from './service';

/**
 * Phase 3 community rules.
 *
 * - School verification is separate from Google sign-in. A member is verified for one school either
 *   automatically (their Google email matches a domain support attached to the school) or after support
 *   approves a proof request. Verification belongs to the (user, school) pair and is dormant while the
 *   student follows another school.
 * - Directory: members can browse their school's members. Nobody can hide from it, but a block hides both
 *   people from each other. Full names appear only when viewer and profile owner are both verified.
 * - Classes and the timetable are shared only through an accepted friendship. Removing a friend, blocking,
 *   or leaving the school revokes access immediately because every read re-checks the friendship.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'TOO_MANY_REQUESTS';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export const proofSchema = z.object({ proof: z.string().trim().min(10).max(2000) });
export const memberIdSchema = z.object({ userId: z.uuid() });
export const reportSchema = z.object({ userId: z.uuid(), reason: z.string().trim().min(10).max(2000) });
export const emailDomainsSchema = z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a domain such as students.example.org')).max(10);
export const FRIEND_REQUEST_LIMIT = 30;

export type Verification = { status: 'verified' | 'pending' | 'none'; method: 'domain' | 'support' | null };
export type FriendState = 'none' | 'requested' | 'incoming' | 'friends';
/** An accepted friend's timetable, kept in memory on the client for date-specific classmate labels. */
export type Classmate = { id: string; displayName: string; personal: PersonalSchedule };
export type MemberSummary = { id: string; displayName: string; fullName: string | null; grade: Grade | null; verified: boolean; joinedAt: string; friendState: FriendState; blocked: boolean; avatar: string | null };
export type ReportSummary = { id: string; reason: string; createdAt: string; schoolId: string | null; schoolName: string | null; reportedId: string; reportedName: string; reportedEmail: string; reporterId: string; reporterName: string;
  isChat: boolean; category: ReportCategory | null; evidenceCount: number; history: { reports: number; removals: number; pauses: number }; pause: ChatPause | null };
type MemberRow = AvatarRow & { display_name: string; full_name: string; email: string; created_at: string; school_id: string | null; verified: number };

export function emailDomain(email: string): string { return email.toLowerCase().split('@')[1] ?? ''; }
export function parseEmailDomains(stored: string): string[] { return stored.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean); }

export class CommunityService {
  constructor(private readonly service: Service) {}
  private get db() { return this.service.db; }

  /* ---------- Verification ---------- */

  isVerified(userId: string, schoolId: string | null): boolean {
    if (!schoolId) return false;
    return !!this.db.prepare('SELECT 1 FROM school_verifications WHERE user_id=? AND school_id=?').get(userId, schoolId);
  }
  /**
   * The student's verification at their current school. A domain support attached after the student joined
   * verifies them here, on their next workspace load, so "sign in with a school address" holds for existing
   * members too instead of only at join.
   */
  verification(userId: string): Verification {
    const user = this.service.user(userId);
    if (!user.schoolId) return { status: 'none', method: null };
    const row = this.db.prepare('SELECT method FROM school_verifications WHERE user_id=? AND school_id=?').get(userId, user.schoolId) as { method: 'domain' | 'support' } | undefined;
    if (row) return { status: 'verified', method: row.method };
    if (this.verifyByDomain(userId, user.schoolId)) return { status: 'verified', method: 'domain' };
    const pending = this.db.prepare('SELECT 1 FROM verification_requests WHERE user_id=? AND school_id=? AND resolved_at IS NULL').get(userId, user.schoolId);
    return { status: pending ? 'pending' : 'none', method: null };
  }
  /** Verifies by email domain when the school lists the student's Google domain. Safe to call repeatedly. */
  verifyByDomain(userId: string, schoolId: string): boolean {
    const user = this.service.user(userId);
    const row = this.db.prepare('SELECT email_domains FROM schools WHERE id=?').get(schoolId) as { email_domains: string } | undefined;
    if (!row) return false;
    const domains = parseEmailDomains(row.email_domains);
    const domain = emailDomain(user.email);
    if (!domain || !domains.some(entry => domain === entry || domain.endsWith(`.${entry}`))) return false;
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO school_verifications(user_id,school_id,method,actor_id,verified_at) VALUES(?,?,?,?,?)').run(userId, schoolId, 'domain', null, now());
      // A proof sent before support added the domain is settled by it, so it leaves the support queue.
      this.db.prepare("UPDATE verification_requests SET resolved_at=?, decision='approved', actor_id=NULL WHERE user_id=? AND school_id=? AND resolved_at IS NULL").run(now(), userId, schoolId);
    })();
    return true;
  }
  requestVerification(userId: string, raw: z.infer<typeof proofSchema>): Verification {
    const user = this.service.ready(userId);
    if (!user.schoolId) return fail('BAD_REQUEST', 'Join a school first.');
    const input = proofSchema.parse(raw);
    return this.db.transaction(() => {
      if (this.verifyByDomain(userId, user.schoolId!)) return this.verification(userId);
      if (this.isVerified(userId, user.schoolId)) return this.verification(userId);
      const open = this.db.prepare('SELECT 1 FROM verification_requests WHERE user_id=? AND school_id=? AND resolved_at IS NULL').get(userId, user.schoolId);
      if (open) fail('CONFLICT', 'Support is already reviewing your proof.');
      const declined = this.db.prepare("SELECT count(*) n FROM verification_requests WHERE user_id=? AND school_id=? AND decision='declined' AND resolved_at > ?").get(userId, user.schoolId, new Date(Date.now() - 7 * 86400000).toISOString()) as { n: number };
      if (declined.n >= 3) fail('TOO_MANY_REQUESTS', 'Support declined three requests this week. Contact support before sending more.');
      this.db.prepare('INSERT INTO verification_requests(id,user_id,school_id,proof,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), userId, user.schoolId, input.proof, now());
      return this.verification(userId);
    }).immediate();
  }
  /** Called from the school join path so domain matches verify without a request. */
  onJoin(userId: string, schoolId: string): void { this.verifyByDomain(userId, schoolId); }
  /**
   * Closes a member's open schedule proposals at a school they left or lost verification for. Their votes stay
   * stored but stop counting, because tallies only count currently verified members (src/server/proposals.ts).
   * Runs inside the caller's transaction.
   */
  withdrawProposals(userId: string, schoolId: string): void {
    this.db.prepare("UPDATE schedule_proposals SET status='withdrawn', closed_at=? WHERE proposer_id=? AND school_id=? AND status='open'").run(now(), userId, schoolId);
  }

  /* ---------- Directory and profiles ---------- */

  private member(userId: string): User & { schoolId: string } {
    const user = this.service.ready(userId);
    if (!user.schoolId) return fail('BAD_REQUEST', 'Join a school to see its members.');
    return user as User & { schoolId: string };
  }
  private hidden(viewerId: string, otherId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(viewerId, otherId, otherId, viewerId);
  }
  private friendState(viewerId: string, otherId: string): FriendState {
    const [low, high] = pair(viewerId, otherId);
    const row = this.db.prepare('SELECT requester_id, status FROM friendships WHERE user_low=? AND user_high=?').get(low, high) as { requester_id: string; status: string } | undefined;
    if (!row) return 'none';
    if (row.status === 'accepted') return 'friends';
    return row.requester_id === viewerId ? 'requested' : 'incoming';
  }
  areFriends(a: string, b: string): boolean { return a !== b && this.friendState(a, b) === 'friends'; }
  private personalOf(userId: string): PersonalSchedule {
    const entity = this.service.entity(userId, 'personal');
    const parsed = personalScheduleSchema.safeParse(entity && !entity.deleted ? entity.data : emptyPersonalSchedule());
    return parsed.success ? parsed.data : emptyPersonalSchedule();
  }
  private summarize(viewerId: string, viewerVerified: boolean, row: MemberRow): MemberSummary {
    const verified = !!row.verified;
    return {
      id: row.id, displayName: row.display_name, fullName: viewerVerified && verified ? row.full_name : null,
      grade: this.personalOf(row.id).grade ?? null, verified, joinedAt: row.created_at,
      friendState: this.friendState(viewerId, row.id), blocked: !!this.db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(viewerId, row.id),
      avatar: avatarUrl(row),
    };
  }
  members(viewerId: string, query = ''): { members: MemberSummary[]; viewerVerified: boolean } {
    const viewer = this.member(viewerId);
    const viewerVerified = this.isVerified(viewerId, viewer.schoolId);
    const rows = this.db.prepare(`SELECT u.*, (SELECT count(*) FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) verified
      FROM users u WHERE u.school_id=? AND u.id<>? AND u.display_name<>'' AND instr(lower(u.display_name), lower(?)) > 0
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=?))
      ORDER BY u.display_name COLLATE NOCASE, u.id LIMIT 200`).all(viewer.schoolId, viewerId, query.trim(), viewerId, viewerId) as MemberRow[];
    return { members: rows.map(row => this.summarize(viewerId, viewerVerified, row)), viewerVerified };
  }
  friends(viewerId: string): { friends: MemberSummary[]; incoming: MemberSummary[]; outgoing: MemberSummary[]; blocked: MemberSummary[] } {
    const viewer = this.service.ready(viewerId);
    const viewerVerified = this.isVerified(viewerId, viewer.schoolId);
    const rows = this.db.prepare(`SELECT u.*, (SELECT count(*) FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) verified, f.status, f.requester_id
      FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END
      WHERE (f.user_low=? OR f.user_high=?) ORDER BY u.display_name COLLATE NOCASE`).all(viewerId, viewerId, viewerId) as (MemberRow & { status: string; requester_id: string })[];
    const summaries = rows.map(row => ({ row, summary: this.summarize(viewerId, viewerVerified, row) }));
    const blockedRows = this.db.prepare('SELECT u.*, 0 verified FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY u.display_name COLLATE NOCASE').all(viewerId) as MemberRow[];
    return {
      friends: summaries.filter(entry => entry.row.status === 'accepted').map(entry => entry.summary),
      incoming: summaries.filter(entry => entry.row.status === 'pending' && entry.row.requester_id !== viewerId).map(entry => entry.summary),
      outgoing: summaries.filter(entry => entry.row.status === 'pending' && entry.row.requester_id === viewerId).map(entry => entry.summary),
      blocked: blockedRows.map(row => ({ ...this.summarize(viewerId, viewerVerified, row), fullName: null })),
    };
  }
  /** A profile. Friends additionally receive classes and the full personal schedule so the client can render their day. */
  profile(viewerId: string, otherId: string) {
    const viewer = this.service.ready(viewerId);
    if (otherId === viewerId) fail('BAD_REQUEST', 'This is your own account.');
    const row = this.db.prepare(`SELECT u.*, (SELECT count(*) FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) verified FROM users u WHERE u.id=?`).get(otherId) as MemberRow | undefined;
    // Someone who blocked the viewer is invisible. Someone the viewer blocked stays reachable so the block can be lifted.
    const blockedByThem = !!this.db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(otherId, viewerId);
    if (!row || !row.school_id || blockedByThem) return fail('NOT_FOUND', 'This member is not available.');
    const friends = this.areFriends(viewerId, otherId);
    const sameSchool = viewer.schoolId !== null && viewer.schoolId === row.school_id;
    if (!sameSchool && !friends) fail('NOT_FOUND', 'This member is not available.');
    const summary = this.summarize(viewerId, this.isVerified(viewerId, viewer.schoolId), row);
    const school = this.service.school(row.school_id);
    const shared = friends ? this.personalOf(otherId) : null;
    // True when the pair's thread holds at least one message; the report panel then offers to include them.
    const [low, high] = pair(viewerId, otherId);
    const hasChat = !!this.db.prepare('SELECT 1 FROM chat_threads WHERE user_low=? AND user_high=? AND last_message_at IS NOT NULL').get(low, high);
    return {
      ...summary, sameSchool, hasChat, school: { id: school.id, name: school.name, schedule: school.schedule },
      friendCount: (this.db.prepare("SELECT count(*) n FROM friendships WHERE status='accepted' AND (user_low=? OR user_high=?)").get(otherId, otherId) as { n: number }).n,
      shared: shared ? { classes: shared.classes, personal: shared } : null,
    };
  }

  /* ---------- Friendship ---------- */

  request(viewerId: string, otherId: string): FriendState {
    const viewer = this.member(viewerId);
    if (otherId === viewerId) fail('BAD_REQUEST', 'You cannot add yourself.');
    return this.db.transaction(() => {
      const other = this.db.prepare('SELECT school_id FROM users WHERE id=?').get(otherId) as { school_id: string | null } | undefined;
      if (!other || other.school_id !== viewer.schoolId || this.hidden(viewerId, otherId)) fail('NOT_FOUND', 'This member is not available.');
      const [low, high] = pair(viewerId, otherId);
      const existing = this.db.prepare('SELECT requester_id, status FROM friendships WHERE user_low=? AND user_high=?').get(low, high) as { requester_id: string; status: string } | undefined;
      if (existing?.status === 'accepted') return 'friends';
      if (existing && existing.requester_id === viewerId) return 'requested';
      if (existing) {
        // The other person already asked: treat this as acceptance.
        this.db.prepare("UPDATE friendships SET status='accepted', responded_at=? WHERE user_low=? AND user_high=?").run(now(), low, high);
        return 'friends';
      }
      const pending = this.db.prepare("SELECT count(*) n FROM friendships WHERE requester_id=? AND status='pending'").get(viewerId) as { n: number };
      if (pending.n >= FRIEND_REQUEST_LIMIT) fail('TOO_MANY_REQUESTS', `You have ${FRIEND_REQUEST_LIMIT} requests waiting for an answer. Wait for replies before sending more.`);
      this.db.prepare('INSERT INTO friendships(user_low,user_high,requester_id,status,created_at) VALUES(?,?,?,?,?)').run(low, high, viewerId, 'pending', now());
      return 'requested';
    }).immediate();
  }
  respond(viewerId: string, otherId: string, accept: boolean): FriendState {
    this.service.ready(viewerId);
    const [low, high] = pair(viewerId, otherId);
    const state = this.db.transaction((): FriendState | 'stale' => {
      const existing = this.db.prepare("SELECT requester_id FROM friendships WHERE user_low=? AND user_high=? AND status='pending'").get(low, high) as { requester_id: string } | undefined;
      if (!existing || existing.requester_id === viewerId) fail('NOT_FOUND', 'There is no request to answer.');
      // Same rule as request(): a request left over from before either person changed school cannot become a
      // friendship neither of them could start now, so accepting it drops it instead.
      const schools = this.db.prepare('SELECT school_id FROM users WHERE id IN (?,?)').all(low, high) as { school_id: string | null }[];
      const sameSchool = schools.length === 2 && schools[0]!.school_id !== null && schools[0]!.school_id === schools[1]!.school_id;
      if (accept && sameSchool && !this.hidden(viewerId, otherId)) {
        this.db.prepare("UPDATE friendships SET status='accepted', responded_at=? WHERE user_low=? AND user_high=?").run(now(), low, high);
        return 'friends';
      }
      this.db.prepare('DELETE FROM friendships WHERE user_low=? AND user_high=?').run(low, high);
      return accept ? 'stale' : 'none';
    }).immediate();
    // Thrown after the commit, so the stale request stays deleted.
    if (state === 'stale') fail('NOT_FOUND', 'This request is no longer available. You two are no longer at the same school.');
    return state;
  }
  /** Removes a friendship or withdraws a pending request. Access to shared classes ends at once. */
  remove(viewerId: string, otherId: string): FriendState {
    this.service.ready(viewerId);
    const [low, high] = pair(viewerId, otherId);
    this.db.prepare('DELETE FROM friendships WHERE user_low=? AND user_high=?').run(low, high);
    return 'none';
  }

  /* ---------- Safety ---------- */

  block(viewerId: string, otherId: string, blocked: boolean): void {
    this.service.ready(viewerId);
    if (otherId === viewerId) fail('BAD_REQUEST', 'You cannot block yourself.');
    if (!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(otherId)) fail('NOT_FOUND', 'This member is not available.');
    this.db.transaction(() => {
      if (blocked) {
        this.db.prepare('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(viewerId, otherId, now());
        const [low, high] = pair(viewerId, otherId);
        this.db.prepare('DELETE FROM friendships WHERE user_low=? AND user_high=?').run(low, high);
      } else this.db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(viewerId, otherId);
    }).immediate();
  }
  report(viewerId: string, raw: z.infer<typeof reportSchema>): void {
    const viewer = this.service.ready(viewerId);
    const input = reportSchema.parse(raw);
    if (input.userId === viewerId) fail('BAD_REQUEST', 'You cannot report yourself.');
    const other = this.db.prepare('SELECT school_id FROM users WHERE id=?').get(input.userId) as { school_id: string | null } | undefined;
    if (!other) fail('NOT_FOUND', 'This member is not available.');
    const open = this.db.prepare('SELECT count(*) n FROM reports WHERE reporter_id=? AND resolved_at IS NULL').get(viewerId) as { n: number };
    if (open.n >= 10) fail('TOO_MANY_REQUESTS', 'You already have ten open reports. Wait for support to review them.');
    this.db.prepare('INSERT INTO reports(id,reporter_id,reported_id,school_id,reason,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), viewerId, input.userId, other.school_id ?? viewer.schoolId, input.reason, now());
  }

  /* ---------- Support (owner only) ---------- */

  verificationRequests(adminId: string) {
    this.service.admin(adminId);
    return this.db.prepare(`SELECT r.id, r.user_id userId, r.school_id schoolId, r.proof, r.created_at createdAt, u.display_name displayName, u.full_name fullName, u.email, s.name schoolName
      FROM verification_requests r JOIN users u ON u.id=r.user_id JOIN schools s ON s.id=r.school_id WHERE r.resolved_at IS NULL ORDER BY r.created_at`).all() as
      { id: string; userId: string; schoolId: string; proof: string; createdAt: string; displayName: string; fullName: string; email: string; schoolName: string }[];
  }
  decideVerification(adminId: string, requestId: string, approve: boolean): void {
    this.service.admin(adminId);
    const banned = this.db.transaction(() => {
      const request = this.db.prepare('SELECT user_id, school_id FROM verification_requests WHERE id=? AND resolved_at IS NULL').get(requestId) as { user_id: string; school_id: string } | undefined;
      if (!request) fail('NOT_FOUND', 'This request was already handled.');
      // A ban clears the student's verification, so a request left open from before the removal is declined, never approved.
      const banned = approve && this.isBanned(request.user_id, request.school_id);
      this.db.prepare('UPDATE verification_requests SET resolved_at=?, decision=?, actor_id=? WHERE id=?').run(now(), approve && !banned ? 'approved' : 'declined', adminId, requestId);
      if (approve && !banned) this.db.prepare('INSERT OR IGNORE INTO school_verifications(user_id,school_id,method,actor_id,verified_at) VALUES(?,?,?,?,?)').run(request.user_id, request.school_id, 'support', adminId, now());
      return banned;
    }).immediate();
    // Thrown after the commit, so the stale request stays closed.
    if (banned) fail('CONFLICT', 'This student was removed from this school, so the request was declined.');
  }
  revokeVerification(adminId: string, userId: string, schoolId: string): void {
    this.service.admin(adminId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM school_verifications WHERE user_id=? AND school_id=?').run(userId, schoolId);
      this.withdrawProposals(userId, schoolId);
    }).immediate();
  }
  /** Open reports, danger first, then oldest first. Chat reports carry a snapshot size but never message text. */
  reports(adminId: string): ReportSummary[] {
    this.service.admin(adminId);
    const rows = this.db.prepare(`SELECT r.id, r.reason, r.created_at createdAt, r.school_id schoolId, s.name schoolName,
        r.reported_id reportedId, ru.display_name reportedName, ru.email reportedEmail, r.reporter_id reporterId, pu.display_name reporterName,
        (r.thread_id IS NOT NULL OR r.group_id IS NOT NULL) isChat, r.category, coalesce(json_array_length(r.evidence), 0) evidenceCount,
        (SELECT count(*) FROM reports h WHERE h.reported_id=r.reported_id) historyReports,
        (SELECT count(*) FROM audit_log a WHERE a.action='member.remove' AND json_extract(a.detail, '$.userId')=r.reported_id) historyRemovals,
        (SELECT count(*) FROM audit_log a WHERE a.action='chat.pause' AND json_extract(a.detail, '$.userId')=r.reported_id) historyPauses,
        p.user_id pausedId, p.until pausedUntil, p.reason pausedReason,
        EXISTS (SELECT 1 FROM support_requests a WHERE a.user_id=r.reported_id AND a.kind='appeal:pause' AND a.resolved_at IS NULL) pausedAppealed
      FROM reports r JOIN users ru ON ru.id=r.reported_id JOIN users pu ON pu.id=r.reporter_id LEFT JOIN schools s ON s.id=r.school_id
      LEFT JOIN chat_pauses p ON p.user_id=r.reported_id AND (p.until IS NULL OR p.until>?)
      WHERE r.resolved_at IS NULL ORDER BY CASE WHEN r.category='danger' THEN 0 ELSE 1 END, r.created_at, r.id`).all(now()) as
      (Omit<ReportSummary, 'isChat' | 'history' | 'pause'> & { isChat: number; historyReports: number; historyRemovals: number; historyPauses: number; pausedId: string | null; pausedUntil: string | null; pausedReason: string | null; pausedAppealed: number })[];
    return rows.map(({ isChat, historyReports, historyRemovals, historyPauses, pausedId, pausedUntil, pausedReason, pausedAppealed, ...row }) => ({
      ...row, isChat: !!isChat, history: { reports: historyReports, removals: historyRemovals, pauses: historyPauses },
      pause: pausedId ? { until: pausedUntil, reason: pausedReason ?? '', appealed: !!pausedAppealed } : null,
    }));
  }
  resolveReport(adminId: string, reportId: string, outcome: 'dismissed' | 'removed'): void {
    this.service.admin(adminId);
    this.db.prepare('UPDATE reports SET resolved_at=?, actor_id=?, outcome=? WHERE id=? AND resolved_at IS NULL').run(now(), adminId, outcome, reportId);
  }
  /**
   * Support removal: the member leaves the school, loses their verification and any open verification request there,
   * and cannot rejoin. Every friendship they have ends, at any school, which closes all of their chats (docs/CHAT.md D4).
   */
  removeFromSchool(adminId: string, userId: string, schoolId: string, reason: string): void {
    this.service.admin(adminId);
    const text = z.string().trim().min(3).max(2000).parse(reason);
    this.db.transaction(() => {
      const user = this.db.prepare('SELECT school_id FROM users WHERE id=?').get(userId) as { school_id: string | null } | undefined;
      if (!user) fail('NOT_FOUND', 'Member not found.');
      this.db.prepare('INSERT OR REPLACE INTO school_bans(school_id,user_id,actor_id,reason,created_at) VALUES(?,?,?,?,?)').run(schoolId, userId, adminId, text, now());
      this.db.prepare('DELETE FROM school_verifications WHERE user_id=? AND school_id=?').run(userId, schoolId);
      this.db.prepare("UPDATE verification_requests SET resolved_at=?, decision='declined', actor_id=? WHERE user_id=? AND school_id=? AND resolved_at IS NULL").run(now(), adminId, userId, schoolId);
      this.withdrawProposals(userId, schoolId);
      this.db.prepare('DELETE FROM friendships WHERE user_low=? OR user_high=?').run(userId, userId);
      // Their friend groups end too (docs/CHAT.md §12): a group admin hands over to the longest-standing member.
      leaveAllGroups(this.db, userId, now());
      this.db.prepare("UPDATE reports SET resolved_at=?, actor_id=?, outcome='removed' WHERE reported_id=? AND resolved_at IS NULL").run(now(), adminId, userId);
      if (user.school_id === schoolId) this.db.prepare('UPDATE users SET school_id=NULL, reviewed_version=NULL WHERE id=?').run(userId);
      this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)').run(adminId, 'member.remove', schoolId, JSON.stringify({ userId, reason: text }), now());
    }).immediate();
  }
  isBanned(userId: string, schoolId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM school_bans WHERE school_id=? AND user_id=?').get(schoolId, userId);
  }
  /** Summary counts for the workspace payload. */
  summary(userId: string): { verification: Verification; incomingRequests: number; friendCount: number; classmates: Classmate[]; unreadChats: number; unreadAt: string; chatPush: boolean } {
    const verification = this.verification(userId);
    const incoming = this.db.prepare("SELECT count(*) n FROM friendships WHERE status='pending' AND requester_id<>? AND (user_low=? OR user_high=?)").get(userId, userId, userId) as { n: number };
    const friends = this.db.prepare("SELECT count(*) n FROM friendships WHERE status='accepted' AND (user_low=? OR user_high=?)").get(userId, userId) as { n: number };
    const classmates = this.classmates(userId);
    // Same SQL as chat.inbox. It does not call ready(), so students still onboarding get 0. unreadAt is the
    // server's clock when the count was computed, so the client keeps whichever count is newest.
    const unreadChats = countUnreadChats(this.db, userId);
    const unreadAt = new Date().toISOString();
    const chatPush = (this.db.prepare('SELECT chat_push FROM users WHERE id=?').get(userId) as { chat_push: number } | undefined)?.chat_push !== 0;
    return { verification, incomingRequests: incoming.n, friendCount: friends.n, classmates, unreadChats, unreadAt, chatPush };
  }
  /**
   * Each accepted friend at the viewer's current school with their personal timetable, so the viewer's own timetable
   * can compare actual meetings on a date. A friendship survives a school change, but period ids repeat across schools
   * ("p1", "A"), so a friend at another school never shares a class with the viewer.
   */
  classmates(userId: string): Classmate[] {
    const rows = this.db.prepare(`SELECT u.id, u.display_name FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END
      JOIN users me ON me.id=?
      WHERE f.status='accepted' AND (f.user_low=? OR f.user_high=?) AND me.school_id IS NOT NULL AND u.school_id=me.school_id
      ORDER BY u.display_name COLLATE NOCASE`).all(userId, userId, userId, userId) as { id: string; display_name: string }[];
    return rows.map(row => ({ id: row.id, displayName: row.display_name, personal: this.personalOf(row.id) }));
  }
}
