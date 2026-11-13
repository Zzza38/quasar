import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CommunityService } from './community';
import { voteThreshold } from './proposals';
import { AVATAR_MAX_BYTES, AVATAR_MIMES, imageBytesMatch, schoolLogoUrl, type Service } from './service';

/**
 * School logos. A school shows its initials until it has a logo, and the school's own members decide what it is.
 *
 * - In a school that votes on schedule changes (member-locked, 10 or more members) a verified member proposes a
 *   picture and verified members vote, with the schedule proposals' rule: it passes when "for" votes reach the
 *   threshold and outnumber "against" votes, and it is rejected when "against" votes reach the threshold and at least
 *   equal "for" votes. Counts include only voters who are still verified members. A logo that passes is published at
 *   once; nobody approves it first.
 * - A smaller school has too few members to vote, so a member's logo is published as soon as they add it, the same
 *   way members of a small school edit its schedule directly.
 * - Staff overrule any of it. With `proposals` they force a vote to win (a vote still open, or one that already lost)
 *   or force an open vote to lose. With `schools.edit` they set or remove a logo directly, and revert the last change.
 * - A logo staff chose is locked: while it shows, a member's new logo is a request to support, not a vote. Only its
 *   proposer and staff see a request, and staff approve or decline it with `force`. Staff chose a logo when they set
 *   it directly or approved a request. Setting one also deletes the school's logo votes (proposals that are not
 *   requests, with their votes), keeping only proposals that were once the school's logo. The lock lifts when staff
 *   remove the logo, revert to one the school chose, or force a vote to win.
 *
 * Every logo a school has had is kept in `school_logo_history`, which is what reverting walks back through: the
 * newest entry is marked reverted and the one before it shows again, or the initials when there is none. Publishing
 * a logo supersedes the school's other open proposals. Pictures are PNG, WebP or JPEG only (never SVG,
 * which can carry scripts), capped like profile pictures, and served by /api/school-logos.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'TOO_MANY_REQUESTS';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();

export const LOGO_MAX_BYTES = AVATAR_MAX_BYTES;
const pictureShape = { mime: z.enum(AVATAR_MIMES), data: z.string().max(Math.ceil(LOGO_MAX_BYTES * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Choose an image file.') };
export const logoProposeSchema = z.object({ schoolId: z.uuid(), ...pictureShape });
export const logoVoteSchema = z.object({ proposalId: z.uuid(), vote: z.enum(['for', 'against']) });
export const logoSetSchema = z.object({ schoolId: z.uuid(), ...pictureShape });

/**
 * `requested` is a request waiting for support, `declined` a vote staff forced to lose or a request they turned down,
 * and `reverted` a published logo staff took back.
 */
export type LogoProposalStatus = 'open' | 'requested' | 'published' | 'rejected' | 'withdrawn' | 'declined' | 'superseded' | 'reverted';
/** Staff can force a logo to win while it waits or after it lost. A withdrawn logo is its proposer's to bring back. */
const WINNABLE: readonly LogoProposalStatus[] = ['open', 'requested', 'rejected', 'declined', 'superseded', 'reverted'];
/** Still waiting: for the school's vote, or for support. */
const PENDING = "('open','requested')";
export type LogoProposal = {
  id: string; schoolId: string; schoolName: string; proposerId: string; proposerName: string; image: string; status: LogoProposalStatus;
  createdAt: string; closedAt: string | null; votesFor: number; votesAgainst: number; threshold: number; myVote: 'for' | 'against' | null;
  /** A staff member decided this one: forced it to win or lose, or reverted it. */
  byStaff: boolean;
  /** A request to support, made while the school's logo was locked. It never has votes. */
  request: boolean;
};
type Row = { id: string; school_id: string; school_name: string; proposer_id: string; proposer_name: string; status: LogoProposalStatus; created_at: string; closed_at: string | null;
  tally_threshold: number | null; actor_id: string | null; request: number; votes_for: number; votes_against: number; my_vote: 'for' | 'against' | null };

const countedVotes = (vote: 'for' | 'against') => `(SELECT count(*) FROM school_logo_votes v JOIN users vu ON vu.id=v.user_id AND vu.school_id=p.school_id
  JOIN school_verifications vs ON vs.user_id=v.user_id AND vs.school_id=p.school_id WHERE v.proposal_id=p.id AND v.vote='${vote}')`;
/** An open proposal counts current verified members; a closed one keeps the counts that decided it. */
const shownVotes = (vote: 'for' | 'against') => `CASE WHEN p.status='open' THEN ${countedVotes(vote)} ELSE coalesce(p.tally_${vote}, 0) END`;

function picture(input: { mime: string; data: string }): Buffer {
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length) fail('BAD_REQUEST', 'Choose an image file.');
  if (bytes.length > LOGO_MAX_BYTES) fail('BAD_REQUEST', 'That picture is too large. Choose a smaller one.');
  if (!imageBytesMatch(bytes, input.mime)) fail('BAD_REQUEST', 'Choose a PNG, WebP or JPEG image.');
  return bytes;
}

export class SchoolLogoService {
  private readonly community: CommunityService;
  constructor(private readonly service: Service) { this.community = new CommunityService(service); }
  private get db() { return this.service.db; }
  private verifiedMembers(schoolId: string): number {
    return (this.db.prepare('SELECT count(*) n FROM users u JOIN school_verifications v ON v.user_id=u.id AND v.school_id=u.school_id WHERE u.school_id=?').get(schoolId) as { n: number }).n;
  }
  private rows(where: string, params: unknown[], viewerId: string): LogoProposal[] {
    const rows = this.db.prepare(`SELECT p.id, p.school_id, s.name school_name, p.proposer_id, u.display_name proposer_name, p.status, p.created_at, p.closed_at, p.tally_threshold, p.actor_id, p.request,
        ${shownVotes('for')} votes_for, ${shownVotes('against')} votes_against,
        (SELECT vote FROM school_logo_votes v WHERE v.proposal_id=p.id AND v.user_id=?) my_vote
      FROM school_logo_proposals p JOIN users u ON u.id=p.proposer_id JOIN schools s ON s.id=p.school_id WHERE ${where}
      ORDER BY CASE WHEN p.status IN ${PENDING} THEN 0 ELSE 1 END, p.created_at DESC LIMIT 30`).all(viewerId, ...params) as Row[];
    const thresholds = new Map<string, number>();
    const live = (schoolId: string) => {
      if (!thresholds.has(schoolId)) thresholds.set(schoolId, voteThreshold(this.verifiedMembers(schoolId)));
      return thresholds.get(schoolId)!;
    };
    return rows.map((row) => ({ id: row.id, schoolId: row.school_id, schoolName: row.school_name, proposerId: row.proposer_id, proposerName: row.proposer_name, image: `/api/school-logos/proposals/${row.id}`,
      status: row.status, createdAt: row.created_at, closedAt: row.closed_at, votesFor: row.votes_for, votesAgainst: row.votes_against,
      threshold: row.status !== 'open' && row.tally_threshold !== null ? row.tally_threshold : live(row.school_id), myVote: row.my_vote, byStaff: row.actor_id !== null, request: row.request === 1 }));
  }
  private logoVersion(schoolId: string): number | null {
    const row = this.db.prepare('SELECT version FROM school_logos WHERE school_id=? AND image IS NOT NULL').get(schoolId) as { version: number } | undefined;
    return row?.version ?? null;
  }
  /** Whether this school votes on changes: the schedule proposals' rule (src/server/proposals.ts). */
  private votes(school: { memberLocked: boolean; memberCount: number }): boolean { return school.memberLocked || school.memberCount >= 10; }

  /**
   * Whether staff chose the logo the school shows now: the newest history entry that was not reverted has a picture
   * and a staff actor, and came from a direct set or an approved request (not from a vote staff forced). While it
   * shows, a member's new logo is a request to support.
   */
  private locked(schoolId: string): boolean {
    const live = this.db.prepare(`SELECT h.image IS NOT NULL has_image, h.actor_id, h.proposal_id, p.request FROM school_logo_history h
      LEFT JOIN school_logo_proposals p ON p.id=h.proposal_id WHERE h.school_id=? AND h.reverted_at IS NULL ORDER BY h.id DESC LIMIT 1`)
      .get(schoolId) as { has_image: number; actor_id: string | null; proposal_id: string | null; request: number | null } | undefined;
    return !!live && live.has_image === 1 && live.actor_id !== null && (live.proposal_id === null || live.request === 1);
  }
  /**
   * Deletes the school's logo votes: its proposals that are not requests, and their votes. A proposal that was once
   * the school's logo stays, because the history points at it and reverting can bring it back. Returns how many
   * proposals went.
   */
  private clearVotes(schoolId: string): number {
    const never = 'school_id=? AND request=0 AND NOT EXISTS (SELECT 1 FROM school_logo_history h WHERE h.proposal_id=school_logo_proposals.id)';
    this.db.prepare(`DELETE FROM school_logo_votes WHERE proposal_id IN (SELECT id FROM school_logo_proposals WHERE ${never})`).run(schoolId);
    return this.db.prepare(`DELETE FROM school_logo_proposals WHERE ${never}`).run(schoolId).changes;
  }
  private canRevert(schoolId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM school_logo_history WHERE school_id=? AND reverted_at IS NULL').get(schoolId);
  }

  /**
   * The viewer's school's logo, its open and recent proposals, and what the viewer may do. A request to support shows
   * only to its proposer and to staff who can decide it.
   */
  list(viewerId: string): { logo: string | null; proposals: LogoProposal[]; voting: boolean; locked: boolean; canPropose: boolean; canVote: boolean; canForce: boolean; canSet: boolean; canRevert: boolean; verifiedMembers: number; threshold: number } {
    const user = this.service.ready(viewerId);
    if (!user.schoolId) return fail('BAD_REQUEST', 'Join a school first.');
    const school = this.service.school(user.schoolId);
    const voting = this.votes(school);
    const verified = this.community.isVerified(viewerId, school.id);
    const verifiedMembers = this.verifiedMembers(school.id);
    const canSet = this.service.can(viewerId, 'schools.edit');
    const canForce = this.service.can(viewerId, 'proposals');
    const locked = this.locked(school.id);
    const proposals = canForce ? this.rows('p.school_id=?', [school.id], viewerId) : this.rows('p.school_id=? AND (p.request=0 OR p.proposer_id=?)', [school.id, viewerId], viewerId);
    return { logo: schoolLogoUrl(school.id, this.logoVersion(school.id)), proposals, voting, locked,
      canPropose: voting ? verified : true, canVote: !locked && voting && verified, canForce, canSet, canRevert: canSet && this.canRevert(school.id),
      verifiedMembers, threshold: voteThreshold(verifiedMembers) };
  }
  propose(viewerId: string, raw: z.infer<typeof logoProposeSchema>): LogoProposal {
    const user = this.service.ready(viewerId);
    const input = logoProposeSchema.parse(raw);
    const bytes = picture(input);
    return this.db.transaction(() => {
      const school = this.service.school(input.schoolId);
      if (user.schoolId !== school.id) fail('FORBIDDEN', 'Only school members can propose a logo.');
      const voting = this.votes(school);
      if (voting && !this.community.isVerified(viewerId, school.id)) fail('FORBIDDEN', 'Verify your school membership before proposing a logo.');
      const mine = this.db.prepare(`SELECT count(*) n FROM school_logo_proposals WHERE school_id=? AND proposer_id=? AND status IN ${PENDING}`).get(school.id, viewerId) as { n: number };
      if (mine.n >= 1) fail('CONFLICT', 'You already have a logo waiting. Withdraw it before proposing another.');
      const id = randomUUID();
      const insert = this.db.prepare('INSERT INTO school_logo_proposals(id,school_id,proposer_id,image,mime,status,request,created_at) VALUES(?,?,?,?,?,?,?,?)');
      if (this.locked(school.id)) {
        // Staff chose the logo that shows now, so this one goes to them instead of to a vote.
        insert.run(id, school.id, viewerId, bytes, input.mime, 'requested', 1, now());
        return this.rows('p.id=?', [id], viewerId)[0]!;
      }
      const waiting = this.db.prepare("SELECT count(*) n FROM school_logo_proposals WHERE school_id=? AND status='open'").get(school.id) as { n: number };
      if (waiting.n >= 3) fail('TOO_MANY_REQUESTS', 'Three logos are already being voted on for this school. Vote on those first.');
      insert.run(id, school.id, viewerId, bytes, input.mime, 'open', 0, now());
      if (voting) {
        this.db.prepare('INSERT INTO school_logo_votes(proposal_id,user_id,vote,created_at) VALUES(?,?,?,?)').run(id, viewerId, 'for', now());
        this.tally(id);
      } else this.publish(id, null);
      return this.rows('p.id=?', [id], viewerId)[0]!;
    }).immediate();
  }
  vote(viewerId: string, raw: z.infer<typeof logoVoteSchema>): LogoProposal {
    const user = this.service.ready(viewerId);
    const input = logoVoteSchema.parse(raw);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT school_id, status FROM school_logo_proposals WHERE id=?').get(input.proposalId) as { school_id: string; status: LogoProposalStatus } | undefined;
      if (!row || user.schoolId !== row.school_id) return fail('NOT_FOUND', 'Logo proposal not found.');
      if (row.status === 'requested') fail('CONFLICT', 'Support decides this logo, so there is no vote on it.');
      if (row.status !== 'open') fail('CONFLICT', 'Voting on this logo has closed.');
      if (this.locked(row.school_id)) fail('CONFLICT', 'Support chose this school’s logo, so it is not up for a vote.');
      if (!this.community.isVerified(viewerId, row.school_id)) fail('FORBIDDEN', 'Only verified members of the school can vote.');
      this.db.prepare('INSERT INTO school_logo_votes(proposal_id,user_id,vote,created_at) VALUES(?,?,?,?) ON CONFLICT(proposal_id,user_id) DO UPDATE SET vote=excluded.vote, created_at=excluded.created_at').run(input.proposalId, viewerId, input.vote, now());
      this.tally(input.proposalId);
      return this.rows('p.id=?', [input.proposalId], viewerId)[0]!;
    }).immediate();
  }
  /** The proposer takes back a logo that is still being voted on, or a request support has not answered. */
  withdraw(viewerId: string, proposalId: string): void {
    this.service.ready(viewerId);
    const changed = this.db.prepare("UPDATE school_logo_proposals SET status='withdrawn', closed_at=? WHERE id=? AND proposer_id=? AND status IN ('open','requested')").run(now(), proposalId, viewerId);
    if (!changed.changes) fail('NOT_FOUND', 'There is no open logo vote or request of yours to withdraw.');
  }
  /** Counts votes after every change. Runs inside the caller's transaction. Passing publishes the logo. */
  private tally(proposalId: string): void {
    const row = this.db.prepare(`SELECT p.school_id, p.status, ${countedVotes('for')} votes_for, ${countedVotes('against')} votes_against FROM school_logo_proposals p WHERE p.id=?`).get(proposalId) as { school_id: string; status: LogoProposalStatus; votes_for: number; votes_against: number };
    if (row.status !== 'open') return;
    const threshold = voteThreshold(this.verifiedMembers(row.school_id));
    this.db.prepare('UPDATE school_logo_proposals SET tally_for=?, tally_against=?, tally_threshold=? WHERE id=?').run(row.votes_for, row.votes_against, threshold, proposalId);
    if (row.votes_for >= threshold && row.votes_for > row.votes_against) this.publish(proposalId, null);
    else if (row.votes_against >= threshold && row.votes_against >= row.votes_for) this.db.prepare("UPDATE school_logo_proposals SET status='rejected', closed_at=? WHERE id=?").run(now(), proposalId);
  }
  /** Writes what the school shows now. The version counts up on every change, so a cached address never shows an older picture. */
  private show(schoolId: string, bytes: Buffer | null, mime: string, actorId: string | null): void {
    this.db.prepare(`INSERT INTO school_logos(school_id,image,mime,version,actor_id,updated_at) VALUES(?,?,?,1,?,?)
      ON CONFLICT(school_id) DO UPDATE SET image=excluded.image, mime=excluded.mime, version=school_logos.version+1, actor_id=excluded.actor_id, updated_at=excluded.updated_at`).run(schoolId, bytes, mime, actorId, now());
  }
  /** A new logo (or its removal, `bytes` null): shown, and added to the history that reverting walks back through. */
  private store(schoolId: string, bytes: Buffer | null, mime: string, actorId: string | null, proposalId: string | null): void {
    this.show(schoolId, bytes, mime, actorId);
    this.db.prepare('INSERT INTO school_logo_history(school_id,image,mime,proposal_id,actor_id,created_at) VALUES(?,?,?,?,?,?)').run(schoolId, bytes, mime, proposalId, actorId, now());
  }
  /** Closes whatever else is waiting, votes and requests, when the school gets a new logo. */
  private supersede(schoolId: string, exceptId: string | null): void {
    this.db.prepare(`UPDATE school_logo_proposals SET status='superseded', closed_at=? WHERE school_id=? AND id IS NOT ? AND status IN ${PENDING}`).run(now(), schoolId, exceptId);
  }
  /** Makes a proposal the school's logo. `actorId` is the staff member who forced it, or null when the school's own rule published it. */
  private publish(proposalId: string, actorId: string | null): void {
    const row = this.db.prepare('SELECT school_id, image, mime FROM school_logo_proposals WHERE id=?').get(proposalId) as { school_id: string; image: Buffer; mime: string };
    this.store(row.school_id, row.image, row.mime, actorId, proposalId);
    this.db.prepare("UPDATE school_logo_proposals SET status='published', closed_at=?, actor_id=? WHERE id=?").run(now(), actorId, proposalId);
    this.supersede(row.school_id, proposalId);
  }

  /* ---------- Support ---------- */

  /** Every logo still waiting, across all schools, oldest first: open votes staff may want to force, and requests only staff can answer. */
  openVotes(adminId: string): LogoProposal[] {
    this.service.permit(adminId, 'proposals');
    return this.rows(`p.status IN ${PENDING}`, [], adminId).reverse();
  }
  /** One school's logo and proposals for the /admin review sheet, whether or not the staff member belongs to it. */
  forSchool(adminId: string, schoolId: string): { logo: string | null; locked: boolean; canRevert: boolean; proposals: LogoProposal[] } {
    this.service.permit(adminId, 'schools.edit');
    const school = this.service.school(schoolId);
    return { logo: schoolLogoUrl(school.id, this.logoVersion(school.id)), locked: this.locked(school.id), canRevert: this.canRevert(school.id), proposals: this.rows('p.school_id=?', [school.id], adminId) };
  }
  /**
   * Staff with `proposals` force a vote, or answer a request. Winning publishes the logo whatever the count says, for
   * one still waiting or one that already lost. Losing closes an open vote or declines a request. A published logo is
   * undone with `revert`.
   */
  force(adminId: string, proposalId: string, win: boolean): void {
    this.service.permit(adminId, 'proposals');
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT id, school_id, proposer_id, status FROM school_logo_proposals WHERE id=?').get(proposalId) as { id: string; school_id: string; proposer_id: string; status: LogoProposalStatus } | undefined;
      if (!row) return fail('NOT_FOUND', 'Logo proposal not found.');
      if (win) {
        if (!WINNABLE.includes(row.status)) fail('CONFLICT', row.status === 'published' ? 'This logo was already published.' : 'Its proposer withdrew this logo.');
        this.publish(row.id, adminId);
        this.service.audit(adminId, 'school.logoForcedWin', row.school_id, { proposalId: row.id, userId: row.proposer_id, from: row.status });
      } else {
        if (row.status !== 'open' && row.status !== 'requested') fail('CONFLICT', 'Voting on this logo has closed.');
        this.db.prepare("UPDATE school_logo_proposals SET status='declined', closed_at=?, actor_id=? WHERE id=?").run(now(), adminId, row.id);
        this.service.audit(adminId, 'school.logoForcedLoss', row.school_id, { proposalId: row.id, userId: row.proposer_id, from: row.status });
      }
    }).immediate();
  }
  /**
   * Staff with `schools.edit` set a school's logo directly. It is locked from then on (see `locked`): the school's
   * logo votes are deleted, and any request still waiting is closed.
   */
  set(adminId: string, raw: z.infer<typeof logoSetSchema>): { logo: string | null } {
    this.service.permit(adminId, 'schools.edit');
    const input = logoSetSchema.parse(raw);
    const bytes = picture(input);
    return this.db.transaction(() => {
      const school = this.service.school(input.schoolId);
      this.store(school.id, bytes, input.mime, adminId, null);
      const votesDeleted = this.clearVotes(school.id);
      this.supersede(school.id, null);
      this.service.audit(adminId, 'school.logoSet', school.id, { votesDeleted });
      return { logo: schoolLogoUrl(school.id, this.logoVersion(school.id)) };
    }).immediate();
  }
  /** Staff with `schools.edit` remove a school's logo; the school shows its initials again. */
  remove(adminId: string, schoolId: string): void {
    this.service.permit(adminId, 'schools.edit');
    this.db.transaction(() => {
      const school = this.service.school(schoolId);
      if (this.logoVersion(school.id) === null) return fail('NOT_FOUND', 'This school has no logo.');
      this.store(school.id, null, '', adminId, null);
      this.service.audit(adminId, 'school.logoRemoved', school.id, {});
    }).immediate();
  }
  /**
   * Staff with `schools.edit` undo the school's last logo change, whoever made it: a vote, a member of a small school,
   * or staff. The logo before it shows again (the initials when there was none), and reverting again steps back
   * further. A proposal undone this way is marked `reverted`, and staff can still force it to win later.
   */
  revert(adminId: string, schoolId: string): { logo: string | null } {
    this.service.permit(adminId, 'schools.edit');
    return this.db.transaction(() => {
      const school = this.service.school(schoolId);
      const latest = "SELECT id, image, mime, proposal_id FROM school_logo_history WHERE school_id=? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1";
      type Entry = { id: number; image: Buffer | null; mime: string; proposal_id: string | null };
      const undone = this.db.prepare(latest).get(school.id) as Entry | undefined;
      if (!undone) return fail('NOT_FOUND', 'This school has no logo change to revert.');
      this.db.prepare('UPDATE school_logo_history SET reverted_at=? WHERE id=?').run(now(), undone.id);
      if (undone.proposal_id) this.db.prepare("UPDATE school_logo_proposals SET status='reverted', closed_at=?, actor_id=? WHERE id=? AND status='published'").run(now(), adminId, undone.proposal_id);
      const before = this.db.prepare(latest).get(school.id) as Entry | undefined;
      this.show(school.id, before?.image ?? null, before?.mime ?? '', adminId);
      // Back on a logo staff chose: it is locked again, so any vote started in between goes.
      if (this.locked(school.id)) this.clearVotes(school.id);
      this.service.audit(adminId, 'school.logoReverted', school.id, undone.proposal_id ? { proposalId: undone.proposal_id } : {});
      return { logo: schoolLogoUrl(school.id, this.logoVersion(school.id)) };
    }).immediate();
  }

  /* ---------- Pictures ---------- */

  /** The published logo's bytes for /api/school-logos/<schoolId>, or null when the school has none. */
  logoImage(schoolId: string): { bytes: Buffer; mime: string } | null {
    const row = this.db.prepare('SELECT image, mime FROM school_logos WHERE school_id=? AND image IS NOT NULL').get(schoolId) as { image: Buffer; mime: string } | undefined;
    return row ? { bytes: row.image, mime: row.mime } : null;
  }
  /**
   * A proposed logo's bytes: for members of its school (a request only for its proposer), and for staff who force
   * votes or edit schools. Null for everyone else.
   */
  proposalImage(viewerId: string, proposalId: string): { bytes: Buffer; mime: string } | null {
    const row = this.db.prepare('SELECT school_id, proposer_id, request, image, mime FROM school_logo_proposals WHERE id=?').get(proposalId) as { school_id: string; proposer_id: string; request: number; image: Buffer; mime: string } | undefined;
    if (!row) return null;
    const member = (row.request === 0 || row.proposer_id === viewerId) && (this.db.prepare('SELECT school_id FROM users WHERE id=?').get(viewerId) as { school_id: string | null } | undefined)?.school_id === row.school_id;
    if (!member && !this.service.can(viewerId, 'proposals') && !this.service.can(viewerId, 'schools.edit')) return null;
    return { bytes: row.image, mime: row.mime };
  }
}
