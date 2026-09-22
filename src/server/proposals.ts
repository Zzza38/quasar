import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { scheduleSchema, type Schedule } from '@/domain/schedule';
import type { Service } from './service';
import { CommunityService } from './community';

/**
 * Schedule-change voting for locked schools.
 *
 * - Proposals exist only for member-locked schools (10 or more members). Smaller schools edit directly.
 * - Voters must be verified members of the school. The proposer votes "for" automatically.
 * - A proposal passes when "for" votes reach the threshold and outnumber "against" votes. The threshold is
 *   max(3, 20% of verified members), capped at 25. The mirror rule rejects a proposal.
 * - Passing applies a new unapproved school revision unless support locked the schedule. Support-locked
 *   schools move the proposal to "awaiting support", and only the owner can publish it.
 * - A proposal is superseded when the school revision changes underneath it.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'TOO_MANY_REQUESTS';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();

export const proposalCreateSchema = z.object({ schoolId: z.uuid(), baseVersion: z.number().int().positive(), schedule: scheduleSchema, summary: z.string().trim().min(10).max(1000) });
export const voteSchema = z.object({ proposalId: z.uuid(), vote: z.enum(['for', 'against']) });
export type ProposalStatus = 'open' | 'passed' | 'rejected' | 'withdrawn' | 'superseded' | 'awaiting-support' | 'declined';
export type Proposal = {
  id: string; schoolId: string; proposerId: string; proposerName: string; baseVersion: number; schedule: Schedule; summary: string;
  status: ProposalStatus; createdAt: string; closedAt: string | null; votesFor: number; votesAgainst: number; threshold: number; myVote: 'for' | 'against' | null;
};
type Row = { id: string; school_id: string; proposer_id: string; proposer_name: string; base_version: number; schedule: string; summary: string; status: ProposalStatus; created_at: string; closed_at: string | null; votes_for: number; votes_against: number; my_vote: 'for' | 'against' | null };

export function voteThreshold(verifiedMembers: number): number { return Math.min(25, Math.max(3, Math.ceil(verifiedMembers * 0.2))); }

export class ProposalService {
  private readonly community: CommunityService;
  constructor(private readonly service: Service) { this.community = new CommunityService(service); }
  private get db() { return this.service.db; }
  private verifiedMembers(schoolId: string): number {
    return (this.db.prepare('SELECT count(*) n FROM users u JOIN school_verifications v ON v.user_id=u.id AND v.school_id=u.school_id WHERE u.school_id=?').get(schoolId) as { n: number }).n;
  }
  private rows(where: string, params: unknown[], viewerId: string): Proposal[] {
    const rows = this.db.prepare(`SELECT p.*, u.display_name proposer_name,
        (SELECT count(*) FROM proposal_votes v WHERE v.proposal_id=p.id AND v.vote='for') votes_for,
        (SELECT count(*) FROM proposal_votes v WHERE v.proposal_id=p.id AND v.vote='against') votes_against,
        (SELECT vote FROM proposal_votes v WHERE v.proposal_id=p.id AND v.user_id=?) my_vote
      FROM schedule_proposals p JOIN users u ON u.id=p.proposer_id WHERE ${where} ORDER BY p.created_at DESC LIMIT 50`).all(viewerId, ...params) as Row[];
    const thresholds = new Map<string, number>();
    return rows.map(row => {
      if (!thresholds.has(row.school_id)) thresholds.set(row.school_id, voteThreshold(this.verifiedMembers(row.school_id)));
      return { id: row.id, schoolId: row.school_id, proposerId: row.proposer_id, proposerName: row.proposer_name, baseVersion: row.base_version, schedule: JSON.parse(row.schedule), summary: row.summary,
        status: row.status, createdAt: row.created_at, closedAt: row.closed_at, votesFor: row.votes_for, votesAgainst: row.votes_against, threshold: thresholds.get(row.school_id)!, myVote: row.my_vote };
    });
  }
  /** Proposals for the viewer's school: open ones first, then recent closed ones. */
  list(viewerId: string): { proposals: Proposal[]; canVote: boolean; canPropose: boolean; verifiedMembers: number; threshold: number } {
    const user = this.service.ready(viewerId);
    if (!user.schoolId) return fail('BAD_REQUEST', 'Join a school first.');
    const school = this.service.school(user.schoolId);
    this.supersede(school.id, school.version);
    const verified = this.community.isVerified(viewerId, school.id);
    const locked = school.memberLocked || school.memberCount >= 10;
    const verifiedMembers = this.verifiedMembers(school.id);
    return { proposals: this.rows('p.school_id=?', [school.id], viewerId), canVote: verified && locked, canPropose: verified && locked, verifiedMembers, threshold: voteThreshold(verifiedMembers) };
  }
  private supersede(schoolId: string, version: number) {
    this.db.prepare("UPDATE schedule_proposals SET status='superseded', closed_at=? WHERE school_id=? AND status IN ('open','awaiting-support') AND base_version<>?").run(now(), schoolId, version);
  }
  create(viewerId: string, raw: z.infer<typeof proposalCreateSchema>): Proposal {
    const user = this.service.ready(viewerId);
    const input = proposalCreateSchema.parse(raw);
    return this.db.transaction(() => {
      const school = this.service.school(input.schoolId);
      if (user.schoolId !== school.id) fail('FORBIDDEN', 'Only school members can propose changes.');
      if (!(school.memberLocked || school.memberCount >= 10)) fail('BAD_REQUEST', 'This school is small enough to edit directly. Use “Edit shared schedule”.');
      if (!this.community.isVerified(viewerId, school.id)) fail('FORBIDDEN', 'Verify your school membership before proposing changes.');
      if (school.version !== input.baseVersion) fail('CONFLICT', 'The school schedule changed. Reload and build your proposal on the latest revision.');
      this.supersede(school.id, school.version);
      const mine = this.db.prepare("SELECT count(*) n FROM schedule_proposals WHERE school_id=? AND proposer_id=? AND status='open'").get(school.id, viewerId) as { n: number };
      if (mine.n >= 1) fail('CONFLICT', 'You already have an open proposal. Withdraw it before proposing another change.');
      const open = this.db.prepare("SELECT count(*) n FROM schedule_proposals WHERE school_id=? AND status='open'").get(school.id) as { n: number };
      if (open.n >= 5) fail('TOO_MANY_REQUESTS', 'Five proposals are already open for this school. Vote on those first.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO schedule_proposals(id,school_id,proposer_id,base_version,schedule,summary,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, school.id, viewerId, school.version, JSON.stringify(input.schedule), input.summary, 'open', now());
      this.db.prepare('INSERT INTO proposal_votes(proposal_id,user_id,vote,created_at) VALUES(?,?,?,?)').run(id, viewerId, 'for', now());
      this.tally(id);
      return this.rows('p.id=?', [id], viewerId)[0]!;
    })();
  }
  vote(viewerId: string, raw: z.infer<typeof voteSchema>): Proposal {
    const user = this.service.ready(viewerId);
    const input = voteSchema.parse(raw);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT school_id, status FROM schedule_proposals WHERE id=?').get(input.proposalId) as { school_id: string; status: ProposalStatus } | undefined;
      if (!row || user.schoolId !== row.school_id) fail('NOT_FOUND', 'Proposal not found.');
      const school = this.service.school(row.school_id);
      this.supersede(school.id, school.version);
      const current = this.db.prepare('SELECT status FROM schedule_proposals WHERE id=?').get(input.proposalId) as { status: ProposalStatus };
      if (current.status !== 'open') fail('CONFLICT', 'Voting on this proposal has closed.');
      if (!this.community.isVerified(viewerId, school.id)) fail('FORBIDDEN', 'Only verified members of the school can vote.');
      this.db.prepare('INSERT INTO proposal_votes(proposal_id,user_id,vote,created_at) VALUES(?,?,?,?) ON CONFLICT(proposal_id,user_id) DO UPDATE SET vote=excluded.vote, created_at=excluded.created_at').run(input.proposalId, viewerId, input.vote, now());
      this.tally(input.proposalId);
      return this.rows('p.id=?', [input.proposalId], viewerId)[0]!;
    })();
  }
  withdraw(viewerId: string, proposalId: string): void {
    this.service.ready(viewerId);
    const changed = this.db.prepare("UPDATE schedule_proposals SET status='withdrawn', closed_at=? WHERE id=? AND proposer_id=? AND status='open'").run(now(), proposalId, viewerId);
    if (!changed.changes) fail('NOT_FOUND', 'There is no open proposal of yours to withdraw.');
  }
  /** Counts votes after every change. Runs inside the caller's transaction. */
  private tally(proposalId: string): void {
    const row = this.db.prepare(`SELECT p.*, (SELECT count(*) FROM proposal_votes v WHERE v.proposal_id=p.id AND v.vote='for') votes_for,
      (SELECT count(*) FROM proposal_votes v WHERE v.proposal_id=p.id AND v.vote='against') votes_against FROM schedule_proposals p WHERE p.id=?`).get(proposalId) as Row;
    if (row.status !== 'open') return;
    const threshold = voteThreshold(this.verifiedMembers(row.school_id));
    if (row.votes_for >= threshold && row.votes_for > row.votes_against) this.pass(row);
    else if (row.votes_against >= threshold && row.votes_against >= row.votes_for) this.db.prepare("UPDATE schedule_proposals SET status='rejected', closed_at=? WHERE id=?").run(now(), row.id);
  }
  private pass(row: Row): void {
    const school = this.service.school(row.school_id);
    if (school.version !== row.base_version) { this.db.prepare("UPDATE schedule_proposals SET status='superseded', closed_at=? WHERE id=?").run(now(), row.id); return; }
    if (school.supportLocked) { this.db.prepare("UPDATE schedule_proposals SET status='awaiting-support' WHERE id=?").run(row.id); return; }
    this.apply(row, school.version, row.proposer_id, false);
  }
  private apply(row: Row, expectedVersion: number, actorId: string, keepApproval: boolean): void {
    const school = this.service.school(row.school_id);
    if (school.version !== expectedVersion) fail('CONFLICT', 'The school schedule changed. Review the proposal against the latest revision.');
    this.db.prepare('UPDATE schools SET schedule=?, version=version+1, approved=? WHERE id=?').run(row.schedule, keepApproval ? Number(school.approved) : 0, school.id);
    this.db.prepare('INSERT INTO school_revisions VALUES(?,?,?,?,?)').run(school.id, school.version + 1, row.schedule, actorId, now());
    this.db.prepare("UPDATE schedule_proposals SET status='passed', closed_at=?, actor_id=? WHERE id=?").run(now(), actorId, row.id);
    this.db.prepare("UPDATE schedule_proposals SET status='superseded', closed_at=? WHERE school_id=? AND id<>? AND status IN ('open','awaiting-support')").run(now(), school.id, row.id);
    this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)').run(actorId, 'school.proposalApplied', school.id, JSON.stringify({ proposalId: row.id, fromVersion: school.version }), now());
  }

  /* ---------- Support ---------- */

  awaitingSupport(adminId: string): Proposal[] {
    this.service.admin(adminId);
    return this.rows("p.status='awaiting-support'", [], adminId);
  }
  /** Owner publishes a passed proposal on a support-locked school (approval and lock are retained) or declines it. */
  decide(adminId: string, proposalId: string, publish: boolean): void {
    this.service.admin(adminId);
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM schedule_proposals WHERE id=? AND status=?').get(proposalId, 'awaiting-support') as Row | undefined;
      if (!row) fail('NOT_FOUND', 'This proposal is no longer awaiting support.');
      if (publish) this.apply(row, row.base_version, adminId, true);
      else this.db.prepare("UPDATE schedule_proposals SET status='declined', closed_at=?, actor_id=? WHERE id=?").run(now(), adminId, proposalId);
    })();
  }
}
