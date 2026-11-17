'use client';

import { useEffect, useState } from 'react';
import { AttentionGap } from '../attention-videos';
import { api, errorMessage } from '@/client/api';
import { upcomingDaysOff } from '@/domain/days-off';
import { menuMainDish } from '@/domain/menu';
import { GRADES, effectiveSchedule, gradeLabel, resolveDayInRange, scheduleForGrade, scheduleSchema, type Grade, type Schedule } from '@/domain/schedule';
import { formatDate, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { Beta, useBeta } from '../betas';
import { Icon, type IconName } from '../icon';
import { LunchMenuSection, useLunchMenu } from '../lunch-menu';
import { BellTimeChoice, CycleDayAdjustmentSheet, PrivateScheduleSheet } from '../overrides';
import { ScheduleSignalsSection } from '../schedule-signals';
import { editSchedule } from '../schedule-lock';
import { RotationOverview } from '../rotation-overview';
import { RotationTimeline } from '../rotation-timeline';
import { SchoolLogoSection, SchoolMark } from '../school-logo';
import { ComposeProposal, type ProposalSeed, ProposalsSection } from '../proposals';
import { describeIssues, Preview, ScheduleEditor, ScheduleSummary } from '../schedule-editor';
import { Button, Callout, Chip, Field, Hint, Modal, Panel, Section, Segmented, Spacer, Textarea } from '../primitives';
import { Label } from '../ui/label';
import { Toggle } from '../ui/toggle';

function SchoolCrest({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
  return <span aria-hidden="true" className="grid size-14 shrink-0 place-items-center rounded-2xl text-[18px] font-extrabold tracking-tight text-primary-foreground shadow-[0_6px_18px_-6px_color-mix(in_srgb,var(--primary)_70%,transparent),inset_0_1px_0_rgb(255_255_255/0.25)]"
    style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 80%, white) 0%, var(--primary) 55%, color-mix(in srgb, var(--primary) 70%, black) 100%)' }}>{initials || 'S'}</span>;
}

function FactRow({ icon, tone = 'neutral', children }: { icon: IconName; tone?: 'neutral' | 'success' | 'warning'; children: React.ReactNode }) {
  const tones = { neutral: 'bg-secondary text-secondary-foreground', success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning' };
  return <li className="flex gap-3"><span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg', tones[tone])}><Icon name={icon} size={15} strokeWidth={2.2} /></span><span className="text-sm leading-relaxed">{children}</span></li>;
}

/**
 * How a school's shared schedule is locked. `voting` mirrors the server's proposal rule (src/server/proposals.ts):
 * proposals exist only for member-locked schools (10 or more members). A smaller school that support locked has no
 * member editing and no voting; its changes go through a correction request to support.
 */
export function schoolLocks(school: { supportLocked: boolean; memberLocked: boolean; memberCount: number }): { locked: boolean; voting: boolean } {
  const voting = school.memberLocked || school.memberCount >= 10;
  return { locked: school.supportLocked || voting, voting };
}

export function SchoolView({ state }: { state: AppState }) {
  const { context, personal, online } = state;
  const school = context.school;
  const sharedSchedule = scheduleForGrade(school.schedule, personal.grade);
  const [gradeError, setGradeError] = useState('');
  const { locked, voting } = schoolLocks(school);
  const [editing, setEditing] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [bellChoice, setBellChoice] = useState(false);
  const [personalIntent, setPersonalIntent] = useState(false);
  const [correction, setCorrection] = useState<(ProposalSeed & { onSaved?: () => void }) | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [adjustCycleDay, setAdjustCycleDay] = useState<string | null>(null);
  const rotation = effectiveSchedule(state.schedule, personal).cycleDays.length > 1;
  // Older bell-time links still open the same shared-or-personal choice. Clear the one-shot parameter.
  const fix = state.params.get('fix');
  const { navigate } = state;
  useEffect(() => {
    if (fix !== 'times') return;
    setBellChoice(true);
    navigate('school', {}, { replace: true });
  }, [fix, navigate]);

  const redesign = useBeta(SCHOOL_REDESIGN_BETA);
  // "Full week" on Today asks for the lunch menu; in the redesign that is a section of its own.
  const wantsMenu = state.params.get('menu') === 'open';
  useEffect(() => {
    if (redesign && wantsMenu) navigate('school', { section: 'lunch' }, { replace: true });
  }, [redesign, wantsMenu, navigate]);

  const requestedSection = state.params.get('section');
  useEffect(() => {
    if (!redesign && requestedSection === 'correction') {
      document.getElementById('correction-title')?.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  }, [redesign, requestedSection]);

  const chips = <>
    {school.approved ? <Chip tone="success" icon="check">Approved by support</Chip> : <Chip tone="warning" icon="users">Community schedule · not reviewed</Chip>}
    {school.supportLocked && <Chip icon="lock">Locked by support</Chip>}
    {!school.supportLocked && voting && <Chip icon="lock">Locked at 10 members</Chip>}
    {!locked && <Chip icon="unlock">Members can edit</Chip>}
  </>;
  const managed = <Section id="status-title" title="How this schedule is managed" icon="info">
    <ul className="grid gap-3">
      <FactRow icon={school.approved ? 'checkCircle' : 'info'} tone={school.approved ? 'success' : 'warning'}>{school.approved ? 'Support has checked this schedule against the school’s published one.' : 'This schedule was entered by students and has not been checked by support yet. Compare it with the school’s published schedule.'}</FactRow>
      <FactRow icon={locked ? 'lock' : 'unlock'}>{school.supportLocked ? (voting ? 'Support locked the shared schedule. Verified members can still propose and vote on changes; support publishes the ones that pass.' : 'Support locked the shared schedule, so only support publishes changes. Send a correction request below.') : voting ? 'Shared editing locked when the school reached 10 members, so one person cannot change everyone’s schedule. Verified members propose changes and vote on them below, or send a correction request.' : `Any member can edit the shared schedule until the school reaches 10 members (${school.memberCount} now). Every edit is saved as a new revision that other members review.`}</FactRow>
      <FactRow icon="users">School corrections keep your classes saved. Bell times you have not changed follow the school. When a correction matches your personal time change, that time follows the school again.</FactRow>
    </ul>
  </Section>;
  const source = <Section id="source-title" title="Your schedule source" icon="school">
    <div className="grid gap-2">
      <Label className="text-[13px] font-semibold text-foreground/80">Your grade</Label>
      <Segmented<Grade> label="Your grade" value={personal.grade ?? ('' as Grade)} options={GRADES.map((grade) => ({ value: grade, label: gradeLabel(grade) }))} onChange={(grade) => {
        setGradeError('');
        void state.savePersonal({ ...personal, grade }).catch((err) => setGradeError(errorMessage(err)));
      }} />
    </div>
    {gradeError && <Callout tone="danger" role="alert">{gradeError}</Callout>}
    <Panel className="flex flex-wrap items-center gap-3">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', personal.customSchedule ? 'bg-now-soft text-now-foreground' : 'bg-primary-soft text-primary-soft-foreground')}><Icon name={personal.customSchedule ? 'edit' : 'school'} size={17} /></span>
      <div className="min-w-0 flex-1 basis-[200px] text-sm">
        <strong>{personal.customSchedule ? 'Private schedule' : 'School schedule'}</strong>
        <p className="text-xs text-muted-foreground">{personal.customSchedule ? 'You follow your own copy. School corrections do not change it.' : 'You follow the shared schedule, plus your own adjustments.'}</p>
      </div>
      {personal.customSchedule && <Button size="sm" onClick={() => editSchedule(state, () => setPrivateOpen(true))}>Manage</Button>}
    </Panel>
    {!personal.customSchedule && <><Button size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Advanced schedule settings</Button>{advanced && <Panel><Hint>A private schedule stops receiving school corrections.</Hint><Button size="sm" onClick={() => editSchedule(state, () => setPrivateOpen(true))}>Build a private schedule</Button></Panel>}</>}
  </Section>;
  const shared = <Section id="shared-title" title="Shared schedule" icon="layers" description={`Revision ${school.version}`}
    action={!locked ? <Button size="sm" icon="edit" disabled={!online} title={!online ? 'Connect to edit the shared schedule.' : undefined} onClick={() => setEditing(true)}>Edit shared schedule</Button> : undefined}>
    <ScheduleSummary schedule={sharedSchedule} brief={redesign} />
    <button type="button" className="inline-flex w-fit items-center gap-1 text-left text-sm font-semibold text-primary hover:underline" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Hide preview' : 'Preview on real dates'}<Icon name="chevronDown" size={14} className={cn('transition-transform', showPreview && 'rotate-180')} /></button>
    {showPreview && <Preview value={sharedSchedule} />}
    {!online && !locked && <Hint>Connect to the internet to edit the shared schedule.</Hint>}
  </Section>;
  const signals = <ScheduleSignalsSection state={state} onPropose={setCorrection} />;
  const correctionRequest = <CorrectionRequest accountId={context.user.id} online={online} />;
  const adjust = (day: string) => editSchedule(state, () => setAdjustCycleDay(day));
  const jump = (date: string) => state.navigate('schedule', { date });
  const dialogs = <>
    {bellChoice && <BellTimeChoice modal onCancel={() => setBellChoice(false)} onSchool={() => setCorrection({ schedule: sharedSchedule })} onPersonal={() => { setBellChoice(false); editSchedule(state, () => { setPersonalIntent(true); setAdjustCycleDay(sharedSchedule.cycleDays[0]?.id ?? null); }); }} />}
    <SharedEditorSheet accountId={context.user.id} open={editing} onClose={() => setEditing(false)} schedule={school.schedule} initialGrade={personal.grade ?? '9'} schoolId={school.id} version={school.version} onSaved={state.refresh} />
    <CycleDayAdjustmentSheet open={adjustCycleDay !== null} onClose={() => { setAdjustCycleDay(null); setPersonalIntent(false); }} personalIntent={personalIntent} cycleDayId={adjustCycleDay} school={sharedSchedule} personal={personal} save={state.savePersonal} onSchoolCorrection={(schedule, onSaved) => setCorrection({ schedule, onSaved })} />
    {correction && voting && <ComposeProposal state={state} seed={correction} onClose={() => setCorrection(null)} onSaved={async () => { correction.onSaved?.(); setCorrection(null); setBellChoice(false); await state.refresh(); }} />}
    {correction && !voting && !locked && <SharedEditorSheet accountId={context.user.id} open onClose={() => setCorrection(null)} schedule={school.schedule} initialGrade={personal.grade ?? '9'} seed={correction.schedule} schoolId={school.id} version={school.version} onSaved={state.refresh} onPublished={() => { correction.onSaved?.(); setCorrection(null); setBellChoice(false); }} />}
    {correction && locked && !voting && <Modal open onClose={() => setCorrection(null)} title="Request a school correction"><Hint>Support manages this school's schedule. Send the correction request below.</Hint><Button onClick={() => { setCorrection(null); if (redesign) navigate('school', { section: 'correction' }); else document.getElementById('correction-title')?.scrollIntoView({ behavior: 'smooth' }); }}>Open correction request</Button></Modal>}
    <PrivateScheduleSheet open={privateOpen} onClose={() => setPrivateOpen(false)} school={sharedSchedule} personal={personal} save={state.savePersonal} />
  </>;

  const classic = <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <header className="flex flex-wrap items-center gap-4">
      <SchoolCrest name={school.name} />
      {/* A 12rem basis makes the chips wrap onto their own row on phones. With basis 0 the name never forced a
          wrap, so short chips stayed beside it and squeezed it to one letter per line. */}
      <div className="grid min-w-0 flex-1 basis-48 gap-1">
        <h1>{school.name}</h1>
        <p className="text-sm text-muted-foreground">{school.location} · {pluralize(school.memberCount, 'member')}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">{chips}</div>
    </header>

    <div className="grid items-start gap-5 lg:grid-cols-2">{managed}{source}</div>

    {shared}

    <Section id="rotation-title" title={rotation ? 'Rotation' : 'Daily bell schedule'} icon="calendar" description={rotation ? 'Every day of the cycle and when it comes up next. Open a day to see its periods or adjust it for yourself.' : 'Open the day to see its periods or adjust it for yourself.'}>
      <RotationOverview state={state} onAdjust={adjust} onJump={jump} />
    </Section>

    <LunchMenuSection state={state} />

    {signals}
    {voting && <ProposalsSection state={state} />}

    <div className="grid items-start gap-5 lg:grid-cols-2">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] self-stretch">
      <Section data-attention-after="school-directory" id="school-directory-title" title="School class directory" icon="book" description="Find classes shared by schoolmates and add personal copies to your timetable.">
        <div><Button icon="search" onClick={() => state.navigate('classes', { directory: 'open' })}>Browse school classes</Button></div>
      </Section>
        <AttentionGap zone="school-directory" top={12} />
      </div>
      {correctionRequest}
    </div>

    {dialogs}
  </div>;

  return <Beta id={SCHOOL_REDESIGN_BETA} fallback={classic}>
    <SchoolHub state={state} voting={voting} panels={{
      rotation: <>
        <Section id="rotation-title" title={rotation ? 'Rotation' : 'Daily bell schedule'} icon="calendar" description={rotation ? 'Pick a day of the cycle to see its periods, or adjust it for yourself.' : 'The periods of a school day. Adjust them for yourself.'}>
          <RotationTimeline state={state} onAdjust={adjust} onJump={jump} />
        </Section>
        <DaysOffSection state={state} onJump={jump} />
        {shared}
        {!voting && signals}
      </>,
      lunch: <LunchMenuSection state={state} redesign />,
      changes: <>{signals}<ProposalsSection state={state} /></>,
      setup: source,
      correction: correctionRequest,
      logo: <SchoolLogoSection state={state} />,
      about: managed,
    }}>{dialogs}</SchoolHub>
  </Beta>;
}

/**
 * The beta that replaces the School page's single column of cards with the school card, a section list and one
 * section at a time. Its first key, `school-redesign`, was retired by a beta clean-up while this was still gated,
 * and a retired key is never reused (src/server/beta-registry.ts), so the beta continues under this one.
 */
export const SCHOOL_REDESIGN_BETA = 'school-hub';

type HubSection = 'rotation' | 'lunch' | 'changes' | 'setup' | 'correction' | 'logo' | 'about';

function HubRow({ icon, title, detail, value, active, away, onClick }: { icon: IconName; title: string; detail?: string; value?: string; active?: boolean; away?: boolean; onClick: () => void }) {
  // The chosen row is tinted on wide screens only: a phone shows the list by itself, with no section open beside it.
  return <button type="button" aria-current={active ? 'page' : undefined} onClick={onClick}
    className={cn('flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset', active && 'lg:bg-primary-soft lg:text-primary-soft-foreground lg:hover:bg-primary-soft')}>
    <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-secondary-foreground', active && 'lg:bg-primary/15 lg:text-primary-soft-foreground')}><Icon name={icon} size={16} strokeWidth={2.2} /></span>
    <span className="grid min-w-0 flex-1">
      <strong className="truncate text-sm font-bold">{title}</strong>
      {detail && <span className={cn('truncate text-[12.5px] text-muted-foreground', active && 'lg:text-primary-soft-foreground/80')}>{detail}</span>}
    </span>
    {value && <span className={cn('shrink-0 text-[13px] font-semibold text-muted-foreground', active && 'lg:text-primary-soft-foreground/80')}>{value}</span>}
    <Icon name={away ? 'arrowRight' : 'chevronRight'} size={16} className={cn('shrink-0 text-muted-foreground', active && 'lg:text-primary-soft-foreground/80')} />
  </button>;
}

/**
 * The redesigned School page: the school card and a list of sections, with the chosen section beside it. A phone
 * shows the list alone and opens a section as its own screen; `?section=` holds the choice, so Back returns to the list.
 */
function SchoolHub({ state, voting, panels, children }: { state: AppState; voting: boolean; panels: Record<HubSection, React.ReactNode>; children: React.ReactNode }) {
  const { context, personal, today } = state;
  const school = context.school;
  const schedule = effectiveSchedule(state.schedule, personal);
  const rotation = schedule.cycleDays.length > 1;
  const sections: HubSection[] = ['rotation', 'lunch', ...(voting ? ['changes' as const] : []), 'setup', 'correction', 'logo', 'about'];
  const open = sections.find((id) => id === state.params.get('section')) ?? null;
  const shown = open ?? 'rotation';
  const { menu } = useLunchMenu(state, today);
  const todayDay = resolveDayInRange(state.schedule, today, personal);
  const menuToday = menu?.source ? menu.days.find((day) => day.date === today) : undefined;
  const lunchToday = menuToday ? menuMainDish(menuToday) : undefined;
  const go = (id: HubSection) => state.navigate('school', { section: id });
  const classPeriods = schedule.periods.filter((period) => period.kind === 'class').length;
  const lock: { icon: IconName; tone: string; text: string } = school.supportLocked ? { icon: 'lock', tone: 'text-muted-foreground', text: 'Locked by support' }
    : voting ? { icon: 'lock', tone: 'text-muted-foreground', text: 'Locked at 10 members' } : { icon: 'unlock', tone: 'text-muted-foreground', text: 'Members can edit' };
  const status: Array<{ icon: IconName; tone: string; text: string }> = school.approved && school.supportLocked ? [{ icon: 'checkCircle', tone: 'text-success', text: 'Approved and locked by support' }]
    : [school.approved ? { icon: 'checkCircle', tone: 'text-success', text: 'Approved' } : { icon: 'info', tone: 'text-warning', text: 'Not reviewed' }, lock];
  const stat = (value: React.ReactNode, label: string) => <div className="grid gap-0.5 rounded-xl bg-muted/70 px-2 py-2.5 text-center ring-1 ring-inset ring-foreground/[0.04]"><strong className="text-[17px] font-extrabold tracking-tight tabular-nums">{value}</strong><span className="text-[11px] font-bold text-muted-foreground">{label}</span></div>;
  return <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 animate-in fade-in-0 duration-300 lg:grid-cols-[340px_minmax(0,1fr)]">
    <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-4', open && 'max-lg:hidden')}>
      <header className="grid gap-4 rounded-2xl bg-card p-4 shadow-card ring-1 ring-foreground/[0.06] sm:p-5 dark:ring-foreground/[0.09]">
        <div className="flex items-center gap-4">
          <SchoolMark name={school.name} logo={school.logo} />
          <div className="grid min-w-0 gap-0.5">
            <h1 className="text-[22px] lg:text-[23px]">{school.name}</h1>
            <p className="text-sm text-muted-foreground">{school.location}</p>
          </div>
        </div>
        {/* One line of status in place of two stacked pills; "How this is managed" has the details. */}
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] font-semibold">
          {status.map((entry) => <li key={entry.text} className={cn('inline-flex items-center gap-1.5', entry.tone)}><Icon name={entry.icon} size={13} strokeWidth={2.4} />{entry.text}</li>)}
        </ul>
        <div className="grid grid-cols-3 gap-2">
          {stat(school.memberCount, school.memberCount === 1 ? 'member' : 'members')}
          {rotation ? stat(schedule.cycleDays.length, 'day cycle') : stat(classPeriods, classPeriods === 1 ? 'class period' : 'class periods')}
          {stat(school.version, 'revision')}
        </div>
      </header>
      <nav aria-label="School sections" className="grid gap-0.5 rounded-2xl bg-card p-2 shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]">
        <HubRow icon="calendar" title={rotation ? 'Rotation' : 'Bell schedule'} detail={todayDay && !todayDay.closed ? (rotation ? `${todayDay.cycleDayLabel} today` : 'Same every day') : 'No school today'} active={shown === 'rotation'} onClick={() => go('rotation')} />
        <HubRow icon="utensils" title="Lunch menu" detail={lunchToday ?? (menu && !menu.source ? 'Not set up' : 'This week')} active={shown === 'lunch'} onClick={() => go('lunch')} />
        {voting && <HubRow icon="users" title="Proposed changes" detail="Vote on schedule changes" active={shown === 'changes'} onClick={() => go('changes')} />}
        <HubRow icon="school" title="Your setup" detail={personal.customSchedule ? 'Private schedule' : 'School schedule'} value={personal.grade ? gradeLabel(personal.grade) : undefined} active={shown === 'setup'} onClick={() => go('setup')} />
        <HubRow icon="inbox" title="Request a correction" detail="Tell support what is wrong" active={shown === 'correction'} onClick={() => go('correction')} />
        <HubRow icon="imageUp" title="School logo" detail={school.logo ? 'Propose a new one' : voting ? 'Propose one and vote' : 'Add a logo for everyone'} active={shown === 'logo'} onClick={() => go('logo')} />
        <HubRow icon="info" title="How this is managed" detail={school.approved ? 'Approved by support' : 'Not reviewed yet'} active={shown === 'about'} onClick={() => go('about')} />
        <HubRow icon="book" title="School classes" detail="Shared by schoolmates" away onClick={() => state.navigate('classes', { directory: 'open' })} />
      </nav>
    </div>
    <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5', !open && 'max-lg:hidden')}>
      <Button size="sm" variant="ghost" icon="chevronLeft" className="w-fit lg:hidden" onClick={() => state.navigate('school')}>School</Button>
      {panels[shown]}
    </div>
    {children}
  </div>;
}

/** The next few days off and special schedules, from the schedule's exceptions. Draws nothing when there are none. */
function DaysOffSection({ state, onJump }: { state: AppState; onJump: (date: string) => void }) {
  const days = upcomingDaysOff(effectiveSchedule(state.schedule, state.personal), state.today);
  if (days.length === 0) return null;
  return <Section id="days-off-title" title="Coming up" icon="calendar" description="Days off and special schedules on the school calendar.">
    <ul className="grid gap-1">
      {days.map((day) => <li key={day.start}>
        <button type="button" onClick={() => onJump(day.start)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <span className="w-28 shrink-0 text-[13px] font-bold tabular-nums text-muted-foreground">{day.start === day.end ? formatDate(day.start, { weekday: 'short' }) : `${formatDate(day.start)} – ${formatDate(day.end)}`}</span>
          <span className="min-w-0 flex-1 font-medium">{day.kind === 'closed' ? 'No school' : 'Special schedule'}</span>
          <Icon name="chevronRight" size={16} className="shrink-0 text-muted-foreground" />
        </button>
      </li>)}
    </ul>
  </Section>;
}

function CorrectionRequest({ accountId, online }: { accountId: string; online: boolean }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  return <Section id="correction-title" title="Request a correction" icon="inbox" description="Spotted a wrong bell time or a missing day off? Tell support.">
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setError(''); setSent(false);
      try { await api.school.requestCorrection.mutate({ accountId, message: message.trim() }); setMessage(''); setSent(true); }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>
      <Field label="What needs to change?" htmlFor="correction" hint="At least 10 characters."><Textarea id="correction" required minLength={10} maxLength={5000} value={message} placeholder="Example: Day 3 lunch is 11:20–11:50, not 11:40–12:10. See the district bell schedule PDF…" onChange={(event) => setMessage(event.target.value)} /></Field>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      {sent && <Callout tone="success" icon="check" role="status">Sent to support. You will see the correction here once it is published.</Callout>}
      <div className="flex items-center gap-3"><Button type="submit" variant="primary" busy={pending} disabled={!online || message.trim().length < 10}>Send to support</Button>{!online && <Hint>Connect to send a request.</Hint>}</div>
    </form>
  </Section>;
}

export function SharedEditorSheet({ accountId, open, onClose, schedule, initialGrade, schoolId, version, onSaved, seed, onPublished }: { accountId: string; open: boolean; onClose: () => void; schedule: Schedule; initialGrade: Grade; schoolId: string; version: number; onSaved: () => Promise<boolean>; seed?: Schedule; onPublished?: () => void }) {
  return open ? <SharedEditorBody accountId={accountId} onClose={onClose} schedule={schedule} initialGrade={initialGrade} schoolId={schoolId} version={version} onSaved={onSaved} seed={seed} onPublished={onPublished} /> : null;
}

type Notice = { tone: 'success' | 'warning'; text: string };

function SharedEditorBody({ accountId, onClose, schedule, initialGrade, schoolId, version, onSaved, seed, onPublished }: { accountId: string; onClose: () => void; schedule: Schedule; initialGrade: Grade; schoolId: string; version: number; onSaved: () => Promise<boolean>; seed?: Schedule; onPublished?: () => void }) {
  // Frozen when the editor opens: the background sync updates the live props, and publishing against them would
  // pass the server's stale-revision check and silently replace a classmate's newer revision.
  const [base, setBase] = useState(() => ({ version, schedule }));
  const [adopt, setAdopt] = useState(false);
  if (adopt) {
    setAdopt(false);
    if (version !== base.version) setBase({ version, schedule });
  }
  const [grade, setGrade] = useState<Grade>(initialGrade);
  const [copyGrades, setCopyGrades] = useState<Grade[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<Grade, Schedule>>>(() => seed ? { [initialGrade]: seed } : {});
  const baseFor = (entry: Grade, from = base.schedule) => scheduleForGrade(from, entry);
  const draft = drafts[grade] ?? baseFor(grade);
  const setDraft = (value: Schedule) => setDrafts((current) => ({ ...current, [grade]: value }));
  const editedGrades = (from = base.schedule, source = drafts) => GRADES.filter((entry) => source[entry] && JSON.stringify(source[entry]) !== JSON.stringify(baseFor(entry, from)));
  const edited = editedGrades();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stale, setStale] = useState(false);
  const moved = version > base.version;
  const issues = describeIssues(draft);
  const clearMessages = () => { setError(''); setNotice(null); };
  // Copying replaces this grade's draft, so unpublished edits need a confirmation first; the result is announced.
  const [copyConfirm, setCopyConfirm] = useState<Grade | null>(null);
  const copyFrom = (entry: Grade) => {
    setDraft(structuredClone(drafts[entry] ?? baseFor(entry)));
    setCopyConfirm(null);
    setError('');
    setNotice({ tone: 'success', text: `Copied ${gradeLabel(entry)} into ${gradeLabel(grade)}. Publish to save it.` });
  };
  const submit = async () => {
    setPending(true); clearMessages(); setStale(false); setCopyConfirm(null);
    try {
      const saved = [grade, ...copyGrades];
      const updated = await api.school.update.mutate({ accountId, schoolId, expectedVersion: base.version, schedule: scheduleSchema.parse(draft), grades: saved });
      // Move the base to our own revision so the next grade's publish is not rejected as stale.
      setBase({ version: updated.version, schedule: updated.schedule });
      const remaining = { ...drafts };
      for (const savedGrade of saved) delete remaining[savedGrade];
      setDrafts(remaining);
      setCopyGrades([]);
      await onSaved();
      const left = editedGrades(updated.schedule, remaining);
      if (left.length === 0) { onPublished?.(); onClose(); }
      else setNotice({ tone: 'success', text: `${gradeLabel(grade)} published. ${left.map(gradeLabel).join(', ')} ${left.length === 1 ? 'still has' : 'still have'} unpublished edits.` });
    }
    catch (err) {
      const text = errorMessage(err);
      setError(text);
      if (/changed\. Reload/i.test(text)) setStale(true);
    } finally { setPending(false); }
  };
  const reload = async () => {
    setPending(true); clearMessages();
    try {
      // refresh reports failure instead of throwing; adopting then would keep the stale base and fail the next publish again.
      if (!(await onSaved())) { setError('Could not load the latest version. Check your connection and try again.'); return; }
      setAdopt(true);
      setStale(false);
      setNotice({ tone: 'warning', text: 'Reloaded. Your draft is still here; publishing now replaces the newer revision.' });
    } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <Modal open onClose={onClose} dirty={edited.length > 0} busy={pending} wide fullWidth title="Edit the shared schedule" description="Every member of the school sees your revision. Your classes stay saved. Personal changes that match the published correction return to the school default."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer />{stale && <Button variant="secondary" disabled={pending} onClick={() => void reload()}>Reload latest</Button>}<Button variant="primary" busy={pending} disabled={issues.length > 0} onClick={() => void submit()}>Publish revision</Button></>}>
    {moved && !stale && <Callout tone="warning" icon="alert" role="status" actions={<Button size="sm" variant="secondary" disabled={pending} onClick={() => void reload()}>Reload latest</Button>}>Someone published revision {version} while you were editing. Reload it before publishing; your draft stays.</Callout>}
    <div className="grid gap-4 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04] lg:grid-cols-2">
      <div className="grid gap-2">
        <Label className="text-[13px] font-semibold text-foreground/80">Grade to edit</Label>
        <Segmented<Grade> label="Grade to edit" value={grade} disabled={pending} options={GRADES.map((entry) => ({ value: entry, label: <>{gradeLabel(entry)}{edited.includes(entry) && <><span aria-hidden="true"> *</span><span className="sr-only"> (edited)</span></>}</> }))} onChange={(entry) => {
          setGrade(entry);
          setCopyGrades([]);
          setCopyConfirm(null);
          clearMessages();
        }} />
        <Hint>* marks unpublished edits.</Hint>
      </div>
      <div className="grid gap-2">
        <Label className="text-[13px] font-semibold text-foreground/80">Copy from</Label>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Copy from">
          {GRADES.filter((entry) => entry !== grade).map((entry) => <Button key={entry} size="sm" disabled={pending} onClick={() => {
            if (edited.includes(grade)) setCopyConfirm(entry);
            else copyFrom(entry);
          }}>{gradeLabel(entry)}</Button>)}
        </div>
        <Hint>Replace the current {gradeLabel(grade)} draft with another grade’s schedule.</Hint>
        {copyConfirm && <Callout tone="warning" icon="alert" role="alert" actions={<><Button size="sm" variant="danger" disabled={pending} onClick={() => copyFrom(copyConfirm)}>Replace my {gradeLabel(grade)} edits</Button><Button size="sm" variant="ghost" onClick={() => setCopyConfirm(null)}>Keep my edits</Button></>}>
          {gradeLabel(grade)} has unpublished edits. Copying {gradeLabel(copyConfirm)} replaces them and they cannot be restored.
        </Callout>}
      </div>
    </div>
    <ScheduleEditor key={grade} value={draft} onChange={setDraft} disabled={pending} />
    <fieldset disabled={pending} className="grid gap-2 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]">
      <legend className="sr-only">Copy to other grades (optional)</legend>
      <span className="text-[13px] font-semibold text-foreground/80">Copy to other grades (optional)</span>
      <Hint>Publishing saves {gradeLabel(grade)} and replaces the schedules of any grades selected below.</Hint>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Copy to">
        {GRADES.filter((entry) => entry !== grade).map((entry) => <Toggle key={entry} variant="outline" size="sm" pressed={copyGrades.includes(entry)} onPressedChange={(on) => setCopyGrades(on ? [...copyGrades, entry] : copyGrades.filter((target) => target !== entry))} className="rounded-full bg-card data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          {copyGrades.includes(entry) && <Icon name="check" size={14} />}{gradeLabel(entry)}
        </Toggle>)}
      </div>
    </fieldset>
    {notice && <Callout tone={notice.tone} icon={notice.tone === 'success' ? 'check' : 'alert'} role="status">{notice.text}</Callout>}
    {error && <Callout tone={stale ? 'warning' : 'danger'} icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
