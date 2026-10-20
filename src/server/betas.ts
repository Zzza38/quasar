import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { betaCodeSchema, betaDiagnosticsSchema, betaKeySchema, betaRequestKind, type StoredBetaDiagnostics } from '@/domain/betas';
import { betaForCode, betaRegistryPath, currentBetaRegistry, type BetaDefinition, type BetaRegistry } from './beta-registry';
import type { Service } from './service';

/**
 * Betas (README "Running a beta"). Which betas exist, and their codes, come from the beta list beside the database
 * (src/server/beta-registry.ts), written by `npm run beta`. A member who types a beta's code in Account joins it, and
 * the code paths behind useBeta()/<Beta> turn on for them on every device. Leaving is one tap and needs no code.
 * Feedback about a beta lands in the support inbox as kind 'beta:<key>' with diagnostics.
 */

type FailCode = 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'TOO_MANY_REQUESTS';
const fail = (code: FailCode, message: string): never => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();

/** Wrong codes an account may type in BETA_GUESS_WINDOW_MS before joining is refused for a while. */
export const BETA_GUESS_LIMIT = 5;
export const BETA_GUESS_WINDOW_MS = 10 * 60_000;
export const WRONG_CODE_MESSAGE = 'That code doesn’t match an open beta. Check it and try again.';

export const betaJoinSchema = z.object({ code: betaCodeSchema });
export const betaLeaveSchema = z.object({ key: betaKeySchema });
export const betaFeedbackSchema = z.object({ key: betaKeySchema, message: z.string().trim().min(10).max(5000), diagnostics: betaDiagnosticsSchema });
export const betaMemberSchema = z.object({ key: betaKeySchema, userId: z.uuid() });

/** What a member sees of a beta they are in. */
export type JoinedBeta = { key: string; name: string; description: string; joinedAt: string };

/** The build that is serving requests (`.next/BUILD_ID`), stamped on beta reports so a report names the code it was about. */
let buildId: string | undefined;
function currentBuild(): string {
  if (buildId === undefined) {
    try { buildId = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || 'unknown'; } catch { buildId = 'development'; }
  }
  return buildId;
}

export class BetaService {
  /** `registry` is read per call, so a change to the beta list applies to the next request. Tests pass their own. */
  constructor(private readonly service: Service, private readonly registry: () => BetaRegistry = () => currentBetaRegistry()) {}
  private get db() { return this.service.db; }
  private beta(key: string): BetaDefinition | undefined { return this.registry().betas.find(beta => beta.key === key); }

  /**
   * The betas the member is in, for the workspace (useBeta reads it on the client). Memberships of a beta that is no
   * longer in the list (removed, its key retired) are left in the table but ignored.
   */
  joined(userId: string): JoinedBeta[] {
    const rows = this.db.prepare('SELECT beta_key key, joined_at joinedAt FROM beta_members WHERE user_id=? ORDER BY joined_at').all(userId) as { key: string; joinedAt: string }[];
    return rows.flatMap(row => { const beta = this.beta(row.key); return beta ? [{ key: beta.key, name: beta.name, description: beta.description, joinedAt: row.joinedAt }] : []; });
  }

  /**
   * Joins the beta whose code this is. Wrong codes count against BETA_GUESS_LIMIT (recorded in audit_log, which the
   * limit only counts). A paused or full beta says so instead of claiming the code is wrong. Joining twice is a no-op.
   */
  join(userId: string, raw: z.infer<typeof betaJoinSchema>): JoinedBeta[] {
    this.service.user(userId);
    const { code } = betaJoinSchema.parse(raw);
    // A wrong code is answered after the transaction commits, so the guess it records counts.
    const result = this.db.transaction((): { joined: JoinedBeta[] } | { error: string } => {
      const since = new Date(Date.now() - BETA_GUESS_WINDOW_MS).toISOString();
      const guesses = this.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='beta.wrongCode' AND created_at>?").get(userId, since) as { n: number };
      if (guesses.n >= BETA_GUESS_LIMIT) fail('TOO_MANY_REQUESTS', 'Too many wrong codes. Wait ten minutes and try again.');
      const beta = betaForCode(this.registry(), code);
      if (!beta) {
        this.service.audit(userId, 'beta.wrongCode', null, {});
        return { error: WRONG_CODE_MESSAGE };
      }
      if (this.db.prepare('SELECT 1 FROM beta_members WHERE beta_key=? AND user_id=?').get(beta.key, userId)) return { joined: this.joined(userId) };
      if (!beta.open) fail('CONFLICT', `${beta.name} isn’t taking new testers right now.`);
      const members = this.db.prepare('SELECT count(*) n FROM beta_members WHERE beta_key=?').get(beta.key) as { n: number };
      if (beta.maxMembers !== null && members.n >= beta.maxMembers) fail('CONFLICT', `${beta.name} is full.`);
      this.db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(beta.key, userId, now());
      this.service.audit(userId, 'beta.join', null, { key: beta.key });
      return { joined: this.joined(userId) };
    }).immediate();
    if ('error' in result) return fail('BAD_REQUEST', result.error);
    return result.joined;
  }

  /** Leaves one beta. No code: a member stuck in a broken beta must always be able to get out. */
  leave(userId: string, key: string): JoinedBeta[] {
    this.service.user(userId);
    if (this.db.prepare('DELETE FROM beta_members WHERE beta_key=? AND user_id=?').run(key, userId).changes) this.service.audit(userId, 'beta.leave', null, { key });
    return this.joined(userId);
  }

  /** Leaves every beta: the crash screen's button and `/?beta=off`. */
  leaveAll(userId: string): JoinedBeta[] {
    this.service.user(userId);
    const keys = (this.db.prepare('SELECT beta_key FROM beta_members WHERE user_id=?').pluck().all(userId) as string[]);
    if (keys.length) {
      this.db.prepare('DELETE FROM beta_members WHERE user_id=?').run(userId);
      this.service.audit(userId, 'beta.leave', null, { keys });
    }
    return [];
  }

  /** Feedback about a beta the member is in. Shares the five-open-requests limit with every other support request. */
  feedback(userId: string, raw: z.infer<typeof betaFeedbackSchema>): void {
    const user = this.service.user(userId);
    const input = betaFeedbackSchema.parse(raw);
    if (!this.beta(input.key) || !this.db.prepare('SELECT 1 FROM beta_members WHERE beta_key=? AND user_id=?').get(input.key, userId)) fail('BAD_REQUEST', 'You’re not in that beta any more.');
    const open = this.db.prepare('SELECT count(*) n FROM support_requests WHERE user_id=? AND resolved_at IS NULL').get(userId) as { n: number };
    if (open.n >= 5) fail('TOO_MANY_REQUESTS', 'You already have five open requests. Wait for support to review them.');
    const detail: StoredBetaDiagnostics = { ...input.diagnostics, build: currentBuild() };
    this.db.prepare('INSERT INTO support_requests(id,school_id,user_id,message,created_at,kind,detail) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), user.schoolId, userId, input.message, now(), betaRequestKind(input.key), JSON.stringify(detail));
  }

  /* ---------- Owner (/admin → Betas): read the list and remove a member. Betas are created with `npm run beta`. ---------- */

  /** Every beta in the list with its code (the owner shares it), members and open feedback, plus where the list lives. */
  list(adminId: string) {
    this.service.admin(adminId);
    const members = this.db.prepare(`SELECT m.user_id userId, u.email, u.display_name displayName, m.joined_at joinedAt FROM beta_members m JOIN users u ON u.id=m.user_id
      WHERE m.beta_key=? ORDER BY m.joined_at`);
    const feedback = this.db.prepare('SELECT count(*) n FROM support_requests WHERE kind=? AND resolved_at IS NULL');
    return { path: betaRegistryPath(), betas: this.registry().betas.map(beta => ({
      ...beta,
      members: members.all(beta.key) as { userId: string; email: string; displayName: string; joinedAt: string }[],
      openFeedback: (feedback.get(betaRequestKind(beta.key)) as { n: number }).n,
    })) };
  }

  removeMember(adminId: string, raw: z.infer<typeof betaMemberSchema>): void {
    this.service.admin(adminId);
    const input = betaMemberSchema.parse(raw);
    if (!this.db.prepare('DELETE FROM beta_members WHERE beta_key=? AND user_id=?').run(input.key, input.userId).changes) fail('NOT_FOUND', 'That member already left the beta.');
    this.service.audit(adminId, 'beta.removeMember', null, { key: input.key, userId: input.userId });
  }
}
