import { classKey, isFreePeriodName } from './class-match';

/** The beta that turns on "Connect Schoology" in Classes (src/server/schoology.ts). */
export const SCHOOLOGY_BETA = 'schoology-connect';

/** Marks the address Schoology sends a member back to, so Classes knows the `oauth_token` beside it is ours. */
export const SCHOOLOGY_RETURN_PARAM = 'schoology';

const ITEM_LINK = /schoology\.com\/(assignment|event)\/(\d{1,20})(?!\d)/i;

/**
 * The Schoology item a calendar import came from, as `assignment:<id>` or `event:<id>`, read from the iCal URL and
 * then the " - Link: …" line Schoology puts in the description. Null for anything else.
 */
export function schoologyItemKey(task: { notes?: string; imported?: { url?: string | null } | null }): string | null {
  for (const text of [task.imported?.url ?? '', task.notes ?? '']) {
    const match = ITEM_LINK.exec(text);
    if (match) return `${match[1].toLowerCase()}:${match[2]}`;
  }
  return null;
}

/** Assignment links live in calendar metadata or in Schoology's description footer on older/API imports. */
export function schoologyItemUrl(task: { notes?: string; imported?: { url?: string | null } | null }, taskId?: string | null): string | null {
  const assignmentId = /^sgy_(\d{1,20})$/.exec(taskId ?? '')?.[1];
  const fallback = assignmentId ? `https://app.schoology.com/assignment/${assignmentId}` : null;
  const sourceLinks = [...(task.notes ?? '').matchAll(/(?:^|\n)\s*-?\s*Link:\s*(https?:\/\/[^\s<>"']+)/gi)].map(match => match[1]);
  const candidates = [task.imported?.url ?? '', ...sourceLinks, fallback ?? '', ...(task.notes?.match(/https?:\/\/[^\s<>"']+/gi) ?? [])];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[).,;!?]+$/, ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (url.hostname !== 'schoology.com' && !url.hostname.endsWith('.schoology.com')) continue;
      if (!/^\/(assignment|event)\/\d{1,20}(?:\/|$)/i.test(url.pathname)) continue;
      url.protocol = 'https:';
      return url.toString();
    } catch { /* A malformed link is not an assignment URL. */ }
  }
  return null;
}

/** "Algebra II B", "Spanish 2 A block", "Biology - Section 3" without the trailing section label. */
const SECTION_SUFFIX = /(?:\s+|\s*[-–:(]\s*)(?:[A-Z]|[A-Z\d]{1,2}\s+block|block\s+[A-Z\d]{1,2}|(?:section|sec\.?|period|per\.?)\s*[A-Z\d]{1,3})\)?$/i;
const stripSection = (title: string) => title.replace(SECTION_SUFFIX, '').trim();

/**
 * The member's Quasar class a Schoology section belongs to, or null. A class matches when its name has the same
 * words as the course or section title (classKey: any order, honors spellings unified); only when nothing matches
 * that way are trailing section labels ("… E", "… A block") dropped and the titles tried again. Two or more matching
 * classes, like none, give null: a wrong class is worse than no class.
 */
export function matchSectionClass(section: { courseTitle: string; sectionTitle: string }, classes: ReadonlyArray<{ id: string; name: string }>): string | null {
  const usable = classes.filter(entry => entry.name.trim() && !isFreePeriodName(entry.name));
  const titles = [section.courseTitle, section.sectionTitle].filter(title => title.trim());
  for (const forms of [titles, titles.map(stripSection).filter(title => title && !titles.includes(title))]) {
    const keys = new Set(forms.map(classKey).filter(Boolean));
    if (keys.size === 0) continue;
    const found = usable.filter(entry => keys.has(classKey(entry.name)));
    if (found.length === 1) return found[0].id;
    if (found.length > 1) return null;
  }
  return null;
}

/** Assignments due further back than this aren't imported: they're old news, not things to do. */
export const SCHOOLOGY_IMPORT_PAST_DAYS = 14;
const IMPORT_FUTURE_DAYS = 365;

export type SchoologyAssignment = { id?: unknown; title?: unknown; description?: unknown; due?: unknown; web_url?: unknown; published?: unknown; last_updated?: unknown };
export type AssignmentFields = { title: string; dueDate: string | null; dueTime: string | null; notes: string };

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The task a Schoology assignment becomes, or null when it isn't one to import: unpublished, due before
 * SCHOOLOGY_IMPORT_PAST_DAYS ago or over a year out, or with no due date and no change in that long (`last_updated`,
 * Unix seconds). Classes keep weeks-old undated assignments around; those are rarely still to do. `due` is "YYYY-MM-DD HH:MM:SS" in the member's Schoology time
 * zone, or empty. The notes end with the same " - Link: …" line Schoology's calendar feed writes, so schoologyItemKey
 * reads either kind of import.
 */
export function assignmentTask(assignment: SchoologyAssignment, today: string): AssignmentFields | null {
  const id = String(assignment.id ?? '');
  if (!/^\d{1,20}$/.test(id) || String(assignment.published ?? '1') !== '1') return null;
  const due = typeof assignment.due === 'string' ? /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/.exec(assignment.due) : null;
  const dueDate = due ? due[1] : null;
  if (dueDate && (dueDate < addDays(today, -SCHOOLOGY_IMPORT_PAST_DAYS) || dueDate > addDays(today, IMPORT_FUTURE_DAYS))) return null;
  if (!dueDate) {
    const updated = Number(assignment.last_updated);
    if (!Number.isFinite(updated) || updated <= 0 || new Date(updated * 1000).toISOString().slice(0, 10) < addDays(today, -SCHOOLOGY_IMPORT_PAST_DAYS)) return null;
  }
  const dueTime = dueDate && due?.[2] && due[2] !== '00:00' ? due[2] : null;
  const title = (typeof assignment.title === 'string' ? assignment.title : '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled assignment';
  const description = (typeof assignment.description === 'string' ? assignment.description : '')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
  const web = typeof assignment.web_url === 'string' && ITEM_LINK.test(assignment.web_url) && /^https?:\/\//.test(assignment.web_url) ? assignment.web_url : `https://app.schoology.com/assignment/${id}`;
  return { title, dueDate, dueTime, notes: `${description ? `${description}\n` : ''} - Link: ${web}` };
}

/** True when a dropbox's revisions include a turned-in one (Schoology keeps drafts as revisions too). */
export function turnedIn(submissions: unknown): boolean {
  const revisions = (submissions as { revision?: { draft?: unknown }[] } | null)?.revision ?? [];
  return revisions.some(revision => String(revision.draft ?? '0') !== '1');
}

/** Title and due date as a duplicate check between a feed import and an API import of the same assignment. */
export const assignmentMatchKey = (title: string, dueDate: string | null) => `${title.replace(/\s+/g, ' ').trim().toLowerCase()}\0${dueDate ?? ''}`;
