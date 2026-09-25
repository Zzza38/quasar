import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { dateSchema } from '@/domain/schedule';
import { menuApiBase, menuChoiceName, menuPageUrl, menuSiteSchema, menuSourceSchema, menuWeekStart, parseMenuChoices, parseMenuSite, parseMenuWeek, type MenuChoice, type MenuDay, type MenuSource } from '@/domain/menu';
import type { Service, School } from './service';

/** A cached week is served as is for this long; after it the next request fetches again (and keeps the copy if that fails). */
export const MENU_CACHE_MS = 3 * 60 * 60 * 1000;
/** Weeks older than this are dropped from the cache whenever a week is stored. */
const MENU_KEEP_DAYS = 60;
const MAX_MENU_BYTES = 2 * 1024 * 1024;
/** Menu lookups and changes each fetch from the provider, so an account gets this many per hour. */
export const MENU_ACTION_LIMIT = 30;
export const menuSetSchema = z.object({ schoolId: z.uuid(), source: menuSiteSchema.extend({ school: menuSourceSchema.shape.school, menu: menuSourceSchema.shape.menu }).nullable() });
export const menuLookupSchema = z.object({ url: z.string().trim().min(1).max(2000) });
export const menuWeekSchema = z.object({ date: dateSchema });

export type MenuWeek =
  | { source: MenuSource & { url: string }; weekStart: string; days: MenuDay[]; fetchedAt: string; stale: boolean }
  | { source: null };
export type MenuLookup = { site: { org: string; domain: MenuSource['domain'] }; choices: MenuChoice[]; suggested: string | null };
type FetchJson = (url: string) => Promise<unknown>;

const PROVIDER_DOWN = 'Couldn’t reach the menu site right now. Try again in a few minutes.';
const fail = (code: 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'TOO_MANY_REQUESTS' | 'BAD_GATEWAY', message: string): never => { throw new TRPCError({ code, message }); };

/**
 * GET a JSON document from the menu provider. The hostname is always `{slug}.api.{supported domain}` (see
 * parseMenuSite), so this never reaches a private address; redirects are refused all the same, and the time and
 * body size are bounded like a calendar fetch.
 */
export async function fetchMenuJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Quasar-Menu/1.0' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch { throw new Error(PROVIDER_DOWN); }
  if (response.status !== 200) throw new Error(`The menu site returned HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_MENU_BYTES) throw new Error('The menu is too large to load.');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_MENU_BYTES) throw new Error('The menu is too large to load.');
  try { return JSON.parse(body.toString('utf8')); } catch { throw new Error('The menu site answered in a form Quasar does not understand.'); }
}

const weekUrl = (source: MenuSource, weekStart: string): string => {
  const [year, month, day] = weekStart.split('-');
  return `${menuApiBase(source)}/menu/api/weeks/school/${source.school}/menu-type/${source.menu}/${year}/${month}/${day}/?format=json`;
};

export class MenuService {
  constructor(private service: Service, private fetchJson: FetchJson = fetchMenuJson, private clock: () => Date = () => new Date()) {}
  private get db() { return this.service.db; }

  /** The menu a school follows, or null when none is set (or an older build stored something unreadable). */
  source(schoolId: string): MenuSource | null {
    const row = this.db.prepare('SELECT menu_source FROM schools WHERE id=?').get(schoolId) as { menu_source: string } | undefined;
    if (!row?.menu_source) return null;
    try { return menuSourceSchema.parse(JSON.parse(row.menu_source)); } catch { return null; }
  }

  /**
   * Who may point the school at a menu: the owner always, and any member while the shared schedule is open to
   * member edits (the same rule as Service.updateSchool). A locked school's members send a correction request.
   */
  canEdit(userId: string, school: School): boolean {
    if (this.service.isAdmin(userId)) return true;
    if (this.service.user(userId).schoolId !== school.id) return false;
    return !school.memberLocked && !school.supportLocked && school.memberCount < 10;
  }
  private editableSchool(userId: string, schoolId: string): School {
    this.service.ready(userId);
    const school = this.service.school(schoolId);
    if (!this.canEdit(userId, school)) fail('FORBIDDEN', school.memberLocked || school.supportLocked || school.memberCount >= 10 ? 'This school’s menu is locked. Send a correction request to support.' : 'Only school members can change the lunch menu.');
    return school;
  }
  private limit(userId: string): void {
    const since = new Date(this.clock().getTime() - 3600_000).toISOString();
    const { n } = this.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action IN ('menu.lookup','school.menu') AND created_at > ?").get(userId, since) as { n: number };
    if (n >= MENU_ACTION_LIMIT) fail('TOO_MANY_REQUESTS', 'Too many menu lookups for now. Try again in an hour.');
  }
  private audit(userId: string, action: string, schoolId: string, detail: unknown): void {
    this.service.audit(userId, action, schoolId, detail, this.clock().toISOString());
  }
  private async choices(site: { org: string; domain: MenuSource['domain'] }): Promise<MenuChoice[]> {
    let payload: unknown;
    try { payload = await this.fetchJson(`${menuApiBase(site)}/menu/api/schools/?format=json`); }
    catch (error) { return fail('BAD_GATEWAY', error instanceof Error && error.message ? error.message : PROVIDER_DOWN); }
    return parseMenuChoices(payload);
  }

  /** The menus published on the site an address belongs to, for the picker; `suggested` is the one the address itself names. */
  async lookup(userId: string, schoolId: string, raw: z.infer<typeof menuLookupSchema>): Promise<MenuLookup> {
    const school = this.editableSchool(userId, schoolId);
    const input = menuLookupSchema.parse(raw);
    let site: ReturnType<typeof parseMenuSite>;
    try { site = parseMenuSite(input.url); } catch (error) { return fail('BAD_REQUEST', (error as Error).message); }
    this.limit(userId);
    this.audit(userId, 'menu.lookup', school.id, { org: site.org, domain: site.domain });
    const choices = await this.choices(site);
    if (choices.length === 0) fail('NOT_FOUND', 'That site has no published menus.');
    const suggested = choices.find((choice) => choice.school === site.school && (!site.menu || choice.menu === site.menu)) ?? (site.school ? choices.find((choice) => choice.school === site.school) : undefined);
    return { site: { org: site.org, domain: site.domain }, choices, suggested: suggested ? `${suggested.school}/${suggested.menu}` : null };
  }

  /** Points the school at a menu (checked against the site's listing, so its label is the site's own), or clears it. */
  async set(userId: string, raw: z.infer<typeof menuSetSchema>): Promise<MenuSource | null> {
    const input = menuSetSchema.parse(raw);
    const school = this.editableSchool(userId, input.schoolId);
    const previous = this.source(school.id);
    let next: MenuSource | null = null;
    if (input.source) {
      this.limit(userId);
      const choice = (await this.choices(input.source)).find((entry) => entry.school === input.source!.school && entry.menu === input.source!.menu);
      if (!choice) return fail('NOT_FOUND', 'That menu is not on the site any more. Look it up again.');
      next = { org: input.source.org, domain: input.source.domain, school: choice.school, menu: choice.menu, name: menuChoiceName(choice) };
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE schools SET menu_source=? WHERE id=?').run(next ? JSON.stringify(next) : '', school.id);
      this.db.prepare('DELETE FROM menu_weeks WHERE school_id=?').run(school.id);
      this.audit(userId, 'school.menu', school.id, { from: previous && menuPageUrl(previous), to: next && menuPageUrl(next) });
    }).immediate();
    return next;
  }

  /**
   * The provider's week (Sunday to Saturday) containing the date, for the student's school. Served from the cache
   * while fresh; otherwise fetched, and if the provider is down the cached copy is returned marked stale.
   */
  async week(userId: string, raw: z.infer<typeof menuWeekSchema>): Promise<MenuWeek> {
    const user = this.service.ready(userId);
    if (!user.schoolId) fail('BAD_REQUEST', 'Join a school first.');
    const source = this.source(user.schoolId!);
    if (!source) return { source: null };
    const weekStart = menuWeekStart(menuWeekSchema.parse(raw).date);
    const serialized = JSON.stringify(source);
    const cached = this.db.prepare('SELECT days, fetched_at FROM menu_weeks WHERE school_id=? AND week_start=? AND source=?').get(user.schoolId, weekStart, serialized) as { days: string; fetched_at: string } | undefined;
    const now = this.clock();
    const result = (days: MenuDay[], fetchedAt: string, stale: boolean): MenuWeek => ({ source: { ...source, url: menuPageUrl(source) }, weekStart, days, fetchedAt, stale });
    if (cached && now.getTime() - new Date(cached.fetched_at).getTime() < MENU_CACHE_MS) return result(JSON.parse(cached.days), cached.fetched_at, false);
    let days: MenuDay[];
    try { days = parseMenuWeek(await this.fetchJson(weekUrl(source, weekStart))); }
    catch (error) {
      if (cached) return result(JSON.parse(cached.days), cached.fetched_at, true);
      return fail('BAD_GATEWAY', error instanceof Error && error.message ? error.message : PROVIDER_DOWN);
    }
    const fetchedAt = now.toISOString();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO menu_weeks(school_id,week_start,source,days,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(school_id,week_start) DO UPDATE SET source=excluded.source, days=excluded.days, fetched_at=excluded.fetched_at')
        .run(user.schoolId, weekStart, serialized, JSON.stringify(days), fetchedAt);
      this.db.prepare('DELETE FROM menu_weeks WHERE week_start < ?').run(new Date(now.getTime() - MENU_KEEP_DAYS * 86400_000).toISOString().slice(0, 10));
    }).immediate();
    return result(days, fetchedAt, false);
  }
}
