'use client';

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { GoogleLogo } from './google-logo';
import { BrandLockup, BrandMark } from './shell';
import { AppearanceToggle } from './theme-picker';
import { Callout } from './primitives';
import { cn } from '@/lib/utils';

/**
 * Signed-out landing page, in the "Notebook" direction (mockups/4-notebook.html).
 *
 * The page is a sheet of ruled paper with a red margin. Headings are serif,
 * key phrases carry a marker highlight, the features are sticky notes, and
 * the closing checklist is laid out like a syllabus. The voice is a student's.
 *
 * Paper, rule and shadow colours are local CSS variables so the dark
 * appearance swaps to a dark sheet. Sticky notes and the "Today" card are
 * physical objects on the page and stay light in both appearances.
 */

const PAPER = '[--paper:#fcf9f1] [--rule:#cfe0f1] [--margin:#efaaaa] [--ink:#1f2430] [--pencil:#5b6270] [--shadow:#d9e2ef] dark:[--paper:#15161a] dark:[--rule:#232a36] dark:[--margin:#7a3b3b] dark:[--ink:#edf0f4] dark:[--pencil:#a2aab8] dark:[--shadow:#0a0b0e]';
const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';
const HIGHLIGHT = 'bg-[linear-gradient(transparent_40%,#fff27a_40%_92%,transparent_92%)] px-1 box-decoration-clone dark:bg-[linear-gradient(transparent_40%,#6b6100_40%_92%,transparent_92%)]';
const INK_BUTTON = 'inline-flex items-center gap-2.5 rounded-[10px] bg-[var(--ink)] px-[18px] py-[11px] font-sans text-[14px] leading-none font-semibold text-[var(--paper)] shadow-[3px_3px_0_var(--shadow)] cursor-pointer active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0_var(--shadow)]';
const OUTLINE_BUTTON = 'inline-flex items-center rounded-[10px] border-[1.5px] border-[var(--ink)] bg-white px-[18px] py-[11px] font-sans text-[14px] leading-none font-semibold text-[#1f2430] shadow-[3px_3px_0_var(--shadow)] cursor-pointer active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0_var(--shadow)]';

const STICKIES: ReadonlyArray<{ title: string; body: string; note: string; color: string; tilt: string }> = [
  { title: 'Eight-day rotation', body: 'Not A/B. Any cycle length, letter days, periods that change position from day to day.', note: '“Is it day 3 or day 4?” Never again.', color: 'bg-[#fff3a3]', tilt: '-rotate-[1.5deg]' },
  { title: 'Snow day on a Tuesday', body: 'Cycle days skip holidays and closures. The rotation doesn’t slide out by one for a month.', note: 'Wed became Day 4, like it should.', color: 'bg-[#ffd1dc]', tilt: 'rotate-[1deg]' },
  { title: '“Thursday runs as Monday”', body: 'Replacement days: one date, one setting. Every period, room and lunch wave follows.', note: 'Wave 2 lunch. It knew.', color: 'bg-[#cfe8ff]', tilt: '-rotate-[0.6deg]' },
  { title: 'Two-hour delay', body: 'Shift the whole day. Every start, end and countdown moves with it. Your own edits survive when the school corrects theirs.', note: 'My note on P3 was still there.', color: 'bg-[#d3f4d0]', tilt: 'rotate-[1.4deg]' },
  { title: 'The bus has no signal', body: 'Fully editable offline. Add a task, it’s there when you land and uploads by itself. Every change shows where it stands.', note: 'Saved · Waiting · Syncing', color: 'bg-[#e9dcff]', tilt: '-rotate-[1deg]' },
  { title: 'Reset after break', body: 'The school restarted the count after a closed week. You can tell Quasar that in one tap.', note: 'Cycle reset: Jan 6 → Day 1.', color: 'bg-[#ffe0c2]', tilt: 'rotate-[0.8deg]' },
];

const SYLLABUS: ReadonlyArray<{ lead: string; rest: string }> = [
  { lead: 'Tasks with priorities, checklists, repeats and notes.', rest: 'Teacher calendar feeds import themselves.' },
  { lead: 'Conflicts you resolve yourself.', rest: 'Two devices, same field: both values shown, you pick. Nothing silently overwritten.' },
  { lead: 'Lunch waves as real periods.', rest: 'Wave 1 and Wave 2 are different times, not a note.' },
  { lead: 'No ads, no trackers, nothing sold.', rest: 'You are the student, not the product.' },
  { lead: 'Share with the people you choose.', rest: 'One friend at a time, and take it back whenever.' },
];

const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  { title: 'Sign in with Google', body: 'No new password, nothing to install, no app store account.' },
  { title: 'Find or build your school', body: 'Already added? One tap. If not, enter the bell schedule once. Everyone after you gets it for free.' },
  { title: 'Drop classes on periods', body: 'Browse the class directory, pick yours, drag them on. Today fills itself in from then on.' },
];

const TODAY_ROWS: ReadonlyArray<{ time: string; name: string; room: string; next?: boolean }> = [
  { time: '9:20', name: 'Chemistry', room: '204' },
  { time: '10:10', name: 'Algebra II', room: '117', next: true },
  { time: '11:00', name: 'Lunch · Wave 2', room: 'Caf' },
  { time: '11:35', name: 'History', room: '221' },
];

function signInWithGoogle() {
  void signIn('google', { callbackUrl: '/' });
}

/** Chemistry has 14:32 left when the page opens; the card counts down slowly so it reads as live. */
function useCountdown() {
  const [seconds, setSeconds] = useState(14 * 60 + 32);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const tick = setInterval(() => setSeconds((current) => (current <= 8 * 60 ? 14 * 60 + 32 : current - 1)), 1000);
    return () => clearInterval(tick);
  }, []);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function TodayCard() {
  const remaining = useCountdown();
  return <div className="relative max-lg:mx-auto max-lg:max-w-md">
    <span aria-hidden="true" className="absolute -top-7 right-2 -rotate-6 text-[15px] italic text-[#c8443f]" style={{ fontFamily: SERIF }}>actually right today ↓</span>
    <div className="rotate-[1.2deg] rounded-[14px] border-[1.5px] border-[#1f2430] bg-white p-[18px] font-sans text-[#1f2430] shadow-[5px_5px_0_var(--shadow)] max-lg:rotate-0" aria-label="Preview of today in Quasar">
      <div className="mb-2.5 flex justify-between text-[12.5px] font-semibold text-[#5b6270]"><span>Today</span><span>Day 4 of 8</span></div>
      <div className="text-[56px] leading-none font-extrabold tracking-[-0.04em] tabular-nums">
        {remaining}<span className="ml-1.5 text-[15px] font-semibold tracking-normal text-[#5b6270]">left in Chemistry</span>
      </div>
      <div className="mt-3.5">
        {TODAY_ROWS.map((row) => <div key={row.name} className={cn('grid grid-cols-[52px_1fr_auto] items-center gap-2.5 border-t border-dashed border-[#d5dbe5] py-2 text-[13.5px] first:border-t-0', row.next && '-mx-2 rounded-lg bg-[#f5f9ff] px-2')}>
          <span className="text-[12px] text-[#5b6270] tabular-nums">{row.time}</span>
          <span>{row.name}{row.next && <i className="text-[#5b6270]"> · next</i>}</span>
          <span className="rounded-[5px] bg-[#fff27a] px-1.5 py-0.5 text-[11.5px] font-bold">{row.room}</span>
        </div>)}
      </div>
    </div>
  </div>;
}

function Highlight({ children }: { children: React.ReactNode }) {
  return <span className={HIGHLIGHT}>{children}</span>;
}

export function Welcome({ message }: { message?: string }) {
  return <div
    className={cn('min-h-dvh overflow-x-clip text-[17px] leading-relaxed text-[var(--ink)] antialiased', PAPER)}
    style={{ fontFamily: SERIF, background: 'var(--paper) repeating-linear-gradient(transparent 0 31px, var(--rule) 31px 32px)' }}
  >
    {/* Red margin line, like a ruled notebook. */}
    <span aria-hidden="true" className="pointer-events-none fixed inset-y-0 left-[max(24px,calc(50%-560px))] w-[2px] bg-[var(--margin)] opacity-70" />

    <div className="mx-auto max-w-[1000px] px-6 pl-14 max-md:pl-10">
      <header className="flex items-center justify-between py-[22px] font-sans">
        <a className="inline-flex items-center gap-2.5 text-[17px] font-bold tracking-tight text-[var(--ink)] no-underline hover:no-underline" href="#" aria-label="Quasar home">
          <BrandMark size={26} />Quasar
        </a>
        <div className="flex items-center gap-2">
          <AppearanceToggle />
          <button type="button" className={INK_BUTTON} onClick={signInWithGoogle}>Sign in</button>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="grid items-center gap-10 py-11 pb-10 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="mb-3 font-sans text-[13px] tracking-[0.08em] text-[var(--pencil)] uppercase">Thursday · Cycle day 4 · running as a Monday, apparently</p>
            <h1 className="[font-family:inherit] mb-[18px] text-[clamp(38px,5.6vw,66px)] leading-[1.05] font-semibold tracking-[-0.02em]">
              The schedule app for schools that <Highlight>can’t make up their mind.</Highlight>
            </h1>
            <p className="mb-[26px] max-w-[520px] text-[19px] text-[var(--pencil)]">
              Snow days, two-hour delays, a Thursday that runs on a Monday schedule, lunch in two waves. Quasar keeps up. It’s free, it works with no signal, and it never shows you an ad.
            </p>
            {message && <Callout tone="warning" icon="info" role="status" className="mb-6 max-w-lg font-sans">{message}</Callout>}
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={INK_BUTTON} onClick={signInWithGoogle}><GoogleLogo />Continue with Google</button>
              <a className={OUTLINE_BUTTON} href="#why">See what it handles</a>
              <small className="font-sans text-[13px] text-[var(--pencil)]">Two minutes to set up.</small>
            </div>
          </div>
          <TodayCard />
        </section>

        {/* Sticky notes */}
        <section id="why" className="scroll-mt-6 py-13">
          <h2 className="[font-family:inherit] mb-2 text-[clamp(28px,3.6vw,40px)] leading-[1.15] font-semibold tracking-[-0.015em]">
            Things my school did this year, <Highlight>and what Quasar did about it.</Highlight>
          </h2>
          <p className="mb-[26px] max-w-[600px] text-[var(--pencil)]">Every one of these is a setting, not a workaround.</p>
          <ul className="grid gap-[22px] md:grid-cols-2 lg:grid-cols-3">
            {STICKIES.map((sticky) => <li key={sticky.title} className={cn('relative min-h-[190px] px-5 pt-[22px] pb-6 font-sans text-[#333a48] shadow-[2px_6px_14px_rgba(0,0,0,0.12)] dark:shadow-[2px_6px_14px_rgba(0,0,0,0.5)]', sticky.color, sticky.tilt)}>
              <span aria-hidden="true" className="absolute -top-2 left-1/2 h-[18px] w-[70px] -translate-x-1/2 -rotate-2 bg-white/55 shadow-[0_1px_2px_rgba(0,0,0,0.08)]" />
              <h3 className="mb-1.5 text-[17px] font-bold tracking-[-0.01em] text-[#1f2430]">{sticky.title}</h3>
              <p className="text-[14px] leading-normal">{sticky.body}</p>
              <p className="mt-2.5 text-[14px] italic text-[#7a4e4e]" style={{ fontFamily: SERIF }}>{sticky.note}</p>
            </li>)}
          </ul>
        </section>

        {/* Syllabus */}
        <section className="py-13">
          <div className="rounded-[10px] border-[1.5px] border-[#1f2430] bg-white px-[30px] py-[26px] text-[#1f2430] shadow-[5px_5px_0_var(--shadow)] max-sm:px-5">
            <div className="mb-3 flex justify-between font-sans text-[12px] tracking-[0.12em] text-[#5b6270] uppercase"><span>Course requirements · Schedule app 101</span><span>Grade: Pass</span></div>
            <ol className="grid list-decimal gap-2 pl-[26px] text-[16.5px] marker:font-sans marker:font-bold marker:text-[#5b6270]">
              {SYLLABUS.map((item) => <li key={item.lead}>
                <span aria-hidden="true" className="relative mr-2 inline-block size-[18px] -translate-y-[3px] rounded-[4px] border-[1.5px] border-[#1f2430] bg-white align-middle">
                  <span className="absolute -top-1.5 left-0.5 -rotate-[8deg] font-sans text-[18px] font-extrabold text-[#c8443f]">✓</span>
                </span>
                {item.lead} <span className="text-[15px] text-[#5b6270]">{item.rest}</span>
              </li>)}
            </ol>
          </div>
        </section>

        {/* Steps */}
        <section id="start" className="py-13">
          <h2 className="[font-family:inherit] mb-2 text-[clamp(28px,3.6vw,40px)] leading-[1.15] font-semibold tracking-[-0.015em]">Homework: two minutes.</h2>
          <p className="mb-[26px] text-[var(--pencil)]">Then it’s just there.</p>
          <ol className="grid gap-6 font-sans md:grid-cols-3">
            {STEPS.map((step, index) => <li key={step.title}>
              <span className="mb-3 grid size-[34px] place-items-center rounded-full border-[1.5px] border-[var(--ink)] bg-white font-extrabold text-[#1f2430] shadow-[2px_2px_0_var(--shadow)]">{index + 1}</span>
              <h3 className="mb-1 text-[16.5px] font-bold">{step.title}</h3>
              <p className="text-[14.5px] text-[var(--pencil)]">{step.body}</p>
            </li>)}
          </ol>
        </section>

        {/* Close */}
        <section className="py-[70px] pb-[90px] text-center">
          <h2 className="[font-family:inherit] mx-auto max-w-[22ch] text-[clamp(30px,4.6vw,52px)] leading-[1.15] font-semibold tracking-[-0.015em]">
            Stop counting cycle days <Highlight>on your fingers.</Highlight>
          </h2>
          <p className="mx-auto mt-2 mb-[26px] text-[var(--pencil)]">Free for students. No ads, no trackers, nothing sold about you.</p>
          <button type="button" className={INK_BUTTON} onClick={signInWithGoogle}><GoogleLogo />Get started free</button>
          <div className="mt-14 flex justify-center"><BrandLockup height={150} /></div>
        </section>
      </main>

      <footer className="flex flex-wrap justify-between gap-2.5 py-5 pb-10 font-sans text-[13px] text-[var(--pencil)]">
        <span>© 2026 Quasar · Made by a student, for students</span>
        <span>Your schedule stays on your account.</span>
      </footer>
    </div>
  </div>;
}
