import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { personalScheduleSchema } from '@/domain/schedule';
import { SCHOOLOGY_BETA, SCHOOLOGY_IMPORT_PAST_DAYS, SCHOOLOGY_RETURN_PARAM, assignmentMatchKey, assignmentTask, matchSectionClass, schoologyItemKey, turnedIn, type AssignmentFields, type SchoologyAssignment } from '@/domain/schoology';
import { stampCompletion, taskSchema } from '@/domain/task';
import { classGradesFromSchoology, type ClassGrades } from '@/domain/grade-math';
import { gradeGoalSchema, planTargetSchema, type GradeGoal, type PlanTarget, type SavedGoal } from '@/domain/grade-goals';
import { BetaService } from './betas';
import { decrypt, encrypt } from './calendar';
import { readEntity, writeEntity } from './entities';
import type { Entity } from '@/domain/sync';
import type { Service } from './service';

/**
 * "Connect Schoology" behind the `schoology-grades` beta: three-legged OAuth 1.0a against Schoology's API v1, then a
 * read-only summary of the member's grades. The consumer key is one Schoology API key (SCHOOLOGY_CONSUMER_KEY and
 * SCHOOLOGY_CONSUMER_SECRET); each member approves Quasar on Schoology and we keep only their access token, encrypted
 * like calendar links. Requests are signed with PLAINTEXT, which Schoology accepts over HTTPS.
 */

const API = 'https://api.schoology.com/v1';
/** How long a started connection may sit on Schoology's approval page. */
export const SCHOOLOGY_STATE_MS = 15 * 60_000;
const REQUEST_DEADLINE_MS = 15_000;
/** Total network budget for one member, including paginated reads and turn-in checks. */
export const SCHOOLOGY_MEMBER_DEADLINE_MS = 2 * 60_000;
const syncSignal = new AsyncLocalStorage<AbortSignal>();
/** Graded sections missing from the member's section list that are looked up by id, per grade load. */
const MISSING_SECTION_LOOKUPS = 10;
/** How often the section index may be rebuilt while some imported task's assignment is still unknown. */
export const SCHOOLOGY_INDEX_EVERY_MS = 30 * 60_000;
/** Pages of 200 events or assignments read per section when indexing, and sections indexed. */
const INDEX_PAGES = 10;
const INDEX_SECTIONS = 40;

/** How often a member's assignments are read from Schoology, and how soon the Refresh button may do it again. */
export const SCHOOLOGY_SYNC_EVERY_MS = 15 * 60_000;
const FORCED_SYNC_MS = 60_000;
/** Dropboxes checked for a turn-in per sync, soonest due first. */
const SUBMISSION_CHECKS = 25;
/** Only tasks due within this many days are checked for a turn-in (and those due up to SCHOOLOGY_IMPORT_PAST_DAYS ago). */
const SUBMISSION_AHEAD_DAYS = 30;
const TASK_FIELDS = ['title', 'dueDate', 'dueTime', 'notes'] as const;

export const schoologySettingsSchema = z.object({ importAssignments: z.boolean().optional(), autoComplete: z.boolean().optional() });
export const schoologySyncSchema = z.object({ force: z.boolean().optional() });
export const gradeDetailSchema = z.object({ sectionId: z.string().regex(/^\d{1,20}$/) });
/** `force` is the Refresh button: it rereads Schoology unless the last read is under GRADEBOOK_FORCE_MS old. */
export const gradebookSchema = z.object({ force: z.boolean().optional() });
/** A member's goal for one Schoology class; `goal: null` clears it. `plan` is left as saved when it isn't sent. */
export const gradeGoalInputSchema = z.object({ sectionId: z.string().regex(/^\d{1,20}$/), goal: gradeGoalSchema.nullable(), plan: planTargetSchema.nullable().optional() });
/** How long one read of a member's gradebook answers Classes → Grades before Schoology is asked again. */
export const GRADEBOOK_FRESH_MS = 5 * 60_000;
/** The shortest gap between two rereads the Refresh button can cause, so tapping it repeatedly is one read. */
export const GRADEBOOK_FORCE_MS = 10_000;
/** Sections read per gradebook, and how many assignment lists are read at once. */
const GRADEBOOK_SECTIONS = 20;
const GRADEBOOK_PARALLEL = 4;
/** One class in Classes → Grades: its gradebook, the grade as Schoology words it, and the Quasar class it matches. */
export type GradebookClass = { detail: ClassGrades; grade: string | null; graded: number; classId: string | null };
export type Gradebook = { name: string; checkedAt: string; classes: GradebookClass[]; goals: Record<string, SavedGoal> };
type CachedGradebook = { uid: string; at: number; classes: Omit<GradebookClass, 'classId'>[]; titles: Map<string, { courseTitle: string; sectionTitle: string }> };
/**
 * Gradebooks read in the last few minutes, by member, held in this process's memory only: never written to the
 * database or disk, dropped on disconnect and when the process restarts. It keeps a tab switch or a second device
 * from rereading every class from Schoology.
 */
export type GradebookCache = { done: Map<string, CachedGradebook>; reading: Map<string, Promise<CachedGradebook>> };
const GRADEBOOKS: GradebookCache = { done: new Map(), reading: new Map() };
const GRADEBOOK_CACHE_MEMBERS = 500;

/** Whether Plus billing is on and the member has Plus. Wired to BillingService where it exists (ai-tasks branch). */
export type PlusCheck = (userId: string) => { billing: boolean; member: boolean };
type Assignment = SchoologyAssignment & { allow_dropbox?: unknown; grade_item_id?: unknown };
type Fetched = { sectionId: string; assignment: Assignment };
const dayOffset = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const sectionClassSchema = z.object({ sectionId: z.string().regex(/^\d{1,20}$/), classId: z.string().min(1).max(100).nullable().or(z.literal('auto')) });
type RawSection = { id?: unknown; course_title?: unknown; section_title?: unknown };
const text = (value: unknown) => typeof value === 'string' ? value : '';

type FailCode = 'BAD_REQUEST' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'SERVICE_UNAVAILABLE' | 'UNAUTHORIZED';
const fail = (code: FailCode, message: string): never => { throw new TRPCError({ code, message }); };

export type SchoologyFetch = (url: string, init: RequestInit) => Promise<Response>;
/** `api` is set only when SCHOOLOGY_API_URL points somewhere else (the browser tests' stand-in); otherwise Schoology's own API. */
export type SchoologyConfig = { key: string; secret: string; host: string; api?: string };
type Token = { token: string; secret: string };

/** Schoology may send the member back without the token; then the one this account started is used. */
export const schoologyFinishSchema = z.object({ oauthToken: z.string().trim().min(1).max(200).optional() });

export function schoologyConfig(env: Record<string, string | undefined> = process.env): SchoologyConfig | null {
  const key = env.SCHOOLOGY_CONSUMER_KEY?.trim(), secret = env.SCHOOLOGY_CONSUMER_SECRET?.trim();
  if (!key || !secret) return null;
  // Member tokens go wherever this points, so anything but HTTPS or this machine's own loopback is ignored.
  const api = env.SCHOOLOGY_API_URL?.trim().replace(/\/+$/, '');
  const trusted = !!api && (/^https:\/\/[^/]+/.test(api) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(api));
  return { key, secret, host: env.SCHOOLOGY_HOST?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'app.schoology.com', ...(trusted ? { api } : {}) };
}

/** The Authorization header for one request. A fresh nonce each time, as Schoology rejects a reused one. */
export function schoologyAuthorization(config: SchoologyConfig, token: Token | null): string {
  const enc = encodeURIComponent;
  const fields = {
    oauth_consumer_key: config.key, oauth_nonce: randomBytes(12).toString('hex'), oauth_signature_method: 'PLAINTEXT',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: token?.token ?? '', oauth_version: '1.0',
  };
  const signature = `${enc(config.secret)}&${enc(token?.secret ?? '')}`;
  return `OAuth realm="Schoology API", ${Object.entries(fields).map(([name, value]) => `${name}="${enc(value)}"`).join(', ')}, oauth_signature="${enc(signature)}"`;
}

export type SchoologyClass = { sectionId: string; title: string; grade: string | null; graded: number };

/** One class's grade from users/{uid}/grades: the latest grading period's final grade, and how many assignments have a score. */
export function summarizeGrades(grades: unknown, sections: unknown): SchoologyClass[] {
  const titles = new Map<string, string>();
  for (const section of (sections as { section?: { id?: unknown; course_title?: unknown; section_title?: unknown }[] })?.section ?? []) {
    const course = typeof section.course_title === 'string' ? section.course_title : '';
    const part = typeof section.section_title === 'string' ? section.section_title : '';
    titles.set(String(section.id), course && part && !course.includes(part) ? `${course}: ${part}` : course || part || 'Untitled class');
  }
  return ((grades as { section?: { section_id?: unknown; final_grade?: { grade?: unknown }[]; period?: { assignment?: { grade?: unknown }[] }[] }[] })?.section ?? []).map(section => {
    const finals = (section.final_grade ?? []).map(entry => entry.grade).filter(grade => grade !== null && grade !== undefined && grade !== '');
    const last = finals.at(-1);
    const graded = (section.period ?? []).flatMap(period => period.assignment ?? []).filter(item => item.grade !== null && item.grade !== undefined && item.grade !== '').length;
    const numeric = typeof last === 'number' || (typeof last === 'string' && /^\d+(\.\d+)?$/.test(last));
    return { sectionId: String(section.section_id), title: titles.get(String(section.section_id)) ?? 'Untitled class', grade: last === undefined ? null : numeric ? `${Math.round(Number(last) * 10) / 10}%` : String(last), graded };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

export class SchoologyService {
  constructor(
    private readonly service: Service,
    private readonly options: { config?: SchoologyConfig | null; fetcher?: SchoologyFetch; secret?: string; inBeta?: (userId: string) => boolean; origin?: string; now?: () => Date; plus?: PlusCheck; gradebooks?: GradebookCache } = {},
  ) {}
  private now(): Date { return this.options.now ? this.options.now() : new Date(); }
  private get db() { return this.service.db; }
  private config(): SchoologyConfig | null { return this.options.config === undefined ? schoologyConfig() : this.options.config; }
  private get api(): string { return this.config()?.api ?? API; }
  private requireConfig(): SchoologyConfig {
    return this.config() ?? fail('PRECONDITION_FAILED', 'Connecting Schoology is not set up on this server.');
  }
  private secret(): string {
    const secret = this.options.secret ?? process.env.NEXTAUTH_SECRET ?? '';
    if (secret.length < 32) fail('PRECONDITION_FAILED', 'Connecting Schoology is not set up on this server.');
    return secret;
  }
  private inBeta(userId: string): boolean {
    return this.options.inBeta ? this.options.inBeta(userId) : new BetaService(this.service).joined(userId).some(beta => beta.key === SCHOOLOGY_BETA);
  }
  private requireBeta(userId: string): void {
    this.service.user(userId);
    if (!this.inBeta(userId)) fail('FORBIDDEN', 'Schoology grades are in a beta. Join it in Account to use them.');
  }

  /** Sends a signed request, re-signing on each redirect (users/me answers 303 and a reused nonce is refused). */
  private async call(url: string, token: Token | null): Promise<Response> {
    syncSignal.getStore()?.throwIfAborted();
    const config = this.requireConfig();
    const fetcher = this.options.fetcher ?? fetch;
    for (let hop = 0; hop < 3; hop++) {
      syncSignal.getStore()?.throwIfAborted();
      let response: Response;
      try {
        response = await fetcher(url, { headers: { Authorization: schoologyAuthorization(config, token), Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(REQUEST_DEADLINE_MS), ...(syncSignal.getStore() ? [syncSignal.getStore()!] : [])]) });
      } catch { return fail('SERVICE_UNAVAILABLE', 'Couldn’t reach Schoology. Try again in a minute.'); }
      syncSignal.getStore()?.throwIfAborted();
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        let target: URL;
        try { target = new URL(location, url); } catch { return fail('SERVICE_UNAVAILABLE', 'Schoology sent an invalid redirect.'); }
        if (target.origin !== new URL(this.api).origin) return fail('SERVICE_UNAVAILABLE', 'Schoology redirected somewhere unexpected. Try again in a minute.');
        url = target.toString();
        continue;
      }
      return response;
    }
    return fail('SERVICE_UNAVAILABLE', 'Schoology kept redirecting. Try again in a minute.');
  }
  private async tokenFrom(response: Response, what: string): Promise<Token> {
    if (!response.ok) {
      console.error(`[schoology] ${what} returned HTTP ${response.status}`);
      fail(response.status === 401 ? 'BAD_REQUEST' : 'SERVICE_UNAVAILABLE', what === 'access_token'
        ? 'Schoology didn’t finish the connection. Make sure you approved Quasar, then try Finish connecting again.'
        : 'Schoology didn’t accept the connection. Start it again from Classes.');
    }
    const body = new URLSearchParams(await response.text());
    const token = body.get('oauth_token'), secret = body.get('oauth_token_secret');
    return token && secret ? { token, secret } : fail('SERVICE_UNAVAILABLE', 'Schoology didn’t send a token back. Try again.');
  }
  private async json(userId: string, path: string, token: Token): Promise<unknown> {
    const response = await this.call(`${this.api}/${path}`, token);
    if (response.status === 403) fail('FORBIDDEN', 'Schoology did not permit this request.');
    if (response.status === 401) {
      this.db.prepare('DELETE FROM schoology_connections WHERE user_id=?').run(userId);
      this.forgetGradebook(userId);
      fail('UNAUTHORIZED', 'Schoology no longer lets Quasar in. Connect it again.');
    }
    if (!response.ok) { console.error(`[schoology] ${path.split('?')[0].replace(/\d+/g, ':id')} returned HTTP ${response.status}`); fail('SERVICE_UNAVAILABLE', 'Schoology didn’t answer. Try again in a minute.'); }
    return response.json().catch(() => fail('SERVICE_UNAVAILABLE', 'Schoology sent something Quasar couldn’t read.'));
  }
  private connection(userId: string) {
    return this.db.prepare('SELECT token_encrypted, schoology_uid, name, connected_at, synced_at, import_assignments, auto_complete FROM schoology_connections WHERE user_id=?').get(userId) as
      { token_encrypted: string; schoology_uid: string; name: string; connected_at: string; synced_at: string | null; import_assignments: number; auto_complete: number } | undefined;
  }

  status(userId: string) {
    this.service.user(userId);
    if (!this.inBeta(userId)) return { beta: false as const };
    const row = this.connection(userId);
    const pending = this.db.prepare('SELECT created_at FROM schoology_oauth_states WHERE user_id=?').get(userId) as { created_at: string } | undefined;
    // Grade what-ifs are a Plus feature; the tag shows only while billing is on and the member isn't Plus.
    const plus = this.options.plus?.(userId) ?? { billing: false, member: false };
    return { beta: true as const, available: this.config() !== null, pendingConnection: !!pending && Date.now() - Date.parse(pending.created_at) <= SCHOOLOGY_STATE_MS, plusLocked: plus.billing && !plus.member, connected: row ? {
      name: row.name, connectedAt: row.connected_at, syncedAt: row.synced_at, importAssignments: row.import_assignments === 1, autoComplete: row.auto_complete === 1,
    } : null };
  }

  /** The two switches in the Schoology panel: add assignments as tasks, and check tasks off when they're turned in. */
  setSettings(userId: string, raw: z.input<typeof schoologySettingsSchema>) {
    this.requireBeta(userId);
    const input = schoologySettingsSchema.parse(raw);
    if (!this.connection(userId)) fail('BAD_REQUEST', 'Connect Schoology first.');
    if (input.importAssignments !== undefined) this.db.prepare('UPDATE schoology_connections SET import_assignments=? WHERE user_id=?').run(Number(input.importAssignments), userId);
    if (input.autoComplete !== undefined) this.db.prepare('UPDATE schoology_connections SET auto_complete=? WHERE user_id=?').run(Number(input.autoComplete), userId);
    return this.status(userId);
  }

  /** Step one: a request token from Schoology, kept on the server with its secret, and the page where the member approves it. */
  async start(userId: string): Promise<{ url: string }> {
    this.requireBeta(userId);
    const config = this.requireConfig();
    const origin = (this.options.origin ?? process.env.NEXTAUTH_URL ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(origin)) fail('PRECONDITION_FAILED', 'Connecting Schoology is not set up on this server.');
    const request = await this.tokenFrom(await this.call(`${this.api}/oauth/request_token`, null), 'request_token');
    this.db.prepare(`INSERT INTO schoology_oauth_states(user_id,request_token,secret_encrypted,created_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET request_token=excluded.request_token,secret_encrypted=excluded.secret_encrypted,created_at=excluded.created_at`)
      .run(userId, request.token, encrypt(request.secret, this.secret()), new Date().toISOString());
    const url = new URL(`https://${config.host}/oauth/authorize`);
    // Schoology reads `return_url`, written without the scheme ("example.com/path?query"). A full URL there, the
    // documented `oauth_callback`, or both parameters together all end on "no valid return URL found" (tried 2026-10-29).
    const back = new URL(`${origin}/classes?${SCHOOLOGY_RETURN_PARAM}=return`);
    url.search = new URLSearchParams({ oauth_token: request.token, return_url: `${back.host}${back.pathname}${back.search}` }).toString();
    return { url: url.toString() };
  }

  /** Step two, after Schoology sends the member back: swap the approved request token for an access token and read their grades. */
  async finish(userId: string, raw: z.input<typeof schoologyFinishSchema>) {
    this.requireBeta(userId);
    const input = schoologyFinishSchema.parse(raw);
    const row = this.db.prepare('SELECT request_token, secret_encrypted, created_at FROM schoology_oauth_states WHERE user_id=?').get(userId) as { request_token: string; secret_encrypted: string; created_at: string } | undefined;
    if (!row || (input.oauthToken !== undefined && row.request_token !== input.oauthToken) || Date.now() - Date.parse(row.created_at) > SCHOOLOGY_STATE_MS) {
      this.db.prepare('DELETE FROM schoology_oauth_states WHERE user_id=?').run(userId);
      fail('BAD_REQUEST', 'That Schoology connection expired. Start it again from Classes.');
    }
    let requestSecret: string;
    try { requestSecret = decrypt(row!.secret_encrypted, this.secret()); } catch { return fail('BAD_REQUEST', 'That Schoology connection expired. Start it again from Classes.'); }
    const access = await this.tokenFrom(await this.call(`${this.api}/oauth/access_token`, { token: row!.request_token, secret: requestSecret }), 'access_token');
    // A premature finish or a temporary Schoology failure must not discard the request token.
    // Match the token too, so an older response cannot erase a connection started in another tab.
    this.db.prepare('DELETE FROM schoology_oauth_states WHERE user_id=? AND request_token=?').run(userId, row!.request_token);
    const me = await this.json(userId, 'users/me', access) as { uid?: unknown; id?: unknown; name_display?: unknown; name_first?: unknown; name_last?: unknown };
    const uid = String(me.uid ?? me.id ?? '');
    if (!/^\d+$/.test(uid)) fail('SERVICE_UNAVAILABLE', 'Schoology didn’t say who you are. Try again.');
    const name = typeof me.name_display === 'string' && me.name_display ? me.name_display : [me.name_first, me.name_last].filter(part => typeof part === 'string' && part).join(' ') || 'your Schoology account';
    this.db.prepare(`INSERT INTO schoology_connections(user_id,token_encrypted,schoology_uid,name,connected_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET token_encrypted=excluded.token_encrypted,schoology_uid=excluded.schoology_uid,name=excluded.name,connected_at=excluded.connected_at`)
      .run(userId, encrypt(JSON.stringify(access), this.secret()), uid, name, new Date().toISOString());
    this.service.audit(userId, 'schoology.connect', null, {});
    this.forgetGradebook(userId);
    return this.grades(userId);
  }

  private token(userId: string, row: { token_encrypted: string }): Token {
    try { return JSON.parse(decrypt(row.token_encrypted, this.secret())) as Token; } catch { return fail('UNAUTHORIZED', 'Connect Schoology again: the saved connection can’t be read.'); }
  }

  /** The member's grades and every section they're in, including graded sections their section list leaves out. */
  private async gradesAndSections(userId: string, row: { schoology_uid: string }, token: Token, allowHiddenGrades = false): Promise<{ grades: unknown; sections: RawSection[] }> {
    const gradeRead = this.json(userId, `users/${row.schoology_uid}/grades`, token).catch(error => {
      // Schools can hide grades while still allowing assignment and submission reads.
      if (allowHiddenGrades && error instanceof TRPCError && error.code === 'FORBIDDEN') return { section: [] };
      throw error;
    });
    // Wait for both reads even when one fails, so shutdown cannot leave the other using the database.
    const reads = await Promise.allSettled([gradeRead, this.json(userId, `users/${row.schoology_uid}/sections`, token)]);
    for (const read of reads) if (read.status === 'rejected') throw read.reason;
    const [grades, listed] = reads.map(read => (read as PromiseFulfilledResult<unknown>).value);
    // A graded section can be missing from the member's section list (a linked sibling section of a listed course),
    // so look those up one by one. A failed lookup just leaves the class untitled.
    const known = new Set(((listed as { section?: { id?: unknown }[] })?.section ?? []).map(section => String(section.id)));
    const missing = [...new Set(((grades as { section?: { section_id?: unknown }[] })?.section ?? []).map(section => String(section.section_id)))]
      .filter(id => /^\d+$/.test(id) && !known.has(id)).slice(0, MISSING_SECTION_LOOKUPS);
    const extra = await Promise.all(missing.map(id => this.call(`${this.api}/sections/${id}`, token)
      .then(response => response.ok ? response.json() as Promise<unknown> : null).catch(() => null)));
    return { grades, sections: [...((listed as { section?: RawSection[] })?.section ?? []), ...(extra.filter(Boolean) as RawSection[])] };
  }

  /** The member's classes with their current grade, read live from Schoology (nothing about grades is stored). */
  async grades(userId: string): Promise<{ name: string; classes: SchoologyClass[] }> {
    this.requireBeta(userId);
    const row = this.connection(userId) ?? fail('BAD_REQUEST', 'Connect Schoology first.');
    const { grades, sections } = await this.gradesAndSections(userId, row, this.token(userId, row));
    return { name: row.name, classes: summarizeGrades(grades, { section: sections }) };
  }

  /** Every entry of a paged Schoology list, up to INDEX_PAGES pages. A refused or failed page ends the list quietly. */
  private async pages(url: string, field: string, token: Token): Promise<Record<string, unknown>[]> {
    const entries: Record<string, unknown>[] = [];
    let next: string | null = url;
    for (let page = 0; next && page < INDEX_PAGES; page++) {
      syncSignal.getStore()?.throwIfAborted();
      const response: Response | null = await this.call(next, token).catch(() => null);
      syncSignal.getStore()?.throwIfAborted();
      if (!response?.ok) break;
      const body = await response.json().catch(() => null) as { links?: { next?: unknown } } & Record<string, unknown> | null;
      entries.push(...((body?.[field] as Record<string, unknown>[] | undefined) ?? []));
      const link = body?.links?.next;
      next = typeof link === 'string' && link.startsWith(`${this.api}/`) ? link : null;
    }
    return entries;
  }

  /** The member's sections (one each, at most INDEX_SECTIONS), with their titles saved for the class picker. */
  private rememberSections(userId: string, sections: RawSection[]): string[] {
    const unique = [...new Map(sections.filter(section => /^\d{1,20}$/.test(String(section.id))).map(section => [String(section.id), section])).values()].slice(0, INDEX_SECTIONS);
    const titles = this.db.prepare(`INSERT INTO schoology_sections(user_id,section_id,course_title,section_title) VALUES(?,?,?,?)
      ON CONFLICT(user_id,section_id) DO UPDATE SET course_title=excluded.course_title,section_title=excluded.section_title`);
    this.db.transaction(() => { for (const section of unique) titles.run(userId, String(section.id), text(section.course_title).slice(0, 300), text(section.section_title).slice(0, 300)); }).immediate();
    return unique.map(section => String(section.id));
  }

  private rememberItems(userId: string, items: Map<string, string>) {
    const item = this.db.prepare('INSERT INTO schoology_items(user_id,item_key,section_id) VALUES(?,?,?) ON CONFLICT(user_id,item_key) DO UPDATE SET section_id=excluded.section_id');
    this.db.transaction(() => { for (const [key, sectionId] of items) item.run(userId, key, sectionId); }).immediate();
  }

  /**
   * One class's gradebook for the what-if tools: its grades (ungraded work included), categories and exams, with
   * titles and due dates from the section's assignment list, or from the member's own imported tasks when Schoology won't list them (a linked
   * section can refuse). Read live; nothing is stored.
   */
  async gradeDetail(userId: string, raw: z.input<typeof gradeDetailSchema>): Promise<ClassGrades> {
    this.requireBeta(userId);
    const { sectionId } = gradeDetailSchema.parse(raw);
    const row = this.connection(userId) ?? fail('BAD_REQUEST', 'Connect Schoology first.');
    const token = this.token(userId, row);
    // Not ?section_id=: filtered, Schoology leaves out every ungraded assignment, which is what the what-ifs are about.
    const [grades, assignments] = await Promise.all([
      this.json(userId, `users/${row.schoology_uid}/grades`, token),
      this.pages(`${this.api}/sections/${sectionId}/assignments?limit=200`, 'assignment', token),
    ]);
    const section = ((grades as { section?: { section_id?: unknown }[] })?.section ?? []).find(entry => String(entry.section_id) === sectionId)
      ?? fail('BAD_REQUEST', 'Schoology has no grades for that class. Refresh and try again.');
    const known = new Set(assignments.map(entry => String(entry.id)));
    const fromTasks = (this.db.prepare(`SELECT data FROM entities WHERE owner_id=? AND kind='task' AND deleted=0`).all(userId) as { data: string }[]).flatMap(({ data }) => {
      const task = JSON.parse(data) as { title?: string; dueDate?: string | null; notes?: string; imported?: { url?: string | null } };
      const key = schoologyItemKey(task);
      return key?.startsWith('assignment:') && !known.has(key.slice(11)) && typeof task.title === 'string' ? [{ id: key.slice(11), title: task.title, due: task.dueDate ?? '' }] : [];
    });
    let titles = this.db.prepare('SELECT course_title, section_title FROM schoology_sections WHERE user_id=? AND section_id=?').get(userId, sectionId) as { course_title: string; section_title: string } | undefined;
    if (!titles) {
      const found = await this.call(`${this.api}/sections/${sectionId}`, token).then(response => response.ok ? response.json() as Promise<RawSection> : null).catch(() => null);
      if (found) titles = { course_title: text(found.course_title), section_title: text(found.section_title) };
    }
    const title = titles ? [titles.course_title, titles.section_title].filter(Boolean).filter((part, index, all) => index === 0 || !all[0].includes(part)).join(': ') : '';
    return classGradesFromSchoology(section, [...assignments, ...fromTasks], title || 'Class');
  }

  private get gradebooks(): GradebookCache { return this.options.gradebooks ?? GRADEBOOKS; }
  private forgetGradebook(userId: string): void { this.gradebooks.done.delete(userId); this.gradebooks.reading.delete(userId); }

  /** Titles and due dates from the member's own imported tasks, for assignments a section won't list. */
  private taskAssignments(userId: string): { id: string; title: string; due: string }[] {
    return (this.db.prepare(`SELECT data FROM entities WHERE owner_id=? AND kind='task' AND deleted=0`).all(userId) as { data: string }[]).flatMap(({ data }) => {
      const task = JSON.parse(data) as { title?: string; dueDate?: string | null; notes?: string; imported?: { url?: string | null } };
      const key = schoologyItemKey(task);
      return key?.startsWith('assignment:') && typeof task.title === 'string' ? [{ id: key.slice(11), title: task.title, due: task.dueDate ?? '' }] : [];
    });
  }

  /** Every graded class's gradebook in one pass: the grades once, then each section's assignment list a few at a time. */
  private async readGradebook(userId: string, row: { schoology_uid: string }, token: Token): Promise<CachedGradebook> {
    const { grades, sections } = await this.gradesAndSections(userId, row, token);
    const summaries = new Map(summarizeGrades(grades, { section: sections }).map(entry => [entry.sectionId, entry]));
    const titles = new Map(sections.map(section => [String(section.id), { courseTitle: text(section.course_title), sectionTitle: text(section.section_title) }]));
    const raw = [...new Map(((grades as { section?: { section_id?: unknown }[] })?.section ?? [])
      .filter(section => /^\d{1,20}$/.test(String(section.section_id))).map(section => [String(section.section_id), section])).values()].slice(0, GRADEBOOK_SECTIONS);
    const fromTasks = this.taskAssignments(userId);
    const classes: Omit<GradebookClass, 'classId'>[] = new Array(raw.length);
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < raw.length; index = next++) {
        const sectionId = String(raw[index].section_id);
        const assignments = await this.pages(`${this.api}/sections/${sectionId}/assignments?limit=200`, 'assignment', token);
        const known = new Set(assignments.map(entry => String(entry.id)));
        const summary = summaries.get(sectionId);
        classes[index] = {
          detail: classGradesFromSchoology(raw[index], [...assignments, ...fromTasks.filter(entry => !known.has(entry.id))], summary?.title ?? 'Untitled class'),
          grade: summary?.grade ?? null, graded: summary?.graded ?? 0,
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(GRADEBOOK_PARALLEL, raw.length) }, worker));
    classes.sort((a, b) => a.detail.title.localeCompare(b.detail.title));
    return { uid: row.schoology_uid, at: this.now().getTime(), classes, titles };
  }

  private async cachedGradebook(userId: string, row: { schoology_uid: string; token_encrypted: string }, force: boolean): Promise<CachedGradebook> {
    const { done, reading } = this.gradebooks;
    const hit = done.get(userId);
    const age = hit ? this.now().getTime() - hit.at : Infinity;
    if (hit && hit.uid === row.schoology_uid && age >= 0 && age < (force ? GRADEBOOK_FORCE_MS : GRADEBOOK_FRESH_MS)) return hit;
    const running = reading.get(userId);
    if (running) return running;
    const read = this.readGradebook(userId, row, this.token(userId, row)).then(book => {
      // Still connected to the same Schoology account when the read came back, or the answer is dropped.
      if (this.connection(userId)?.schoology_uid === book.uid) {
        if (done.size >= GRADEBOOK_CACHE_MEMBERS) for (const [key, entry] of done) if (this.now().getTime() - entry.at >= GRADEBOOK_FRESH_MS) done.delete(key);
        if (done.size < GRADEBOOK_CACHE_MEMBERS) done.set(userId, book);
      }
      return book;
    }).finally(() => { if (reading.get(userId) === read) reading.delete(userId); });
    reading.set(userId, read);
    return read;
  }

  /** The member's saved goals by Schoology section. A row that no longer reads as a goal is left out. */
  private goals(userId: string): Record<string, SavedGoal> {
    const rows = this.db.prepare('SELECT section_id, goal, plan FROM schoology_grade_goals WHERE user_id=?').all(userId) as { section_id: string; goal: string | null; plan: string | null }[];
    const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, json: string | null): T | null => {
      if (!json) return null;
      try { const parsed = schema.safeParse(JSON.parse(json)); return parsed.success ? parsed.data as T : null; } catch { return null; }
    };
    const goals: Record<string, SavedGoal> = {};
    for (const entry of rows) {
      const saved = { goal: parse<GradeGoal>(gradeGoalSchema, entry.goal), plan: parse<PlanTarget>(planTargetSchema, entry.plan) };
      if (saved.goal || saved.plan) goals[entry.section_id] = saved;
    }
    return goals;
  }

  /**
   * Classes → Grades: every graded class's gradebook, read from Schoology and kept only in memory for
   * GRADEBOOK_FRESH_MS, with the member's saved goals (the one thing Quasar stores) read fresh each time.
   */
  async gradebook(userId: string, raw: z.input<typeof gradebookSchema> = {}): Promise<Gradebook> {
    this.requireBeta(userId);
    const { force } = gradebookSchema.parse(raw);
    const row = this.connection(userId) ?? fail('BAD_REQUEST', 'Connect Schoology first.');
    const book = await this.cachedGradebook(userId, row, force === true);
    const personal = this.personalClasses(userId);
    const chosen = new Map((this.db.prepare('SELECT section_id, class_id FROM schoology_sections WHERE user_id=? AND chosen=1').all(userId) as { section_id: string; class_id: string | null }[]).map(entry => [entry.section_id, entry.class_id]));
    const classFor = (sectionId: string) => {
      if (chosen.has(sectionId)) { const classId = chosen.get(sectionId); return classId && personal.some(entry => entry.id === classId) ? classId : null; }
      const titles = book.titles.get(sectionId);
      return titles ? matchSectionClass(titles, personal) : null;
    };
    return { name: row.name, checkedAt: new Date(book.at).toISOString(), goals: this.goals(userId), classes: book.classes.map(entry => ({ ...entry, classId: classFor(entry.detail.sectionId) })) };
  }

  /**
   * Saves, changes or clears (goal: null) the member's goal for one of their own Schoology classes. The class must
   * be in the gradebook Schoology gives this member, and a plan must name work or a category that class really has.
   */
  async setGoal(userId: string, raw: z.input<typeof gradeGoalInputSchema>): Promise<{ sectionId: string } & SavedGoal> {
    this.requireBeta(userId);
    const input = gradeGoalInputSchema.parse(raw);
    const row = this.connection(userId) ?? fail('BAD_REQUEST', 'Connect Schoology first.');
    const mine = (await this.cachedGradebook(userId, row, false)).classes.find(entry => entry.detail.sectionId === input.sectionId)?.detail
      ?? fail('FORBIDDEN', 'That class isn’t in your Schoology grades. Refresh and try again.');
    const plan = input.plan;
    if (plan?.kind === 'item' && !mine.items.some(item => item.id === plan.id) && !mine.exams.some(exam => exam.id === plan.id)) fail('BAD_REQUEST', 'That assignment isn’t in this class any more. Pick another one.');
    if (plan?.kind === 'extra' && !mine.categories.some(category => category.id === plan.categoryId)) fail('BAD_REQUEST', 'That category isn’t in this class any more. Pick another one.');
    const before = this.goals(userId)[input.sectionId] ?? { goal: null, plan: null };
    const next: SavedGoal = { goal: input.goal, plan: plan === undefined ? before.plan : plan };
    if (!next.goal && !next.plan) this.db.prepare('DELETE FROM schoology_grade_goals WHERE user_id=? AND section_id=?').run(userId, input.sectionId);
    else this.db.prepare(`INSERT INTO schoology_grade_goals(user_id,section_id,goal,plan,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,section_id) DO UPDATE SET goal=excluded.goal,plan=excluded.plan,updated_at=excluded.updated_at`)
      .run(userId, input.sectionId, next.goal ? JSON.stringify(next.goal) : null, next.plan ? JSON.stringify(next.plan) : null, this.now().toISOString());
    return { sectionId: input.sectionId, ...next };
  }

  /**
   * Which section every assignment and event the member can see belongs to, read section by section (Schoology has no
   * lookup by assignment id). A section that refuses (403) or fails is skipped; it never disconnects the member.
   */
  private async index(userId: string, row: { schoology_uid: string; token_encrypted: string }): Promise<void> {
    const token = this.token(userId, row);
    const items = new Map<string, string>();
    for (const id of this.rememberSections(userId, (await this.gradesAndSections(userId, row, token, true)).sections)) {
      for (const entry of await this.pages(`${this.api}/sections/${id}/events?limit=200`, 'event', token)) {
        if (/^\d{1,20}$/.test(String(entry.id))) items.set(`event:${entry.id}`, id);
        if (/^\d{1,20}$/.test(String(entry.assignment_id ?? ''))) items.set(`assignment:${entry.assignment_id}`, id);
      }
      for (const entry of await this.pages(`${this.api}/sections/${id}/assignments?limit=200`, 'assignment', token)) {
        if (/^\d{1,20}$/.test(String(entry.id))) items.set(`assignment:${entry.id}`, id);
      }
    }
    syncSignal.getStore()?.throwIfAborted();
    this.rememberItems(userId, items);
    this.db.prepare('UPDATE schoology_connections SET indexed_at=? WHERE user_id=?').run(this.now().toISOString(), userId);
  }

  /** Writes a class change Quasar made, keeping an untouched API import counted as untouched (see importAssignments). */
  private writeOwn(userId: string, entity: Entity, data: Record<string, unknown>) {
    writeEntity(this.db, userId, { ...entity, version: entity.version + 1, data });
    this.db.prepare('UPDATE schoology_imports SET written_version=? WHERE user_id=? AND entity_id=? AND written_version=?').run(entity.version + 1, userId, entity.id, entity.version);
  }

  private personalClasses(userId: string): { id: string; name: string }[] {
    const entity = readEntity(this.db, userId, 'personal');
    const parsed = entity && !entity.deleted ? personalScheduleSchema.safeParse(entity.data) : null;
    return parsed?.success ? parsed.data.classes.map(entry => ({ id: entry.id, name: entry.name })) : [];
  }

  /** Each indexed section with the class its tasks go to: the member's choice when they made one, else a name match. */
  private sectionClasses(userId: string) {
    const classes = this.personalClasses(userId);
    const rows = this.db.prepare('SELECT section_id, course_title, section_title, class_id, chosen FROM schoology_sections WHERE user_id=? ORDER BY course_title, section_title')
      .all(userId) as { section_id: string; course_title: string; section_title: string; class_id: string | null; chosen: number }[];
    return { classes, sections: rows.map(row => {
      const auto = matchSectionClass({ courseTitle: row.course_title, sectionTitle: row.section_title }, classes);
      const chosen = row.chosen === 1;
      const classId = chosen ? (row.class_id && classes.some(entry => entry.id === row.class_id) ? row.class_id : null) : auto;
      return { sectionId: row.section_id, title: [row.course_title, row.section_title].filter(Boolean).filter((part, index, all) => index === 0 || !all[0].includes(part)).join(': ') || 'Untitled class', classId, auto, chosen };
    }) };
  }

  /** Tasks from Schoology (through the calendar feed or the API) that have no class yet. */
  private untagged(userId: string): { id: string; key: string }[] {
    const rows = this.db.prepare(`SELECT id, data FROM entities WHERE owner_id=? AND kind='task' AND deleted=0
      AND json_extract(data,'$.classId') IS NULL
      AND (json_extract(data,'$.imported') IS NOT NULL OR id IN (SELECT entity_id FROM schoology_imports WHERE user_id=?))`).all(userId, userId) as { id: string; data: string }[];
    return rows.flatMap(row => {
      const key = schoologyItemKey(JSON.parse(row.data) as { notes?: string; imported?: { url?: string | null } });
      return key ? [{ id: row.id, key }] : [];
    });
  }

  /**
   * Puts the class on imported Schoology tasks that have none, from the section each one is in. Rebuilds the section
   * index at most every SCHOOLOGY_INDEX_EVERY_MS, and only while some task's assignment is unknown. Tasks change at
   * version+1 on the server, like a calendar refresh, and clients pick them up on their next sync. Quietly does
   * nothing outside the beta or without a connection, so the worker can call it for anyone.
   */
  async tagClasses(userId: string): Promise<{ tagged: number }> {
    const row = this.db.prepare('SELECT token_encrypted, schoology_uid, indexed_at FROM schoology_connections WHERE user_id=?').get(userId) as { token_encrypted: string; schoology_uid: string; indexed_at: string | null } | undefined;
    if (!row || !this.config() || !this.inBeta(userId)) return { tagged: 0 };
    const pending = this.untagged(userId);
    if (pending.length === 0) return { tagged: 0 };
    const known = this.db.prepare('SELECT 1 FROM schoology_items WHERE user_id=? AND item_key=?');
    const stale = !row.indexed_at || this.now().getTime() - Date.parse(row.indexed_at) >= SCHOOLOGY_INDEX_EVERY_MS;
    if (stale && pending.some(task => !known.get(userId, task.key))) await this.index(userId, row);
    return { tagged: this.applyTags(userId) };
  }

  private applyTags(userId: string): number {
    return this.db.transaction(() => {
      const { sections } = this.sectionClasses(userId);
      const classFor = new Map(sections.map(section => [section.sectionId, section.classId]));
      const sectionOf = this.db.prepare('SELECT section_id FROM schoology_items WHERE user_id=? AND item_key=?');
      const remember = this.db.prepare('INSERT INTO schoology_task_tags(user_id,entity_id,section_id,class_id) VALUES(?,?,?,?) ON CONFLICT(user_id,entity_id) DO UPDATE SET section_id=excluded.section_id,class_id=excluded.class_id');
      let tagged = 0;
      for (const task of this.untagged(userId)) {
        const sectionId = (sectionOf.get(userId, task.key) as { section_id: string } | undefined)?.section_id;
        const classId = sectionId ? classFor.get(sectionId) : null;
        if (!sectionId || !classId) continue;
        const entity = readEntity(this.db, userId, task.id);
        const parsed = entity && !entity.deleted ? taskSchema.safeParse({ ...entity.data, classId }) : null;
        if (!entity || !parsed?.success || entity.data.classId) continue;
        this.writeOwn(userId, entity, parsed.data);
        remember.run(userId, task.id, sectionId, classId);
        tagged++;
      }
      return tagged;
    }).immediate();
  }

  /** The sections Quasar knows about and where their tasks go, for the "Tasks from Schoology go to" list. */
  sections(userId: string) {
    this.requireBeta(userId);
    return this.sectionClasses(userId);
  }

  /**
   * The member's correction: send a section's tasks to `classId`, to no class (null), or back to the name match
   * ('auto'). Tasks this tagged that still carry the old class move with it; tasks the member changed stay put.
   */
  setSectionClass(userId: string, raw: z.input<typeof sectionClassSchema>) {
    this.requireBeta(userId);
    const input = sectionClassSchema.parse(raw);
    this.db.transaction(() => {
      const { classes, sections } = this.sectionClasses(userId);
      if (!sections.some(section => section.sectionId === input.sectionId)) fail('BAD_REQUEST', 'Quasar doesn’t know that Schoology class. Refresh and try again.');
      if (typeof input.classId === 'string' && input.classId !== 'auto' && !classes.some(entry => entry.id === input.classId)) fail('BAD_REQUEST', 'That class was removed. Pick another one.');
      if (input.classId === 'auto') this.db.prepare('UPDATE schoology_sections SET class_id=NULL, chosen=0 WHERE user_id=? AND section_id=?').run(userId, input.sectionId);
      else this.db.prepare('UPDATE schoology_sections SET class_id=?, chosen=1 WHERE user_id=? AND section_id=?').run(input.classId, userId, input.sectionId);
      const next = this.sectionClasses(userId).sections.find(section => section.sectionId === input.sectionId)!.classId;
      const tags = this.db.prepare('SELECT entity_id, class_id FROM schoology_task_tags WHERE user_id=? AND section_id=?').all(userId, input.sectionId) as { entity_id: string; class_id: string }[];
      for (const tag of tags) {
        if (tag.class_id === next) continue;
        const entity = readEntity(this.db, userId, tag.entity_id);
        if (!entity || entity.deleted || entity.data.classId !== tag.class_id) { this.db.prepare('DELETE FROM schoology_task_tags WHERE user_id=? AND entity_id=?').run(userId, tag.entity_id); continue; }
        const parsed = taskSchema.safeParse({ ...entity.data, classId: next });
        if (!parsed.success) continue;
        this.writeOwn(userId, entity, parsed.data);
        if (next) this.db.prepare('UPDATE schoology_task_tags SET class_id=? WHERE user_id=? AND entity_id=?').run(next, userId, tag.entity_id);
        else this.db.prepare('DELETE FROM schoology_task_tags WHERE user_id=? AND entity_id=?').run(userId, tag.entity_id);
      }
    }).immediate();
    this.applyTags(userId);
    return this.sectionClasses(userId);
  }

  /**
   * Everything Schoology keeps up to date, for the open app and the worker: reads the member's assignments (at most
   * every SCHOOLOGY_SYNC_EVERY_MS, or a minute apart for the Refresh button), adds the ones the calendar feed doesn't
   * bring as tasks, checks off tasks whose assignment was turned in, then puts classes on untagged imports. Returns
   * how many tasks changed, so the caller knows to sync. Quietly does nothing outside the beta or without a connection.
   * One member has a two-minute network budget; worker shutdown aborts its requests and waits for this work to settle.
   */
  async sync(userId: string, raw: z.input<typeof schoologySyncSchema> = {}, signal?: AbortSignal): Promise<{ changed: number }> {
    const deadline = AbortSignal.timeout(SCHOOLOGY_MEMBER_DEADLINE_MS);
    return syncSignal.run(signal ? AbortSignal.any([signal, deadline]) : deadline, () => this.syncMember(userId, raw));
  }

  private async syncMember(userId: string, raw: z.input<typeof schoologySyncSchema>): Promise<{ changed: number }> {
    syncSignal.getStore()?.throwIfAborted();
    const { force } = schoologySyncSchema.parse(raw);
    const row = this.connection(userId);
    if (!row || !this.config() || !this.inBeta(userId)) return { changed: 0 };
    let changed = 0;
    const since = row.synced_at ? this.now().getTime() - Date.parse(row.synced_at) : Infinity;
    if ((row.import_assignments === 1 || row.auto_complete === 1) && since >= (force ? FORCED_SYNC_MS : SCHOOLOGY_SYNC_EVERY_MS)) {
      // Claimed before reading, so two open tabs don't both read Schoology.
      this.db.prepare('UPDATE schoology_connections SET synced_at=? WHERE user_id=?').run(this.now().toISOString(), userId);
      const token = this.token(userId, row);
      const fetched: Fetched[] = [];
      const { grades, sections } = await this.gradesAndSections(userId, row, token, true);
      const graded = new Set<string>();
      for (const section of (grades as { section?: { period?: { assignment?: { assignment_id?: unknown; grade?: unknown }[] }[] }[] })?.section ?? []) {
        for (const item of (section.period ?? []).flatMap(period => period.assignment ?? [])) if (item.grade !== null && item.grade !== undefined && item.grade !== '') graded.add(String(item.assignment_id));
      }
      for (const sectionId of this.rememberSections(userId, sections)) {
        for (const assignment of await this.pages(`${this.api}/sections/${sectionId}/assignments?limit=200`, 'assignment', token)) {
          if (/^\d{1,20}$/.test(String(assignment.id))) fetched.push({ sectionId, assignment });
        }
      }
      syncSignal.getStore()?.throwIfAborted();
      this.rememberItems(userId, new Map(fetched.map(entry => [`assignment:${entry.assignment.id}`, entry.sectionId])));
      if (row.import_assignments === 1) changed += this.importAssignments(userId, fetched, graded);
      if (row.auto_complete === 1) changed += await this.checkTurnIns(userId, row.schoology_uid, fetched, token);
    }
    syncSignal.getStore()?.throwIfAborted();
    changed += (await this.tagClasses(userId)).tagged;
    return { changed };
  }

  /**
   * Adds assignments as tasks (entity `sgy_<assignment id>`) unless the calendar feed already brought them, matched by
   * the assignment link or by title and due date. Later reads update a field only while it still holds what Schoology
   * last said, so the member's edits stay. A task the member deleted isn't brought back, and an untouched one is
   * removed if the feed brings the same assignment later. Past-due assignments that already have a grade are skipped.
   */
  private importAssignments(userId: string, fetched: Fetched[], graded: ReadonlySet<string>): number {
    const today = this.now().toISOString().slice(0, 10);
    return this.db.transaction(() => {
      const fed = this.db.prepare(`SELECT data FROM entities WHERE owner_id=? AND kind='task' AND deleted=0 AND json_extract(data,'$.imported') IS NOT NULL`).all(userId) as { data: string }[];
      const fedKeys = new Set<string>(), fedMatches = new Set<string>();
      for (const { data } of fed) {
        const task = JSON.parse(data) as { title?: string; dueDate?: string | null; notes?: string; imported?: { url?: string | null } };
        const key = schoologyItemKey(task);
        if (key) fedKeys.add(key);
        if (typeof task.title === 'string') fedMatches.add(assignmentMatchKey(task.title, task.dueDate ?? null));
      }
      const fromFeed = (id: string, fields: AssignmentFields) => fedKeys.has(`assignment:${id}`) || fedMatches.has(assignmentMatchKey(fields.title, fields.dueDate));
      const importRow = this.db.prepare('SELECT entity_id, source, written_version FROM schoology_imports WHERE user_id=? AND assignment_id=?');
      const saveRow = this.db.prepare(`INSERT INTO schoology_imports(user_id,assignment_id,entity_id,section_id,source,written_version) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id,assignment_id) DO UPDATE SET section_id=excluded.section_id,source=excluded.source,written_version=excluded.written_version`);
      let changed = 0;
      for (const { sectionId, assignment } of fetched) {
        const id = String(assignment.id);
        const fields = assignmentTask(assignment, today);
        if (!fields) continue;
        const existing = importRow.get(userId, id) as { entity_id: string; source: string; written_version: number } | undefined;
        if (!existing) {
          // Already past due and graded means it's done: not a task to add.
          if (fromFeed(id, fields) || (graded.has(id) && fields.dueDate !== null && fields.dueDate < today) || readEntity(this.db, userId, `sgy_${id}`)) continue;
          const data = taskSchema.parse({ ...fields, classId: null, completed: false });
          writeEntity(this.db, userId, { id: `sgy_${id}`, kind: 'task', version: 1, data, deleted: false });
          saveRow.run(userId, id, `sgy_${id}`, sectionId, JSON.stringify(fields), 1);
          changed++;
          continue;
        }
        const entity = readEntity(this.db, userId, existing.entity_id);
        const untouched = entity?.version === existing.written_version;
        let written = existing.written_version;
        if (entity && !entity.deleted && untouched && fromFeed(id, fields)) {
          written = entity.version + 1;
          writeEntity(this.db, userId, { ...entity, version: written, deleted: true, data: {} });
          changed++;
        } else if (entity && !entity.deleted) {
          const before = JSON.parse(existing.source) as Partial<AssignmentFields>;
          const data: Record<string, unknown> = { ...entity.data };
          for (const field of TASK_FIELDS) if (entity.data[field] === before[field] && fields[field] !== before[field]) data[field] = fields[field];
          const parsed = TASK_FIELDS.some(field => data[field] !== entity.data[field]) ? taskSchema.safeParse(data) : null;
          if (parsed?.success) {
            writeEntity(this.db, userId, { ...entity, version: entity.version + 1, data: parsed.data });
            if (untouched) written = entity.version + 1;
            changed++;
          }
        }
        saveRow.run(userId, id, existing.entity_id, sectionId, JSON.stringify(fields), written);
      }
      return changed;
    }).immediate();
  }

  /**
   * Checks off open tasks whose assignment was turned in on Schoology (a non-draft dropbox revision). Each assignment
   * is acted on once: a task the member reopens stays open. Checks at most SUBMISSION_CHECKS dropboxes, soonest due
   * first, among tasks due from SCHOOLOGY_IMPORT_PAST_DAYS ago to SUBMISSION_AHEAD_DAYS ahead or with no due date.
   */
  private async checkTurnIns(userId: string, uid: string, fetched: Fetched[], token: Token): Promise<number> {
    const today = this.now().toISOString().slice(0, 10);
    const from = dayOffset(today, -SCHOOLOGY_IMPORT_PAST_DAYS), to = dayOffset(today, SUBMISSION_AHEAD_DAYS);
    const byId = new Map(fetched.map(entry => [String(entry.assignment.id), entry]));
    const open = this.db.prepare(`SELECT id, data FROM entities WHERE owner_id=? AND kind='task' AND deleted=0 AND json_extract(data,'$.completed') = 0`).all(userId) as { id: string; data: string }[];
    const handled = this.db.prepare("SELECT submitted FROM schoology_items WHERE user_id=? AND item_key=?");
    const tasksFor = new Map<string, string[]>();
    for (const row of open) {
      const task = JSON.parse(row.data) as { dueDate?: string | null; notes?: string; imported?: { url?: string | null } };
      const key = schoologyItemKey(task);
      if (!key?.startsWith('assignment:')) continue;
      const entry = byId.get(key.slice('assignment:'.length));
      if (!entry || String(entry.assignment.allow_dropbox) !== '1' || !/^\d{1,20}$/.test(String(entry.assignment.grade_item_id ?? ''))) continue;
      if (task.dueDate && (task.dueDate < from || task.dueDate > to)) continue;
      if ((handled.get(userId, key) as { submitted: number } | undefined)?.submitted === 1) continue;
      tasksFor.set(key, [...(tasksFor.get(key) ?? []), row.id]);
    }
    const due = (key: string) => String(byId.get(key.slice('assignment:'.length))!.assignment.due || '9999');
    const keys = [...tasksFor.keys()].sort((a, b) => due(a).localeCompare(due(b))).slice(0, SUBMISSION_CHECKS);
    let changed = 0;
    for (const key of keys) {
      const { sectionId, assignment } = byId.get(key.slice('assignment:'.length))!;
      const response = await this.call(`${this.api}/sections/${sectionId}/submissions/${assignment.grade_item_id}/${uid}`, token).catch(() => null);
      if (!response?.ok || !turnedIn(await response.json().catch(() => null))) continue;
      syncSignal.getStore()?.throwIfAborted();
      changed += this.db.transaction(() => {
        this.db.prepare(`INSERT INTO schoology_items(user_id,item_key,section_id,submitted) VALUES(?,?,?,1)
          ON CONFLICT(user_id,item_key) DO UPDATE SET submitted=1`).run(userId, key, sectionId);
        let done = 0;
        for (const id of tasksFor.get(key)!) {
          const entity = readEntity(this.db, userId, id);
          if (!entity || entity.deleted || entity.data.completed === true) continue;
          const parsed = taskSchema.safeParse(stampCompletion({ ...entity.data, completed: true }, entity.data, this.now()));
          if (!parsed.success) continue;
          writeEntity(this.db, userId, { ...entity, version: entity.version + 1, data: parsed.data });
          done++;
        }
        return done;
      }).immediate();
    }
    return changed;
  }

  /** The worker's pass over every connected member (each one quietly skipped outside the beta). */
  async tagAll(signal?: AbortSignal): Promise<{ failed: number }> {
    let failed = 0;
    for (const { user_id: userId } of this.db.prepare('SELECT user_id FROM schoology_connections').all() as { user_id: string }[]) {
      if (signal?.aborted) break;
      try { await this.sync(userId, {}, signal); } catch { if (!signal?.aborted) failed++; }
    }
    return { failed };
  }

  disconnect(userId: string) {
    this.service.user(userId);
    this.db.prepare('DELETE FROM schoology_connections WHERE user_id=?').run(userId);
    this.db.prepare('DELETE FROM schoology_oauth_states WHERE user_id=?').run(userId);
    this.forgetGradebook(userId);
    // Grade goals, section choices, the assignment index, imports and turn-ins seen all stay, so reconnecting doesn't duplicate tasks
    // or check off again ones the member reopened.
    this.service.audit(userId, 'schoology.disconnect', null, {});
    return this.status(userId);
  }
}
