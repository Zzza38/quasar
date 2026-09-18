'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { GoogleLogo } from './google-logo';
import { Brand } from './shell';
import { Icon, type IconName } from './icon';
import { AppearanceToggle } from './theme-picker';
import { Button, Callout } from './primitives';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { cn } from '@/lib/utils';

/**
 * Signed-out landing page.
 *
 * Two halves: a live phone demo that answers "what does this actually look
 * like", then a scorecard where the visitor rates their current schedule app
 * against the eleven behaviours Quasar was built around and watches it fall
 * short. Nothing is submitted; the score is derived in this component.
 *
 * The lime highlight is a fixed brand accent rather than a themed token, so it
 * stays constant across the seven accent palettes. Everything else uses the
 * usual tokens and works in both appearances.
 */

const LIME = 'bg-[#d9f99d] text-[#0b0e12]';
/** The near-black band inverts in dark mode, where a lifted card surface reads better. */
const INK_BAND = 'bg-[#0b0e12] text-white dark:bg-card dark:text-card-foreground dark:ring-1 dark:ring-border';
/** Class colours are per-class in the real app; these stand in for a plausible timetable. */
const CLASS_COLORS = { english: '#7c3aed', chemistry: 'var(--primary)', history: '#be185d', algebra: '#15803d', spanish: '#0891b2', study: '#ca8a04', lunch: '#94a3b8' };

type Answer = 'yes' | 'no';
type DemoView = 'today' | 'schedule' | 'tasks' | 'classes';

const DEMO_VIEWS: ReadonlyArray<{ id: DemoView; label: string; icon: IconName }> = [
  { id: 'today', label: 'Today', icon: 'home' },
  { id: 'schedule', label: 'Schedule', icon: 'calendar' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'classes', label: 'Classes', icon: 'book' },
];

const QUESTIONS: ReadonlyArray<{ title: string; detail: string }> = [
  { title: 'Handles a rotating cycle of any length', detail: 'Not just A/B. Ten-day cycles, letter days, periods that change position.' },
  { title: 'Skips holidays and closures in the cycle', detail: 'A snow day should not push the rotation out by one for a month.' },
  { title: 'Supports a cycle reset mid-year', detail: 'After a closed week the school restarts the count. Can you tell it that?' },
  { title: 'Supports replacement days', detail: '“Thursday will run on a Monday schedule”, in one date and one setting.' },
  { title: 'Treats lunch waves as real periods', detail: 'Wave 1 and Wave 2 are different times, not a note in the description.' },
  { title: 'Lets you shift a whole day', detail: 'A two-hour delay moves every start, end and countdown with it.' },
  { title: 'Keeps your personal overrides', detail: 'When the school schedule is corrected, your own changes survive it.' },
  { title: 'Fully editable with no signal', detail: 'Add a task on the bus and it is still there when you land.' },
  { title: 'Shows where a change stands', detail: 'Saved, waiting, syncing, failed or needs a choice. Always visible.' },
  { title: 'Lets you resolve conflicts yourself', detail: 'Two devices, same field: you see both values and pick one.' },
  { title: 'No ads, no trackers, nothing sold', detail: 'You are the student, not the product.' },
];

const VERDICTS: ReadonlyArray<{ upTo: number; lead: string; rest: string }> = [
  { upTo: 3, lead: 'Rough.', rest: 'Most weird weeks you are on your own, which is when you needed it most.' },
  { upTo: 6, lead: 'Fine on a normal week.', rest: 'The exceptions are where it drops you, and schools run on exceptions.' },
  { upTo: 9, lead: 'Solid.', rest: 'But the gaps are the expensive ones. Those are the days you show up to the wrong room.' },
  { upTo: 11, lead: 'Genuinely good.', rest: 'Keep it. If the last gap ever bites you, you know where we are.' },
];

const FEATURES: ReadonlyArray<{ icon: IconName; title: string; body: string; gradient: string; wide?: boolean }> = [
  { icon: 'calendar', title: 'Any rotation you can describe', gradient: 'from-primary to-[#22b8c9]', wide: true, body: 'Ten-day cycles, letter days, periods that move around. Cycle days skip holidays, reset after closures, and “Thursday runs as Monday” is a setting, not a workaround.' },
  { icon: 'cloudOff', title: 'Offline is the normal case', gradient: 'from-[#7c3aed] to-[#a78bfa]', wide: true, body: 'Edits save on your device and upload later. Independent changes merge on their own; a real conflict shows both values and lets you pick. Nothing gets silently overwritten.' },
  { icon: 'clock', title: 'A countdown, not a grid', gradient: 'from-[#d97706] to-[#fbbf24]', body: 'Minutes left in this period, and what is next. That is the home screen.' },
  { icon: 'tasks', title: 'Tasks that fit real life', gradient: 'from-[#be185d] to-[#f472b6]', body: 'Priorities, checklists, repeats, notes, and calendar feeds that import themselves.' },
  { icon: 'users', title: 'Share with your people', gradient: 'from-[#15803d] to-[#4ade80]', body: 'Send your schedule to the friends you choose, one person at a time, and take it back whenever.' },
];

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  { title: 'Sign in with Google', body: 'No new password, nothing to install, no app store account.' },
  { title: 'Find or build your school', body: 'Already added? One tap. If not, start from a template and enter the bell schedule once. Everyone after you gets it for free.' },
  { title: 'Drop classes on periods', body: 'Browse the class directory, pick yours, drag them on. Today fills itself in from then on.' },
];

function signInWithGoogle() {
  void signIn('google', { callbackUrl: '/' });
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/* ---------- Phone demo ---------- */

/** Chemistry runs 10:50-11:40; the demo loops the last stretch of it. */
const PERIOD_START = 10 * 60 + 50;
const PERIOD_END = 11 * 60 + 40;
const PERIOD_LENGTH = PERIOD_END - PERIOD_START;

function clockLabel(minutes: number) {
  const hour = Math.floor(minutes / 60);
  return `${hour > 12 ? hour - 12 : hour}:${String(minutes % 60).padStart(2, '0')}`;
}

function PhoneDemo() {
  const reducedMotion = usePrefersReducedMotion();
  const [view, setView] = useState<DemoView>('today');
  const [elapsed, setElapsed] = useState(36);
  const auto = useRef(true);

  useEffect(() => {
    if (reducedMotion) return;
    const cycle = setInterval(() => {
      if (!auto.current) return;
      setView((current) => DEMO_VIEWS[(DEMO_VIEWS.findIndex((entry) => entry.id === current) + 1) % DEMO_VIEWS.length].id);
    }, 4500);
    return () => clearInterval(cycle);
  }, [reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return;
    const tick = setInterval(() => {
      setElapsed((current) => (current >= PERIOD_LENGTH - 1 ? 20 : current + 1));
    }, 2400);
    return () => clearInterval(tick);
  }, [reducedMotion]);

  const selectView = (next: DemoView) => {
    auto.current = false;
    setView(next);
  };

  const currentMinute = PERIOD_START + elapsed;
  const remaining = Math.max(0, PERIOD_END - currentMinute);
  const progress = Math.min(100, Math.round((elapsed / PERIOD_LENGTH) * 100));

  return <div className="relative w-[340px] max-w-full select-none" aria-label="Interactive preview of Quasar">
    <div className="relative rounded-[2.75rem] border-[9px] border-[#1f262e] bg-card p-3.5 shadow-2xl ring-1 ring-black/10 dark:border-[#2a333d] dark:ring-white/10">
      <div className="mx-auto mb-2 h-4.5 w-24 rounded-full bg-[#1f262e] dark:bg-[#2a333d]" aria-hidden="true" />
      <div className="flex items-center justify-between px-3 text-[11px] font-semibold text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />{remaining} min left</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase">Saved offline</span>
      </div>
      <div className="mt-2.5 flex items-baseline justify-between px-3">
        <span className="text-[26px] font-extrabold tracking-tight tabular-nums">{clockLabel(currentMinute)}</span>
        <span className="text-xs font-semibold text-muted-foreground">Tue · Day 6</span>
      </div>

      {/* Stack every demo screen in one grid cell so the phone is sized to the
          tallest view and does not jump when the auto-rotate or tabs switch. */}
      <div className="mt-3 grid">
        <DemoPane active={view === 'today'}><DemoToday remaining={remaining} progress={progress} /></DemoPane>
        <DemoPane active={view === 'schedule'}><DemoSchedule /></DemoPane>
        <DemoPane active={view === 'tasks'}><DemoTasks /></DemoPane>
        <DemoPane active={view === 'classes'}><DemoClasses /></DemoPane>
      </div>

      <nav className="mt-3 grid grid-cols-4 gap-1 rounded-2xl bg-muted p-1" aria-label="Demo view switcher">
        {DEMO_VIEWS.map((item) => {
          const active = item.id === view;
          return <button
            key={item.id}
            type="button"
            onClick={() => selectView(item.id)}
            aria-pressed={active}
            className={cn(
              'flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10.5px] font-bold transition-colors cursor-pointer',
              active ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name={item.icon} size={15} />
            {item.label}
          </button>;
        })}
      </nav>
    </div>
  </div>;
}

function DemoPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div
    className={cn('col-start-1 row-start-1', !active && 'invisible')}
    aria-hidden={!active}
    inert={!active}
  >
    {children}
  </div>;
}

function DemoHeading({ title, meta }: { title: string; meta: string }) {
  return <div className="flex items-baseline justify-between px-1">
    <h3 className="text-base font-extrabold tracking-tight">{title}</h3>
    <span className="text-xs text-muted-foreground">{meta}</span>
  </div>;
}

function DemoRow({ time, color, name, detail, highlight }: { time: string; color: string; name: string; detail?: string; highlight?: boolean }) {
  return <div className={cn('flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[13px]', highlight && 'bg-primary-soft text-primary-soft-foreground')}>
    <span className="w-10 font-bold tabular-nums text-muted-foreground">{time}</span>
    <span className="size-2 rounded-full shrink-0" style={{ background: color }} />
    <span className="flex-1 truncate font-semibold">{name}</span>
    {detail && <span className="text-[11px] text-muted-foreground">{detail}</span>}
  </div>;
}

function DemoList({ children }: { children: React.ReactNode }) {
  return <div className="mt-2.5 rounded-[1.15rem] bg-card p-1.5 shadow-sm">{children}</div>;
}

function DemoGroup({ children }: { children: React.ReactNode }) {
  return <p className="px-2 pt-3 pb-1 text-[11px] font-extrabold tracking-[0.07em] text-muted-foreground uppercase">{children}</p>;
}

function DemoCheck({ name, due, done }: { name: string; due?: string; done?: boolean }) {
  return <div className="flex items-center gap-3 px-2.5 py-2 text-[13.5px] not-first:border-t">
    <span className={cn('size-4.5 shrink-0 rounded-md border-2', done ? 'grid place-items-center border-primary bg-primary text-primary-foreground' : 'border-input')}>
      {done && <Icon name="check" size={11} strokeWidth={3.5} />}
    </span>
    <span className={cn('flex-1', done && 'text-muted-foreground line-through')}>{name}</span>
    {due && <span className="rounded-full bg-now-soft px-2 py-0.5 text-[10.5px] font-bold text-now-foreground">{due}</span>}
  </div>;
}

function DemoToday({ remaining, progress }: { remaining: number; progress: number }) {
  return <div>
    <DemoHeading title="Today" meta="Tue, Sep 22" />
    <div className="relative overflow-hidden rounded-[1.3rem] bg-linear-140 from-primary to-[color-mix(in_srgb,var(--primary)_62%,#0b1a22)] p-4 text-primary-foreground">
      <span className="absolute -right-10 -top-13 size-31 rounded-full bg-white/10" aria-hidden="true" />
      <div className="flex justify-between text-[10.5px] font-extrabold tracking-[0.08em] uppercase text-primary-foreground/75">
        <span>Right now</span><span>{remaining > 0 ? `Ends in ${remaining} min` : 'Ending now'}</span>
      </div>
      <b className="mt-2 block text-[25px] leading-tight tracking-tight">Chemistry</b>
      <p className="text-[12.5px] text-primary-foreground/85">10:50 - 11:40 AM · Period C · Rm 214</p>
      <div className="my-3 h-1.5 overflow-hidden rounded-full bg-white/25">
        <span className="block h-full rounded-full bg-white transition-[width] duration-700" style={{ width: `${Math.min(100, progress)}%` }} />
      </div>
      <p className="text-[12.5px] text-primary-foreground/85">Then <strong>Lunch · Wave 2</strong> at 11:45 AM</p>
    </div>
    <DemoList>
      <DemoRow time="11:45" color={CLASS_COLORS.lunch} name="Lunch · Wave 2" />
      <DemoRow time="12:15" color={CLASS_COLORS.history} name="US History" detail="Room 305" />
      <DemoRow time="1:10" color={CLASS_COLORS.algebra} name="Algebra II" detail="Room 101" />
    </DemoList>
    <DemoGroup>Due soon</DemoGroup>
    <DemoList><DemoCheck name="Lab report" due="Tomorrow" /></DemoList>
  </div>;
}

function DemoSchedule() {
  return <div>
    <DemoHeading title="Schedule" meta="Day 6 of 10" />
    <DemoList>
      <DemoRow time="8:05" color={CLASS_COLORS.english} name="English 11" detail="Period B · Rm 118" />
      <DemoRow time="9:00" color={CLASS_COLORS.spanish} name="Spanish III" detail="Period D · Rm 221" />
      <DemoRow time="9:55" color={CLASS_COLORS.study} name="Study hall" detail="Period G · Library" />
      <DemoRow time="10:50" color={CLASS_COLORS.chemistry} name="Chemistry" detail="Period C · Rm 214 · now" highlight />
      <DemoRow time="11:45" color={CLASS_COLORS.lunch} name="Lunch · Wave 2" />
      <DemoRow time="12:15" color={CLASS_COLORS.history} name="US History" detail="Period A · Rm 305" />
      <DemoRow time="1:10" color={CLASS_COLORS.algebra} name="Algebra II" detail="Period F · Rm 101" />
    </DemoList>
  </div>;
}

function DemoTasks() {
  return <div>
    <DemoHeading title="Tasks" meta="4 open" />
    <DemoGroup>Tomorrow</DemoGroup>
    <DemoList><DemoCheck name="Lab report · Chemistry" due="11:59 PM" /></DemoList>
    <DemoGroup>This week</DemoGroup>
    <DemoList>
      <DemoCheck name="Ch. 7 problems" due="Thu" />
      <DemoCheck name="Permission slip" due="Fri" />
      <DemoCheck name="Practice · 30 min" due="Daily" />
    </DemoList>
    <DemoGroup>Completed</DemoGroup>
    <DemoList><DemoCheck name="Read Act II" done /></DemoList>
  </div>;
}

function DemoClasses() {
  const classes: ReadonlyArray<[string, string, string]> = [
    ['English 11', 'Period B · Rm 118', CLASS_COLORS.english],
    ['Chemistry', 'Period C · Rm 214', CLASS_COLORS.chemistry],
    ['US History', 'Period A · Rm 305', CLASS_COLORS.history],
    ['Algebra II', 'Period F · Rm 101', CLASS_COLORS.algebra],
    ['Spanish III', 'Period D · Rm 221', CLASS_COLORS.spanish],
    ['Study hall', 'Period G · Library', CLASS_COLORS.study],
  ];
  return <div>
    <DemoHeading title="Classes" meta="6 classes" />
    <div className="grid grid-cols-2 gap-2.5">
      {classes.map(([name, detail, color]) => <div key={name} className="rounded-[1.15rem] bg-card p-3.5 shadow-sm">
        <span className="mb-2.5 block size-6.5 rounded-lg" style={{ background: color }} />
        <b className="block text-[13.5px] tracking-tight">{name}</b>
        <span className="text-[11px] text-muted-foreground">{detail}</span>
      </div>)}
    </div>
  </div>;
}

/* ---------- Page ---------- */

export function Welcome({ message }: { message?: string }) {
  const [answers, setAnswers] = useState<ReadonlyArray<Answer | null>>(() => QUESTIONS.map(() => null));
  const [expandedCount, setExpandedCount] = useState(1);

  const { score, answered, complete } = useMemo(() => {
    const answeredCount = answers.filter((answer) => answer !== null).length;
    return {
      score: answers.filter((answer) => answer === 'yes').length,
      answered: answeredCount,
      complete: answeredCount === QUESTIONS.length,
    };
  }, [answers]);

  const choose = (index: number, answer: Answer) => {
    setAnswers((current) => current.map((value, i) => (i === index ? answer : value)));
    setExpandedCount((current) => Math.min(QUESTIONS.length, Math.max(current, index + 2)));
  };

  return <div className="min-h-dvh overflow-x-clip bg-background">
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
        <Brand />
        <nav className="ml-auto hidden items-center gap-6 text-sm font-semibold text-muted-foreground md:flex">
          <a className="hover:text-foreground" href="#scorecard">Score your app</a>
          <a className="hover:text-foreground" href="#features">Features</a>
          <a className="hover:text-foreground" href="#start">Get started</a>
        </nav>
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <AppearanceToggle />
          <Button variant="primary" onClick={signInWithGoogle}>Sign in</Button>
        </div>
      </div>
    </header>

    <main>
      {/* Hero */}
      <section className="relative mx-auto max-w-6xl px-6 pt-12 pb-20">
        <span aria-hidden="true" className="pointer-events-none absolute -left-32 -top-12 size-96 rounded-full bg-primary/20 blur-3xl dark:bg-primary/10" />
        <span aria-hidden="true" className="pointer-events-none absolute -right-20 top-40 size-80 rounded-full bg-[#c4b5fd]/40 blur-3xl dark:bg-[#7c3aed]/15" />
        <div className="relative grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="max-lg:text-center">
            <h1 className="max-w-[14ch] text-[clamp(2.25rem,5.6vw,4.125rem)] leading-[1.05] font-extrabold tracking-tight max-lg:mx-auto">
              Where is my <span className="relative whitespace-nowrap">next class<span aria-hidden="true" className="absolute inset-x-0 bottom-1 -z-10 h-3.5 rounded-full bg-[#a5f3fc] dark:bg-primary/40" /></span>, and what is due?
            </h1>
            <p className="mt-6 max-w-[46ch] text-[18px] text-muted-foreground max-lg:mx-auto">
              Quasar answers both the second you open it, and it knows your school’s real rotation, lunch waves and closures, not a generic Monday to Friday.
            </p>
            {message && <Callout tone="warning" icon="info" role="status" className="mt-6 max-w-lg text-left max-lg:mx-auto">{message}</Callout>}
            <div className="mt-8 flex flex-wrap gap-3 max-lg:justify-center">
              <Button variant="primary" size="lg" className="gap-3" onClick={signInWithGoogle}><GoogleLogo />Continue with Google</Button>
              <Button size="lg" onClick={() => document.getElementById('scorecard')?.scrollIntoView({ behavior: 'smooth' })}>Score your current app</Button>
            </div>
            <ul className="mt-5 flex flex-wrap gap-4 text-sm text-muted-foreground max-lg:justify-center">
              {['Free forever', 'Works offline', 'No ads or trackers'].map((claim) => <li key={claim} className="flex items-center gap-1.5 cursor-default">
                <Icon name="check" size={15} strokeWidth={3} className="text-success" />{claim}
              </li>)}
            </ul>
          </div>
          <div className="flex justify-center max-lg:mt-2"><PhoneDemo /></div>
        </div>
      </section>

      {/* Scorecard */}
      <section id="scorecard" className="mx-auto max-w-6xl scroll-mt-20 px-6 pb-20">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <span className={cn('inline-block -rotate-1 rounded-full border-2 border-[#0b0e12] px-4 py-1 text-[13px] font-bold', LIME)}>
            ★ 11 questions · takes 30 seconds
          </span>
          <h2 className="mx-auto mt-6 max-w-[22ch] text-[clamp(1.875rem,4.4vw,3rem)] leading-[1.12] font-extrabold tracking-tight">
            How many of these does<br className="hidden sm:inline" />{' '}
            <span className="inline-block rounded-xl bg-[#d9f99d] px-3 py-1 text-[#0b0e12] shadow-xs">
              your app get right?
            </span>
          </h2>
          <p className="mt-5 text-[17px] text-muted-foreground">
            Not a feature list. These are the eleven behaviours that decide whether you still trust your schedule app on a weird week. Answer honestly. Quasar scores 11.
          </p>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="order-2 grid gap-3 lg:order-1">
            <ol className="grid gap-2.5">
              {QUESTIONS.slice(0, expandedCount).map((question, index) => {
                const answer = answers[index];
                const isLatest = index === expandedCount - 1 && !complete;
                return <li
                  key={question.title}
                  className={cn(
                    'flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border bg-card px-5 py-4 transition-all duration-300 animate-in fade-in-0 slide-in-from-top-2',
                    answer && 'shadow-[inset_3px_0_0_var(--primary)]',
                    isLatest && !answer && 'border-primary/50 ring-1 ring-primary/25'
                  )}
                >
                  <div className="min-w-56 flex-1">
                    <p className="text-[15px] font-bold tracking-tight">{index + 1}. {question.title}</p>
                    <p className="mt-1 text-[13px] text-muted-foreground">{question.detail}</p>
                  </div>
                  <ToggleGroup
                    type="single"
                    value={answer ?? ''}
                    onValueChange={(next) => { if (next) choose(index, next as Answer); }}
                    aria-label={question.title}
                    spacing={1}
                    className="rounded-full bg-muted p-[3px] max-lg:w-full"
                  >
                    <ToggleGroupItem value="yes" size="sm" className="h-8 rounded-full px-4 text-[12.5px] font-bold text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-success data-[state=on]:text-white max-lg:flex-1 cursor-pointer">Yes</ToggleGroupItem>
                    <ToggleGroupItem value="no" size="sm" className="h-8 rounded-full px-4 text-[12.5px] font-bold text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-destructive data-[state=on]:text-white max-lg:flex-1 cursor-pointer">No</ToggleGroupItem>
                  </ToggleGroup>
                </li>;
              })}
            </ol>
            {expandedCount < QUESTIONS.length && (
              <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                <span>Question {Math.min(expandedCount, QUESTIONS.length)} of {QUESTIONS.length}</span>
                <button
                  type="button"
                  onClick={() => setExpandedCount(QUESTIONS.length)}
                  className="font-medium underline hover:text-foreground cursor-pointer"
                >
                  Show all {QUESTIONS.length} questions
                </button>
              </div>
            )}
          </div>

          <aside className="order-1 rounded-3xl border bg-card p-6 text-center shadow-sm lg:sticky lg:top-24 lg:order-2">
            <p className="text-[11.5px] font-extrabold tracking-[0.09em] text-muted-foreground uppercase">Your current app</p>
            <p className="mt-2 text-6xl leading-none font-extrabold tracking-tighter">
              {score}<span className="text-2xl text-muted-foreground">/{QUESTIONS.length}</span>
            </p>
            <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div
                className="h-full rounded-full bg-gradient-to-r from-destructive via-now to-success transition-[width] duration-500"
                style={{ width: `${answered === 0 ? 0 : (score / QUESTIONS.length) * 100}%` }}
              />
            </div>
            <p className="mt-3 min-h-13 text-sm text-muted-foreground" role="status">
              {answered === 0
                ? 'Answer the questions to see how it does.'
                : !complete
                  ? <><strong className="text-foreground">{QUESTIONS.length - answered}</strong> to go.</>
                  : (() => {
                    const verdict = VERDICTS.find((entry) => score <= entry.upTo)!;
                    return <><strong className="text-foreground">{verdict.lead}</strong> {verdict.rest}</>;
                  })()}
            </p>

            <div className="my-5 border-t" />

            <div className="flex items-center justify-between rounded-2xl bg-primary-soft px-4 py-3 text-primary-soft-foreground">
              <span className="flex items-center gap-2 text-[15px] font-bold"><Icon name="star" size={17} strokeWidth={2.2} />Quasar</span>
              <span className="text-[15px] font-extrabold">{QUESTIONS.length} / {QUESTIONS.length}</span>
            </div>
            <Button variant="primary" className="mt-4 w-full" onClick={signInWithGoogle}>Switch in two minutes</Button>
            <button
              type="button"
              className="mt-3 text-[12.5px] font-semibold text-muted-foreground underline hover:text-foreground cursor-pointer"
              onClick={() => {
                setAnswers(QUESTIONS.map(() => null));
                setExpandedCount(1);
              }}
            >
              Start over
            </button>
          </aside>
        </div>
      </section>

      {/* Payoff */}
      <section className={cn('py-20', INK_BAND)}>
        <div className="mx-auto max-w-6xl px-6 text-center">
          <h2 className="mx-auto max-w-[20ch] text-[clamp(1.75rem,3.8vw,2.625rem)] leading-[1.06] font-extrabold tracking-tight">
            Every one of those is a day you showed up to the wrong room.
          </h2>
          <p className="mx-auto mt-5 max-w-[58ch] text-[17px] text-white/60 dark:text-muted-foreground">
            They look like edge cases on a feature list. In a school year they are most weeks, and they are exactly what Quasar was built around first.
          </p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <h2 className="mx-auto max-w-[24ch] text-center text-[clamp(1.875rem,4vw,2.75rem)] leading-[1.06] font-extrabold tracking-tight">
          Built around the stuff that breaks other apps
        </h2>
        <p className="mx-auto mt-4 max-w-[52ch] text-center text-[17px] text-muted-foreground">
          Rotations, exceptions and bad Wi-Fi. Get those right and the rest is easy.
        </p>
        <div className="mt-12 grid gap-4 md:grid-cols-6">
          {FEATURES.map((feature) => <div key={feature.title} className={cn('rounded-3xl border bg-card p-7', feature.wide ? 'md:col-span-3' : 'md:col-span-2')}>
            <span className={cn('mb-4 grid size-11 place-items-center rounded-2xl bg-linear-135 text-white', feature.gradient)}><Icon name={feature.icon} size={20} /></span>
            <h3 className="text-[19px] font-bold tracking-tight">{feature.title}</h3>
            <p className="mt-2 text-[15px] text-muted-foreground">{feature.body}</p>
          </div>)}
        </div>
      </section>

      {/* Steps */}
      <section id="start" className="mx-auto max-w-6xl scroll-mt-20 px-6 pb-20">
        <h2 className="text-center text-[clamp(1.75rem,3.8vw,2.625rem)] font-extrabold tracking-tight">Two minutes, then it is just there</h2>
        <ol className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map((step, index) => <li key={step.title} className="rounded-3xl border bg-card p-7">
            <span className={cn('mb-4 grid size-9 place-items-center rounded-xl text-[15px] font-extrabold', LIME)}>{index + 1}</span>
            <h3 className="text-[18px] font-bold tracking-tight">{step.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
          </li>)}
        </ol>
      </section>

      {/* Close */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="rounded-[2rem] bg-primary px-6 py-20 text-center text-primary-foreground">
          <h2 className="mx-auto max-w-[17ch] text-[clamp(2rem,4.8vw,3.25rem)] leading-[1.05] font-extrabold tracking-tight">
            Eleven out of eleven, every weird week.
          </h2>
          <p className="mx-auto mt-5 max-w-[50ch] text-[17px] text-primary-foreground/85">
            Free, offline-friendly, and built around the days that break everything else.
          </p>
          <Button size="lg" className="mt-8 bg-background text-foreground hover:bg-background/90" onClick={signInWithGoogle}>Get started free</Button>
        </div>
      </section>
    </main>

    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-4 px-6 py-8 text-[13px] text-muted-foreground">
        <span>© 2026 Quasar · Made by a student, for students</span>
        <span>Your schedule stays on your account.</span>
      </div>
    </footer>
  </div>;
}
