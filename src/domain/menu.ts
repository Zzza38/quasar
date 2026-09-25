import { z } from 'zod';
import { addDays, weekdayOf } from '@/lib/format';

/**
 * The school lunch menu comes from Nutrislice, the menu service most school food providers publish through
 * (FLIK, Sodexo, Chartwells and district cafeterias). A school's site is `{org}.nutrislice.com` or a white-label
 * domain such as `{org}.flikisdining.com`; each site lists one or more "schools" (a menu page: lower school lunch,
 * upper school lunch, snack) and each has menu types (lunch, breakfast). The public week API sits at
 * `https://{org}.api.{domain}/menu/api/weeks/school/{school}/menu-type/{menu}/{yyyy}/{mm}/{dd}/`.
 */
export const MENU_DOMAINS = ['nutrislice.com', 'flikisdining.com'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const slugSchema = z.string().regex(SLUG, 'Menu addresses use lowercase letters, digits and hyphens.');
/** A Nutrislice site: which organisation, on which of the supported domains. */
export const menuSiteSchema = z.object({ org: slugSchema, domain: z.enum(MENU_DOMAINS) });
/** The one menu a school follows: a site plus the school page and menu type on it; `name` is the site's own label for display. */
export const menuSourceSchema = menuSiteSchema.extend({ school: slugSchema, menu: slugSchema, name: z.string().trim().min(1).max(200) });
export type MenuSite = z.infer<typeof menuSiteSchema>;
export type MenuSource = z.infer<typeof menuSourceSchema>;
/** One day of a menu: notes such as a holiday name, and the items grouped by station (Soup, Entree, Grill). */
export type MenuDay = { date: string; notes: string[]; sections: Array<{ title: string; items: string[] }> };

export const MENU_URL_HELP = 'Paste a link from your school’s Nutrislice menu site (for example https://yourschool.nutrislice.com/menu/… or …flikisdining.com/menu/…).';

/**
 * The site named by any address on it, plus the school page and menu type when the address is a menu page
 * (`/menu/{school}/{menu}`). Throws a student-facing message for anything that is not a supported menu site.
 */
export function parseMenuSite(input: string): MenuSite & { school?: string; menu?: string } {
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`); } catch { throw new Error(MENU_URL_HELP); }
  const host = url.hostname.toLowerCase();
  const domain = MENU_DOMAINS.find((entry) => host.endsWith(`.${entry}`));
  if (!domain) throw new Error(MENU_URL_HELP);
  const org = host.slice(0, -domain.length - 1).replace(/\.api$/, '');
  if (!SLUG.test(org) || org === 'www' || org === 'api') throw new Error(MENU_URL_HELP);
  const segments = url.pathname.toLowerCase().split('/').filter(Boolean);
  const site: MenuSite & { school?: string; menu?: string } = { org, domain };
  if (segments[0] === 'menu' && segments[1] && segments[1] !== 'api' && SLUG.test(segments[1])) {
    site.school = segments[1];
    if (segments[2] && SLUG.test(segments[2])) site.menu = segments[2];
  }
  return site;
}

export function menuApiBase(site: MenuSite): string {
  return `https://${site.org}.api.${site.domain}`;
}
/** The page students can open in the browser or the Nutrislice app. */
export function menuPageUrl(source: MenuSource): string {
  return `https://${source.org}.${source.domain}/menu/${source.school}/${source.menu}`;
}
/** The Sunday that starts the provider's week containing the date; menus are fetched and cached by that week. */
export function menuWeekStart(date: string): string {
  return addDays(date, -(weekdayOf(date) % 7));
}

const itemSchema = z.looseObject({
  is_section_title: z.boolean().nullish(), is_station_header: z.boolean().nullish(), is_holiday: z.boolean().nullish(),
  text: z.string().nullish(), food: z.looseObject({ name: z.string().nullish() }).nullish(),
});
const weekSchema = z.looseObject({ days: z.array(z.looseObject({ date: z.string(), menu_items: z.array(itemSchema).nullish() })) });
const MAX_SECTIONS = 40, MAX_ITEMS = 200, MAX_TEXT = 200;
const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** The days of a Nutrislice week payload as MenuDay rows, in date order. Unreadable payloads throw. */
export function parseMenuWeek(payload: unknown): MenuDay[] {
  const week = weekSchema.safeParse(payload);
  if (!week.success) throw new Error('The menu site answered in a form Quasar does not understand.');
  const days: MenuDay[] = [];
  for (const raw of week.data.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) continue;
    const day: MenuDay = { date: raw.date, notes: [], sections: [] };
    let section: MenuDay['sections'][number] | null = null;
    let count = 0;
    for (const item of raw.menu_items ?? []) {
      const text = clean(item.text);
      const food = clean(item.food?.name);
      if (item.is_section_title || item.is_station_header) {
        section = null;
        if (text && day.sections.length < MAX_SECTIONS) { section = { title: text, items: [] }; day.sections.push(section); }
        continue;
      }
      if (food) {
        if (count >= MAX_ITEMS) continue;
        if (!section) { section = { title: '', items: [] }; if (day.sections.length >= MAX_SECTIONS) continue; day.sections.push(section); }
        if (!section.items.includes(food)) { section.items.push(food); count += 1; }
      } else if (text && !day.notes.includes(text) && day.notes.length < 10) day.notes.push(text);
    }
    day.sections = day.sections.filter((entry) => entry.items.length > 0);
    days.push(day);
  }
  return days.sort((left, right) => left.date.localeCompare(right.date));
}

const schoolsSchema = z.array(z.looseObject({
  name: z.string(), slug: z.string(),
  active_menu_types: z.array(z.looseObject({ name: z.string(), slug: z.string() })).nullish(),
}));
export type MenuChoice = { school: string; schoolName: string; menu: string; menuName: string };

/** Every menu a Nutrislice site publishes (its `/menu/api/schools/` listing), as choices for the picker. */
export function parseMenuChoices(payload: unknown): MenuChoice[] {
  const schools = schoolsSchema.safeParse(payload);
  if (!schools.success) throw new Error('The menu site answered in a form Quasar does not understand.');
  const choices: MenuChoice[] = [];
  for (const school of schools.data) {
    if (!SLUG.test(school.slug)) continue;
    for (const type of school.active_menu_types ?? []) {
      if (!SLUG.test(type.slug) || choices.length >= 200) continue;
      choices.push({ school: school.slug, schoolName: clean(school.name) || school.slug, menu: type.slug, menuName: clean(type.name) || type.slug });
    }
  }
  return choices;
}

/** "MS/US Lunch · Lunch", or just the school page name when the menu type repeats it. */
export function menuChoiceName(choice: MenuChoice): string {
  return choice.schoolName.toLowerCase().includes(choice.menuName.toLowerCase()) ? choice.schoolName : `${choice.schoolName} · ${choice.menuName}`;
}
