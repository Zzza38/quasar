'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { scheduledPeriodIds } from '@/domain/period-status';
import { effectiveSchedule, type PersonalSchedule, type Schedule } from '@/domain/schedule';
import { cn } from '@/lib/utils';
import type { AppState } from './app-state';
import { Icon, type IconName } from './icon';
import { Button, Hint, IconButton, Panel } from './primitives';
import { Card, CardContent, CardDescription, CardHeader } from './ui/card';
import { checklist, isInstalled, isIos } from './setup-state';
import { FeedGuide } from './feed-guide';

type Item = { id: string; icon: IconName; title: string; detail: string; done: boolean; action?: ReactNode; manual?: boolean; skipped?: boolean };

/**
 * State of a step the student can settle by hand. `completed` is what the app can see (a calendar connected,
 * reminders on, the app installed); `ticked` is the student's own tick. A tick is `manual` so the row offers Undo,
 * and for a "Not now" step (`skip`) it is `skipped`, not done: the row says so and the step can be brought back.
 */
export function tickedStep(completed: boolean, ticked: boolean, skip: boolean): { done: boolean; manual: boolean; skipped: boolean } {
  const byTick = !completed && ticked;
  return { done: completed || ticked, manual: byTick, skipped: skip && byTick };
}

/** Fired by the checklist and handled by the shell, which owns the account sheet. */
export const OPEN_ACCOUNT_EVENT = 'quasar:open-account';

/**
 * True once the student has classes and at least one of them sits on a scheduled period, so the countdown has
 * something to show. `schedule` is the school (grade) schedule from AppState; the student's private schedule and
 * rotation-day and date adjustments are applied here, as the countdown does.
 */
export function coreSetupDone(personal: PersonalSchedule, schedule: Schedule): boolean {
  if (personal.classes.length === 0) return false;
  const scheduled = scheduledPeriodIds(effectiveSchedule(schedule, personal), personal);
  return Object.entries(personal.assignments).some(([periodId, classId]) => scheduled.has(periodId) && personal.classes.some((cls) => cls.id === classId));
}

/** Names the step a repeated link button ("Not now", "Undo") belongs to, for screen readers. */
const about = (title: string) => <span className="sr-only">: {title}</span>;

/**
 * Setup steps on Today until every step is done or the student dismisses it. Today places it above
 * the countdown until classes are added and placed, and below it afterwards. Only one step is open at
 * a time; the others are one-line rows, and finished steps hide behind "Show all steps".
 */
export function SetupChecklist({ state }: { state: AppState }) {
  const { personal, schedule, context } = state;
  const userId = context.user.id;
  const [, rerender] = useState(0);
  const [hidden, setHidden] = useState(() => checklist.dismissed(userId));
  const [installOpen, setInstallOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [reminders, setReminders] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setInstalled(isInstalled());
    try { setReminders(!!localStorage.getItem(`quasar-push:${userId}`)); } catch { /* private mode */ }
    const refresh = () => { try { setReminders(!!localStorage.getItem(`quasar-push:${userId}`)); } catch { /* ignore */ } };
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, [userId]);
  // Opening or ticking a step unmounts the button that was pressed, so focus moves to the open step's title.
  const [focusRequest, setFocusRequest] = useState(0);
  const activeTitle = useRef<HTMLElement>(null);
  useEffect(() => { if (focusRequest) activeTitle.current?.focus(); }, [focusRequest]);
  const tick = (id: string, on = true) => { checklist.tick(id, userId, on); rerender((n) => n + 1); setFocusRequest((n) => n + 1); };
  const openStep = (id: string) => { setOpenId(id); setFocusRequest((n) => n + 1); };
  const placed = coreSetupDone(personal, schedule);

  const items: Item[] = [
    { id: 'classes', icon: 'book', title: 'Add your classes', detail: 'Type them in, pick from schoolmates, or scan a photo.', done: personal.classes.length > 0, action: <Button size="sm" onClick={() => state.navigate('classes')}>Open Classes</Button> },
    { id: 'place', icon: 'layers', title: 'Put each class on its period', detail: 'Drag a class onto its block, or tap the class and then the block, so the countdown knows what is next.', done: placed, action: <Button size="sm" onClick={() => state.navigate('classes')}>Open the timetable</Button> },
    ...(context.school.approved ? [] : [{ id: 'verify', icon: 'calendar' as IconName, title: 'Check the bell times', detail: 'A student entered this schedule. Compare it with the school’s published one and fix anything wrong, so everyone benefits.', ...tickedStep(false, checklist.ticked('verify', userId), false), action: <><Button size="sm" onClick={() => state.navigate('school', { fix: 'times' })}>Open the schedule</Button><Button size="sm" variant="link" onClick={() => tick('verify')}>It matches{about('Check the bell times')}</Button></> }]),
    { id: 'calendar', icon: 'calendar', title: 'Connect your homework calendar', detail: 'Paste the iCal link from Schoology, Google Classroom or Canvas and assignments become tasks by themselves.', ...tickedStep((context.subscriptions ?? []).length > 0, checklist.ticked('calendar', userId), true), action: <><Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_EVENT, { detail: { feed: 'add' } }))}>Add calendar</Button><Button size="sm" variant="ghost" onClick={() => setFeedOpen((open) => !open)} aria-expanded={feedOpen}>Where is the link?</Button><Button size="sm" variant="link" onClick={() => tick('calendar')}>Not now{about('Connect your homework calendar')}</Button></> },
    { id: 'reminders', icon: 'bell', title: 'Turn on reminders', detail: 'Get a nudge before a task is due, on this device.', ...tickedStep(reminders, checklist.ticked('reminders', userId), true), action: <><Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_EVENT))}>Open Account</Button><Button size="sm" variant="link" onClick={() => tick('reminders')}>Not now{about('Turn on reminders')}</Button></> },
    { id: 'install', icon: 'home', title: 'Add Quasar to your home screen', detail: 'Opens like an app, works offline, no store needed.', ...tickedStep(installed, checklist.ticked('install', userId), false), action: <><Button size="sm" onClick={() => setInstallOpen((open) => !open)} aria-expanded={installOpen}>How?</Button><Button size="sm" variant="link" onClick={() => tick('install')}>Already added{about('Add Quasar to your home screen')}</Button></> },
  ];
  const remaining = items.filter((item) => !item.done);
  if (hidden || remaining.length === 0) return null;
  // Settled steps (done or skipped) leave the open list; only real completions count as done.
  const settledCount = items.length - remaining.length;
  const skippedCount = items.filter((item) => item.skipped).length;
  const doneCount = settledCount - skippedCount;
  const next = remaining[0];
  const active = remaining.find((item) => item.id === openId) ?? next;
  const visible = showAll ? items : remaining;

  return <Card role="region" aria-labelledby="setup-title" className="gap-3">
    <CardHeader className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-soft-foreground"><Icon name="sparkle" size={16} strokeWidth={2.2} /></span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h2 id="setup-title" className="text-[15.5px] font-bold leading-snug tracking-tight">Finish setting up</h2>
        <CardDescription className="text-[13px]">{doneCount} of {items.length} done{skippedCount > 0 && ` · ${skippedCount} skipped`} · Next: {next.title}</CardDescription>
      </div>
      <IconButton icon="x" size="sm" label="Hide setup checklist" className="-mr-1 -mt-1" onClick={() => { checklist.dismiss(userId); setHidden(true); }} />
    </CardHeader>
    <CardContent className="grid gap-2">
    <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/80 transition-[width] duration-500" style={{ width: `${(settledCount / items.length) * 100}%` }} /></div>
    <ol className="divide-y divide-foreground/[0.06]">
      {visible.map((item) => {
        if (item.done) return <li key={item.id} className="flex min-h-11 items-center gap-3 py-1.5">
          {item.skipped
            ? <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Icon name={item.icon} size={12} /></span>
            : <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-success-soft text-success"><Icon name="check" size={12} strokeWidth={3} /></span>}
          <span className={cn('min-w-0 flex-1 text-sm font-semibold text-muted-foreground', !item.skipped && 'line-through decoration-foreground/30')}>{item.title}{item.skipped ? <><span aria-hidden="true"> · skipped</span><span className="sr-only"> (skipped)</span></> : <span className="sr-only"> (done)</span>}</span>
          {item.manual && <Button size="sm" variant="link" onClick={() => tick(item.id, false)}>Undo{about(item.title)}</Button>}
        </li>;
        if (item.id !== active.id) return <li key={item.id}>
          <button type="button" onClick={() => openStep(item.id)} className="flex min-h-11 w-full items-center gap-3 rounded-lg py-1.5 text-left text-sm font-semibold outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card">
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Icon name={item.icon} size={12} /></span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <Icon name="chevronRight" size={14} className="shrink-0 text-muted-foreground" />
          </button>
        </li>;
        return <li key={item.id} className="grid gap-3 py-3">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground"><Icon name={item.icon} size={12} /></span>
            <div className="min-w-0 flex-1">
              <strong id={`setup-${item.id}`} ref={activeTitle} tabIndex={-1} className="text-sm font-bold outline-none">{item.title}</strong>
              <Hint>{item.detail}</Hint>
            </div>
          </div>
          <div role="group" aria-labelledby={`setup-${item.id}`} className="flex flex-wrap items-center gap-2 sm:pl-9">{item.action}</div>
          {item.id === 'install' && installOpen && <div className="sm:pl-9"><InstallHelp /></div>}
          {item.id === 'calendar' && feedOpen && <div className="sm:pl-9"><Panel className="p-3"><FeedGuide compact /></Panel></div>}
        </li>;
      })}
    </ol>
    {settledCount > 0 && <Button size="sm" variant="link" className="justify-self-start px-0" aria-expanded={showAll} onClick={() => setShowAll((open) => !open)}>{showAll ? 'Hide finished steps' : `Show all ${items.length} steps`}</Button>}
    </CardContent>
  </Card>;
}

function InstallHelp() {
  const ios = isIos();
  return <Panel className="grid gap-2 p-3 text-sm">
    {ios ? <>
      <strong className="font-bold">iPhone or iPad (Safari)</strong>
      <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground">
        <li>Tap the Share button, the square with an arrow at the bottom of Safari.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b>. Quasar appears next to your other apps.</li>
      </ol>
      <Hint>Reminders on iPhone only work from the home-screen version.</Hint>
    </> : <>
      <strong className="font-bold">Android (Chrome)</strong>
      <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground">
        <li>Tap the three-dot menu in the top right.</li>
        <li>Tap <b>Add to Home screen</b> or <b>Install app</b>, then confirm.</li>
      </ol>
      <strong className="font-bold">Laptop (Chrome or Edge)</strong>
      <p className="text-muted-foreground">Click the install icon at the right end of the address bar, or open the browser menu and choose <b>Install Quasar</b>.</p>
    </>}
  </Panel>;
}
