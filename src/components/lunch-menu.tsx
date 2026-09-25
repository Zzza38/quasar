'use client';

import { useCallback, useEffect, useId, useReducer, useState, type ReactNode } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { MENU_URL_HELP, menuChoiceName, menuWeekStart, type MenuDay } from '@/domain/menu';
import { addDays, formatDate, relativeDate } from '@/lib/format';
import { cn, scrollToId } from '@/lib/utils';
import type { AppState, WorkspaceContext } from './app-state';
import { Icon } from './icon';
import { Button, Callout, ChoiceGroup, EmptyState, Eyebrow, Field, Hint, IconButton, Input, Modal, OptionCard, Section } from './primitives';

export type MenuWeek = RouterOutput['school']['menu'];
type MenuLookup = RouterOutput['school']['menuSources'];

/** Who may point the school at a menu: the owner, or any member while the shared schedule is open to member edits (the server's rule, MenuService.canEdit). */
export function canEditMenu(context: Pick<WorkspaceContext, 'isAdmin'> & { school: { memberLocked: boolean; supportLocked: boolean; memberCount: number } }): boolean {
  return context.isAdmin || !(context.school.memberLocked || context.school.supportLocked || context.school.memberCount >= 10);
}

/** The weekdays of the provider's week to show: Monday to Friday always, a weekend day only when the menu lists something for it. */
export function menuWeekDays(weekStart: string, days: MenuDay[]): Array<{ date: string; day: MenuDay | null }> {
  const listed = new Map(days.map((day) => [day.date, day]));
  const hasContent = (day: MenuDay | undefined) => !!day && (day.sections.length > 0 || day.notes.length > 0);
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
    .filter((date, index) => (index >= 1 && index <= 5) || hasContent(listed.get(date)))
    .map((date) => ({ date, day: listed.get(date) ?? null }));
}

/* ---------- Fetching: one request per week, shared by Today, Schedule and School ---------- */

/** A loaded week is reused for this long, so moving between views does not fetch it again. */
const CLIENT_CACHE_MS = 10 * 60_000;
const cache = new Map<string, { menu: MenuWeek; at: number }>();
const inflight = new Map<string, Promise<MenuWeek>>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
/** Drops every loaded week (after the source changes) and re-renders mounted menus so they fetch again. */
export function clearMenuCache(): void { cache.clear(); notify(); }

function loadWeek(key: string, date: string): Promise<MenuWeek> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = api.school.menu.query({ date }).then((menu) => { cache.set(key, { menu, at: Date.now() }); notify(); return menu; }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * The menu week containing `date`. Fetches only while online; an expired copy is shown until the fresh one
 * arrives. `menu` is null before the first load; `{ source: null }` when the school has no menu set up.
 */
export function useLunchMenu(state: Pick<AppState, 'online' | 'context'>, date: string): { menu: MenuWeek | null; loading: boolean; error: string; reload: () => Promise<void> } {
  const key = `${state.context.school.id}:${menuWeekStart(date)}`;
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { listeners.add(rerender); return () => { listeners.delete(rerender); }; }, []);
  const entry = cache.get(key);
  const fresh = !!entry && Date.now() - entry.at < CLIENT_CACHE_MS;
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try { await loadWeek(key, date); } catch (err) { setError(errorMessage(err)); } finally { setLoading(false); }
  }, [key, date]);
  useEffect(() => {
    if (fresh || !state.online) return;
    void reload();
  }, [fresh, state.online, reload]);
  return { menu: entry?.menu ?? null, loading, error, reload };
}

/* ---------- Views ---------- */

function DayMenu({ day, compact }: { day: MenuDay; compact?: boolean }) {
  return <div className="grid gap-2">
    {day.notes.map((note) => <p key={note} className="text-sm font-semibold">{note}</p>)}
    {day.sections.length > 0 && <dl className={cn('grid gap-x-4 gap-y-2', compact ? 'sm:grid-cols-2' : '')}>
      {day.sections.map((section, index) => <div key={`${section.title}-${index}`} className="grid gap-0.5">
        <dt className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">{section.title || 'Menu'}</dt>
        <dd className="text-sm leading-relaxed">{section.items.join(' · ')}</dd>
      </div>)}
    </dl>}
  </div>;
}

/**
 * The day's lunch under a timeline (Today, Schedule). Shows nothing until the week has loaded, when the school
 * has no menu set up, or when the provider lists nothing for the day, so a page without a menu looks as before.
 */
export function LunchDay({ state, date }: { state: AppState; date: string }) {
  const { menu } = useLunchMenu(state, date);
  const titleId = useId();
  if (!menu || !menu.source) return null;
  const day = menu.days.find((entry) => entry.date === date);
  if (!day || (day.sections.length === 0 && day.notes.length === 0)) return null;
  const relative = relativeDate(date, state.today);
  const when = ['Today', 'Tomorrow', 'Yesterday'].includes(relative) ? relative.toLowerCase() : formatDate(date, { weekday: 'long' }).split(',')[0];
  return <section aria-labelledby={titleId} className="grid gap-2.5 border-t border-foreground/[0.06] pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id={titleId} className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground"><Icon name="utensils" size={13} strokeWidth={2.4} />Lunch {when}</h3>
      <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('school', { menu: 'open' })}>Full week</Button>
    </div>
    <DayMenu day={day} compact />
    {menu.stale && <Hint>The menu site could not be reached; this is the last copy Quasar saw.</Hint>}
  </section>;
}

/** The School view's Lunch menu card: the week's menus with week navigation, where the menu comes from, and set-up for those who may change it. */
export function LunchMenuSection({ state }: { state: AppState }) {
  const { context, online, today } = state;
  // Weeks relative to today, not a stored date: the first render's `today` is the server's (renderedAt in the tracker),
  // and a browser in another zone or a page left open overnight follows the real day.
  const [weekOffset, setWeekOffset] = useState(0);
  const weekDate = addDays(today, weekOffset * 7);
  const { menu, loading, error, reload } = useLunchMenu(state, weekDate);
  const [editing, setEditing] = useState(false);
  const editable = canEditMenu(context);
  // "Full week" on Today lands here; the one-shot param is stripped so Back and reloads do not scroll again.
  const wantsOpen = state.params.get('menu') === 'open';
  const { navigate } = state;
  useEffect(() => {
    if (!wantsOpen) return;
    scrollToId('lunch-menu-title', true);
    navigate('school', {}, { replace: true });
  }, [wantsOpen, navigate]);
  const weekStart = menuWeekStart(weekDate);
  const thisWeek = menuWeekStart(today) === weekStart;
  // One narrowing for both: `loaded` is the week when the school has a menu.
  const loaded = menu && menu.source ? menu : null;
  const source = loaded?.source ?? null;
  const stamp = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: state.timeZone }).format(new Date(value));
  const action: ReactNode = <>
    {source && <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary hover:underline">Open menu site<Icon name="externalLink" size={14} /></a>}
    {editable && <Button size="sm" icon={source ? 'edit' : 'plus'} disabled={!online} title={!online ? 'Connect to change the lunch menu.' : undefined} onClick={() => setEditing(true)}>{source ? 'Change' : 'Set up'}</Button>}
  </>;
  return <Section id="lunch-menu-title" title="Lunch menu" icon="utensils" action={action}
    description={source ? <>{source.name} · from the school’s Nutrislice menu</> : 'What the cafeteria is serving, day by day.'}>
    {!online && !menu && <Hint>Connect to the internet to see the lunch menu.</Hint>}
    {online && !menu && loading && <p className="py-4 text-sm text-muted-foreground" aria-busy="true">Loading the menu…</p>}
    {!menu && error && <Callout tone="danger" role="alert" actions={<Button size="sm" onClick={() => void reload()}>Try again</Button>}>{error}</Callout>}
    {menu && !source && <EmptyState icon="utensils" title="No lunch menu yet" action={editable ? <Button variant="primary" icon="plus" disabled={!online} onClick={() => setEditing(true)}>Add the lunch menu</Button> : undefined}>
      {editable ? 'If the school publishes its menu on Nutrislice, connect it here and every member sees each day’s lunch on Today.' : 'This school has not connected its menu. If it publishes one on Nutrislice, send a correction request with the link.'}
    </EmptyState>}
    {loaded && <>
      <div className="flex items-center justify-between gap-2">
        <IconButton label="Previous week" icon="chevronLeft" onClick={() => setWeekOffset(weekOffset - 1)} />
        <div className="grid justify-items-center gap-0.5 text-center">
          <strong className="text-sm font-bold tracking-tight">{formatDate(addDays(weekStart, 1))} – {formatDate(addDays(weekStart, 5), { year: true })}</strong>
          {!thisWeek && <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setWeekOffset(0)}>Back to this week</button>}
        </div>
        <IconButton label="Next week" icon="chevronRight" onClick={() => setWeekOffset(weekOffset + 1)} />
      </div>
      <ul className={cn('grid gap-2', loading && 'opacity-70')} aria-busy={loading || undefined}>
        {menuWeekDays(loaded.weekStart, loaded.days).map(({ date, day }) => {
          const isToday = date === today;
          const empty = !day || (day.sections.length === 0 && day.notes.length === 0);
          return <li key={date} className={cn('grid gap-2 rounded-2xl bg-muted/70 p-3.5 ring-1 ring-inset ring-foreground/[0.04]', isToday && 'bg-primary-soft/60 ring-primary/30')}>
            <div className="flex items-baseline justify-between gap-2">
              <strong className="text-sm font-bold">{formatDate(date, { weekday: 'long' }).split(',')[0]}{isToday && <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-primary-foreground">Today</span>}</strong>
              <Eyebrow>{formatDate(date)}</Eyebrow>
            </div>
            {empty ? <p className="text-sm text-muted-foreground">No menu posted.</p> : <DayMenu day={day} />}
          </li>;
        })}
      </ul>
      <Hint>{loaded.stale ? `The menu site could not be reached; showing the copy from ${stamp(loaded.fetchedAt)}.` : `Updated ${stamp(loaded.fetchedAt)}.`}{error ? ` ${error}` : ''}</Hint>
    </>}
    {editable && <MenuSourceDialog open={editing} onClose={() => setEditing(false)} state={state} current={source} />}
  </Section>;
}

/**
 * Connects the school to a Nutrislice menu in two steps: paste any address from the menu site, then pick which
 * of its published menus the school follows (a site often lists several: lower school, upper school, snacks).
 */
function MenuSourceDialog({ open, onClose, state, current }: { open: boolean; onClose: () => void; state: AppState; current: (MenuWeek & { source: object })['source'] | null }) {
  const [url, setUrl] = useState('');
  const [lookup, setLookup] = useState<MenuLookup | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [pending, setPending] = useState<'lookup' | 'save' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const urlId = useId();
  // A fresh dialog every time it opens, prefilled with the current site so "Change" can go straight to the picker.
  useEffect(() => {
    if (!open) return;
    setUrl(current?.url ?? ''); setLookup(null); setChoice(null); setError(''); setRemoving(false);
  }, [open, current]);
  const accountId = state.context.user.id;
  const schoolId = state.context.school.id;
  const run = async (step: NonNullable<typeof pending>, action: () => Promise<void>) => {
    setPending(step); setError('');
    try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(null); }
  };
  const find = () => run('lookup', async () => {
    const result = await api.school.menuSources.query({ accountId, schoolId, url });
    setLookup(result);
    setChoice(result.suggested ?? (result.choices.length === 1 ? `${result.choices[0].school}/${result.choices[0].menu}` : null));
  });
  const save = () => run('save', async () => {
    const picked = lookup?.choices.find((entry) => `${entry.school}/${entry.menu}` === choice);
    if (!lookup || !picked) return;
    await api.school.setMenu.mutate({ accountId, schoolId, source: { ...lookup.site, school: picked.school, menu: picked.menu } });
    clearMenuCache();
    onClose();
  });
  const remove = () => run('remove', async () => {
    await api.school.setMenu.mutate({ accountId, schoolId, source: null });
    clearMenuCache();
    onClose();
  });
  return <Modal open={open} onClose={onClose} busy={pending !== null} title={current ? 'Change the lunch menu' : 'Connect the lunch menu'} description={MENU_URL_HELP}
    footer={<>
      {current && !removing && <Button variant="ghost" disabled={pending !== null} onClick={() => setRemoving(true)}>Remove menu</Button>}
      <Button variant="ghost" disabled={pending !== null} onClick={onClose}>Cancel</Button>
      {lookup && <Button variant="primary" busy={pending === 'save'} disabled={!choice || pending !== null || !state.online} onClick={save}>Use this menu</Button>}
    </>}>
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (url.trim() && pending === null) void find(); }}>
      <Field label="Menu site address" htmlFor={urlId} hint="Any page on the site works; Quasar lists the menus it publishes.">
        <div className="flex flex-wrap gap-2">
          <Input id={urlId} type="url" inputMode="url" autoComplete="off" autoFocus value={url} placeholder="https://yourschool.nutrislice.com/menu/…" maxLength={2000} className="min-w-0 flex-1 basis-[240px]" onChange={(event) => setUrl(event.target.value)} />
          <Button type="submit" icon="search" busy={pending === 'lookup'} disabled={!url.trim() || pending !== null || !state.online}>Find menus</Button>
        </div>
      </Field>
      {lookup && <div className="grid gap-2">
        <span className="text-[13px] font-semibold text-foreground/80">Which menu does the school follow?</span>
        <ChoiceGroup label="Menu" value={choice} onChange={setChoice} className="grid gap-2">
          {lookup.choices.map((entry) => <OptionCard key={`${entry.school}/${entry.menu}`} value={`${entry.school}/${entry.menu}`} title={menuChoiceName(entry)} description={`${entry.schoolName} · ${entry.menuName}`} />)}
        </ChoiceGroup>
      </div>}
      {removing && <Callout tone="warning" icon="alert" role="alert" title="Remove the lunch menu?" actions={<>
        <Button size="sm" variant="danger" busy={pending === 'remove'} disabled={pending !== null} onClick={remove}>Remove</Button>
        <Button size="sm" autoFocus disabled={pending !== null} onClick={() => setRemoving(false)}>Keep it</Button>
      </>}>Members stop seeing daily lunches until someone connects a menu again.</Callout>}
      {error && <Hint tone="danger" role="alert">{error}</Hint>}
    </form>
  </Modal>;
}
