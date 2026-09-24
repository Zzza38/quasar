'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { scheduledPeriodIds } from '@/domain/period-status';
import type { PersonalSchedule, Schedule } from '@/domain/schedule';
import type { AppState } from './app-state';
import { Icon, type IconName } from './icon';
import { Button, Hint, IconButton } from './primitives';
import { checklist, isInstalled, isIos } from './setup-state';
import { FeedGuide } from './feed-guide';

type Item = { id: string; icon: IconName; title: string; detail: string; done: boolean; action?: ReactNode; manual?: boolean };

/** Fired by the checklist and handled by the shell, which owns the account sheet. */
export const OPEN_ACCOUNT_EVENT = 'quasar:open-account';

/** True once the student has classes and at least one of them sits on a scheduled period, so the countdown has something to show. */
export function coreSetupDone(personal: PersonalSchedule, schedule: Schedule): boolean {
  if (personal.classes.length === 0) return false;
  const scheduled = scheduledPeriodIds(schedule);
  return Object.entries(personal.assignments).some(([periodId, classId]) => scheduled.has(periodId) && personal.classes.some((cls) => cls.id === classId));
}

/** Names the step a repeated ghost button ("Not now", "Undo") belongs to, for screen readers. */
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
    { id: 'place', icon: 'layers', title: 'Put each class on its period', detail: 'Drag a class onto a period so the countdown knows what is next.', done: placed, action: <Button size="sm" onClick={() => state.navigate('classes')}>Open the timetable</Button> },
    ...(context.school.approved ? [] : [{ id: 'verify', icon: 'calendar' as IconName, title: 'Check the bell times', detail: 'A student entered this schedule. Compare it with the school’s published one and fix anything wrong, so everyone benefits.', done: checklist.ticked('verify', userId), manual: true, action: <><Button size="sm" onClick={() => state.navigate('school', { fix: 'times' })}>Open the schedule</Button><Button size="sm" variant="ghost" onClick={() => tick('verify')}>It matches{about('Check the bell times')}</Button></> }]),
    { id: 'calendar', icon: 'calendar', title: 'Connect your homework calendar', detail: 'Paste the iCal link from Schoology, Google Classroom or Canvas and assignments become tasks by themselves.', done: (context.subscriptions ?? []).length > 0 || checklist.ticked('calendar', userId), action: <><Button size="sm" onClick={() => state.navigate('schedule', { feed: 'add' })}>Add calendar</Button><Button size="sm" variant="ghost" onClick={() => setFeedOpen((open) => !open)} aria-expanded={feedOpen}>Where is the link?</Button><Button size="sm" variant="ghost" className="ml-auto" onClick={() => tick('calendar')}>Not now{about('Connect your homework calendar')}</Button></> },
    { id: 'reminders', icon: 'bell', title: 'Turn on reminders', detail: 'Get a nudge before a task is due, on this device.', done: reminders || checklist.ticked('reminders', userId), action: <><Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_EVENT))}>Open Account</Button><Button size="sm" variant="ghost" className="ml-auto" onClick={() => tick('reminders')}>Not now{about('Turn on reminders')}</Button></> },
    { id: 'install', icon: 'home', title: 'Add Quasar to your home screen', detail: 'Opens like an app, works offline, no store needed.', done: installed || checklist.ticked('install', userId), action: <><Button size="sm" onClick={() => setInstallOpen((open) => !open)} aria-expanded={installOpen}>How?</Button><Button size="sm" variant="ghost" className="ml-auto" onClick={() => tick('install')}>Already added{about('Add Quasar to your home screen')}</Button></> },
  ];
  const remaining = items.filter((item) => !item.done);
  if (hidden || remaining.length === 0) return null;
  const doneCount = items.length - remaining.length;
  const next = remaining[0];
  const active = remaining.find((item) => item.id === openId) ?? next;
  const visible = showAll ? items : remaining;

  return <section aria-labelledby="setup-title" className="grid gap-3 rounded-3xl bg-card p-4 shadow-card ring-2 ring-primary/30 sm:p-5">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground"><Icon name="sparkle" size={18} /></span>
      <div className="min-w-0 flex-1">
        <h2 id="setup-title" className="text-[17px] font-bold">Finish setting up</h2>
        <Hint>{doneCount} of {items.length} done · Next: {next.title}</Hint>
      </div>
      <IconButton icon="x" size="sm" label="Hide setup checklist" onClick={() => { checklist.dismiss(userId); setHidden(true); }} />
    </div>
    <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(doneCount / items.length) * 100}%` }} /></div>
    <ol className="grid gap-1">
      {visible.map((item) => {
        if (item.done) return <li key={item.id} className="flex items-center gap-3 rounded-2xl px-3 py-1.5">
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-success-soft text-success"><Icon name="check" size={12} strokeWidth={3} /></span>
          <span className="min-w-0 flex-1 text-sm font-semibold text-muted-foreground line-through decoration-foreground/30">{item.title}<span className="sr-only"> (done)</span></span>
          {item.manual && <Button size="sm" variant="ghost" onClick={() => tick(item.id, false)}>Undo{about(item.title)}</Button>}
        </li>;
        if (item.id !== active.id) return <li key={item.id}>
          <Button variant="ghost" onClick={() => openStep(item.id)} className="h-auto w-full justify-start gap-3 rounded-2xl px-3 py-1.5 text-left text-sm font-semibold">
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-card text-muted-foreground shadow-card"><Icon name={item.icon} size={12} /></span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <Icon name="chevronDown" size={14} className="text-muted-foreground" />
          </Button>
        </li>;
        return <li key={item.id} className="grid gap-2 rounded-2xl bg-muted/70 px-3 py-2.5 ring-1 ring-inset ring-primary/40">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-card text-muted-foreground shadow-card"><Icon name={item.icon} size={14} /></span>
            <div className="min-w-0 flex-1">
              <strong id={`setup-${item.id}`} ref={activeTitle} tabIndex={-1} className="text-sm font-bold outline-none">{item.title}</strong>
              <Hint>{item.detail}</Hint>
            </div>
          </div>
          <div role="group" aria-labelledby={`setup-${item.id}`} className="flex flex-wrap gap-1.5 sm:pl-10">{item.action}</div>
          {item.id === 'install' && installOpen && <InstallHelp />}
          {item.id === 'calendar' && feedOpen && <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/[0.06]"><FeedGuide compact /></div>}
        </li>;
      })}
    </ol>
    {doneCount > 0 && <Button size="sm" variant="ghost" className="justify-self-start" aria-expanded={showAll} onClick={() => setShowAll((open) => !open)}>{showAll ? 'Hide finished steps' : `Show all ${items.length} steps`}</Button>}
  </section>;
}

function InstallHelp() {
  const ios = isIos();
  return <div className="grid gap-2 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/[0.06]">
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
  </div>;
}
