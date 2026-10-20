import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { betaCodeSchema, betaDiagnosticsSchema, betaKeySchema, betaRequestKind, normalizeBetaCode, type StoredBetaDiagnostics } from '@/domain/betas';
import type { Service } from './service';

/**
 * Betas (README "Running a beta"). The owner creates a beta with a join code on /admin; a member who types the code
 * in Account joins it, and the code paths behind useBeta()/<Beta> turn on for them on every device. Leaving is one
 * tap and needs no code. Feedback about a beta lands in the support inbox as kind 'beta:<key>' with diagnostics.
 *
 * Only a SHA-256 of each code is stored, so the owner sees a code once, when it is set; "New code" replaces it.
 */

type FailCode = 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'TOO_MANY_REQUESTS';
const fail = (code: FailCode, message: string): never => { throw new TRPCError({ code, message }); };
const now = () => new Date().toISOString();
const hashCode = (code: string) => createHash('sha256').update(normalizeBetaCode(code)).digest('hex');

/** Wrong codes an account may type in BETA_GUESS_WINDOW_MS before joining is refused for a while. */
export const BETA_GUESS_LIMIT = 5;
export const BETA_GUESS_WINDOW_MS = 10 * 60_000;
export const WRONG_CODE_MESSAGE = 'That code doesn’t match an open beta. Check it and try again.';

export const betaJoinSchema = z.object({ code: betaCodeSchema });
export const betaLeaveSchema = z.object({ key: betaKeySchema });
export const betaFeedbackSchema = z.object({ key: betaKeySchema, message: z.string().trim().min(10).max(5000), diagnostics: betaDiagnosticsSchema });
const maxMembersSchema = z.number().int().min(1).max(100_000).nullable();
const betaDetailsSchema = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(500) });
export const betaCreateSchema = betaDetailsSchema.extend({ key: betaKeySchema, code: betaCodeSchema, maxMembers: maxMembersSchema });
export const betaUpdateSchema = betaDetailsSchema.extend({ key: betaKeySchema, open: z.boolean(), maxMembers: maxMembersSchema });
export const betaCodeChangeSchema = z.object({ key: betaKeySchema, code: betaCodeSchema });
export const betaMemberSchema = z.object({ key: betaKeySchema, userId: z.uuid() });

/** What a member sees of a beta they are in. */
export type JoinedBeta = { key: string; name: string; description: string; joinedAt: string };
type BetaRow = { key: string; name: string; description: string; code_hash: string; open: number; max_members: number | null; created_at: string };

/** The build that is serving requests (`.next/BUILD_ID`), stamped on beta reports so a report names the code it was about. */
let buildId: string | undefined;
function currentBuild(): string {
  if (buildId === undefined) {
    try { buildId = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || 'unknown'; } catch { buildId = 'development'; }
  }
  return buildId;
}

export class BetaService {
  constructor(private readonly service: Service) {}
  private get db() { return this.service.db; }

  /** The betas the member is in, for the workspace (useBeta reads it on the client). */
  joined(userId: string): JoinedBeta[] {
    return this.db.prepare(`SELECT b.key, b.name, b.description, m.joined_at joinedAt FROM beta_members m JOIN betas b ON b.key=m.beta_key
      WHERE m.user_id=? ORDER BY m.joined_at`).all(userId) as JoinedBeta[];
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
      const beta = this.db.prepare('SELECT * FROM betas WHERE code_hash=?').get(hashCode(code)) as BetaRow | undefined;
      if (!beta) {
        this.service.audit(userId, 'beta.wrongCode', null, {});
        return { error: WRONG_CODE_MESSAGE };
      }
      if (this.db.prepare('SELECT 1 FROM beta_members WHERE beta_key=? AND user_id=?').get(beta.key, userId)) return { joined: this.joined(userId) };
      if (!beta.open) fail('CONFLICT', `${beta.name} isn’t taking new testers right now.`);
      const members = this.db.prepare('SELECT count(*) n FROM beta_members WHERE beta_key=?').get(beta.key) as { n: number };
      if (beta.max_members !== null && members.n >= beta.max_members) fail('CONFLICT', `${beta.name} is full.`);
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
    const keys = this.joined(userId).map(beta => beta.key);
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
    if (!this.db.prepare('SELECT 1 FROM beta_members WHERE beta_key=? AND user_id=?').get(input.key, userId)) fail('BAD_REQUEST', 'You’re not in that beta any more.');
    const open = this.db.prepare('SELECT count(*) n FROM support_requests WHERE user_id=? AND resolved_at IS NULL').get(userId) as { n: number };
    if (open.n >= 5) fail('TOO_MANY_REQUESTS', 'You already have five open requests. Wait for support to review them.');
    const detail: StoredBetaDiagnostics = { ...input.diagnostics, build: currentBuild() };
    this.db.prepare('INSERT INTO support_requests(id,school_id,user_id,message,created_at,kind,detail) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), user.schoolId, userId, input.message, now(), betaRequestKind(input.key), JSON.stringify(detail));
  }

  /* ---------- Owner (/admin → Betas). Every change is audited. ---------- */

  list(adminId: string) {
    this.service.admin(adminId);
    const members = this.db.prepare(`SELECT m.user_id userId, u.email, u.display_name displayName, m.joined_at joinedAt FROM beta_members m JOIN users u ON u.id=m.user_id
      WHERE m.beta_key=? ORDER BY m.joined_at`);
    const feedback = this.db.prepare('SELECT count(*) n FROM support_requests WHERE kind=? AND resolved_at IS NULL');
    return (this.db.prepare('SELECT * FROM betas ORDER BY created_at DESC').all() as BetaRow[]).map(row => ({
      key: row.key, name: row.name, description: row.description, open: !!row.open, maxMembers: row.max_members, createdAt: row.created_at,
      members: members.all(row.key) as { userId: string; email: string; displayName: string; joinedAt: string }[],
      openFeedback: (feedback.get(betaRequestKind(row.key)) as { n: number }).n,
    }));
  }

  create(adminId: string, raw: z.infer<typeof betaCreateSchema>): void {
    this.service.admin(adminId);
    const input = betaCreateSchema.parse(raw);
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM betas WHERE key=?').get(input.key)) fail('CONFLICT', 'A beta with that key already exists.');
      this.assertCodeFree(input.code);
      this.db.prepare('INSERT INTO betas(key,name,description,code_hash,open,max_members,created_at,created_by) VALUES(?,?,?,?,1,?,?,?)')
        .run(input.key, input.name, input.description, hashCode(input.code), input.maxMembers, now(), adminId);
      this.service.audit(adminId, 'beta.create', null, { key: input.key, name: input.name, maxMembers: input.maxMembers });
    }).immediate();
  }

  /** Renames, pauses or reopens joining, or changes the member limit. Members already in stay in. */
  update(adminId: string, raw: z.infer<typeof betaUpdateSchema>): void {
    this.service.admin(adminId);
    const input = betaUpdateSchema.parse(raw);
    const changed = this.db.prepare('UPDATE betas SET name=?, description=?, open=?, max_members=? WHERE key=?').run(input.name, input.description, input.open ? 1 : 0, input.maxMembers, input.key).changes;
    if (!changed) fail('NOT_FOUND', 'That beta no longer exists.');
    this.service.audit(adminId, 'beta.update', null, { key: input.key, name: input.name, open: input.open, maxMembers: input.maxMembers });
  }

  /** A new code for a leaked or forgotten one. The old code stops working; members stay in. */
  changeCode(adminId: string, raw: z.infer<typeof betaCodeChangeSchema>): void {
    this.service.admin(adminId);
    const input = betaCodeChangeSchema.parse(raw);
    this.db.transaction(() => {
      this.assertCodeFree(input.code, input.key);
      if (!this.db.prepare('UPDATE betas SET code_hash=? WHERE key=?').run(hashCode(input.code), input.key).changes) fail('NOT_FOUND', 'That beta no longer exists.');
      this.service.audit(adminId, 'beta.changeCode', null, { key: input.key });
    }).immediate();
  }

  /** Ends a beta: deletes it and drops every member. Its feedback stays in the inbox. */
  close(adminId: string, key: string): void {
    this.service.admin(adminId);
    this.db.transaction(() => {
      const members = this.db.prepare('SELECT count(*) n FROM beta_members WHERE beta_key=?').get(key) as { n: number };
      if (!this.db.prepare('DELETE FROM betas WHERE key=?').run(key).changes) fail('NOT_FOUND', 'That beta no longer exists.');
      this.service.audit(adminId, 'beta.close', null, { key, members: members.n });
    }).immediate();
  }

  removeMember(adminId: string, raw: z.infer<typeof betaMemberSchema>): void {
    this.service.admin(adminId);
    const input = betaMemberSchema.parse(raw);
    if (!this.db.prepare('DELETE FROM beta_members WHERE beta_key=? AND user_id=?').run(input.key, input.userId).changes) fail('NOT_FOUND', 'That member already left the beta.');
    this.service.audit(adminId, 'beta.removeMember', null, { key: input.key, userId: input.userId });
  }

  /** One code opens one beta, so the same code can't be given to two. */
  private assertCodeFree(code: string, exceptKey?: string): void {
    const holder = this.db.prepare('SELECT key FROM betas WHERE code_hash=?').get(hashCode(code)) as { key: string } | undefined;
    if (holder && holder.key !== exceptKey) fail('CONFLICT', 'Another beta already uses that code. Pick a different one.');
  }
}
