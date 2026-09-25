'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, type School, type SchoolSummary } from '@/client/api';
import { GRADES, gradeLabel, scheduleForGrade, scheduleSchema, type Grade, type Schedule, type ScheduleSlot } from '@/domain/schedule';
import { browserTimeZone, formatDate, pluralize, timeZones, todayIn, weekdayOf } from '@/lib/format';
import { applyTypicalDay, buildStarter, CYCLE_LENGTH_MAX, CYCLE_LENGTH_MIN, nextSchoolDay, parseCycleLength, starterDays, TEMPLATES, typicalDaySlots, upcomingSchoolDays, type TemplateKind } from '@/lib/templates';
import { cn } from '@/lib/utils';
import type { WorkspaceContext } from './app-state';
import { Icon } from './icon';
import { Days, describeIssues, Periods, Preview, ScheduleEditor, ScheduleSummary, SlotsEditor } from './schedule-editor';
import { classesStep } from './setup-state';
import { Brand } from './shell';
import { Button, Callout, ChoiceGroup, Chip, Eyebrow, Field, Hint, Input, OptionCard, Panel, Select, Spacer } from './primitives';
import { Card, CardContent } from './ui/card';
import { Label } from './ui/label';

type Step = 'names' | 'school' | 'create' | 'choice';
const STEP_TITLES = ['Your name', 'Your school', 'Your schedule', 'Your classes', 'Your homework'];
export const SETUP_STEPS = STEP_TITLES.length;
export const STEP_CLASSES = 4;
export const STEP_FEED = 5;

/** Opens the help page in a new tab. Shown on every setup screen and in the account sheet. */
export function HelpLink({ className }: { className?: string }) {
  return <a href="/help" target="_blank" rel="noopener" className={cn('inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground', className)}>
    <Icon name="info" size={15} />Help
  </a>;
}

export function Frame({ step, total = SETUP_STEPS, title, description, children, wide, footer, notice }: { step: number; total?: number; title: ReactNode; description?: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode; notice?: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<string | null>(null);
  const key = `${step}:${typeof title === 'string' ? title : ''}`;
  // A step that swaps its content in place (the school-creation parts) unmounts or disables the button that was
  // just pressed, so focus would fall to <body>. Move it to the new title instead, the way Shell does for views.
  // The first mount is left alone so autoFocus fields keep focus, and so is a text field that autoFocus just took.
  useEffect(() => {
    const previous = shown.current;
    shown.current = key;
    if (previous === null || previous === key) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isConnected && !(active as HTMLButtonElement).disabled && (active.matches('input, textarea') || active.closest('[role="dialog"], [role="alertdialog"]'))) return;
    heading.current?.focus({ preventScroll: true });
  }, [key]);
  return <main className="welcome-bg grid min-h-dvh place-items-center items-start p-3 sm:items-center sm:px-4 sm:py-8">
    <Card className={cn('w-full min-w-0 rounded-3xl shadow-float animate-in fade-in-0 slide-in-from-bottom-2 duration-300 sm:py-8', wide ? 'max-w-[980px]' : 'max-w-[580px]')}>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Brand />
          <ol className="flex items-center gap-1.5" aria-label={`Step ${step} of ${total}`}>
            {STEP_TITLES.slice(0, total).map((label, index) => {
              const number = index + 1;
              const state = number < step ? 'done' : number === step ? 'current' : 'todo';
              return <li key={label} className="flex items-center gap-1.5" aria-current={state === 'current' ? 'step' : undefined}>
                <span className={cn('grid size-6 place-items-center rounded-full text-[11px] font-extrabold transition-colors', state === 'current' ? 'bg-primary text-primary-foreground shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_22%,transparent)]' : state === 'done' ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground')}>{state === 'done' ? <Icon name="check" size={12} strokeWidth={3} /> : number}</span>
                <span className={cn('text-xs font-semibold max-sm:hidden', state === 'current' ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
                {number < total && <span aria-hidden="true" className="mx-1 h-px w-4 bg-border" />}
              </li>;
            })}
          </ol>
        </div>
        <div className="grid gap-1.5"><Eyebrow>Step {step} of {total}</Eyebrow><h1 ref={heading} tabIndex={-1} className="text-[28px] outline-none">{title}</h1>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>
        {notice}
        {children}
        {footer && <div className="flex min-w-0 flex-wrap items-center gap-2 border-t pt-5">{footer}<Spacer /><HelpLink /></div>}
      </CardContent>
    </Card>
  </main>;
}

/** Setup footer sign-out. The email sits in its own wrapping hint so a long school address never widens the card. */
export function SignOutButton({ email, onClick, disabled }: { email?: string; onClick: () => void; disabled?: boolean }) {
  return <>
    <Button variant="ghost" size="sm" icon="logout" onClick={onClick} disabled={disabled}>Sign out</Button>
    {email && <Hint className="min-w-0 break-all">{email}</Hint>}
  </>;
}

export function Onboarding({ context, online, sessionNotice, onRefresh, onSignOut, logoutPending }: { context: WorkspaceContext; online: boolean; sessionNotice?: ReactNode; onRefresh: () => Promise<unknown>; onSignOut: () => void; logoutPending: boolean }) {
  const needsNames = !context.user.displayName || !context.user.fullName;
  const [step, setStep] = useState<Step>(needsNames ? 'names' : 'school');
  const [selected, setSelected] = useState<School | null>(null);
  useEffect(() => { if (!needsNames && step === 'names') setStep('school'); }, [needsNames, step]);
  // The names step already says which account is signed in, so the footer only repeats the email elsewhere.
  const signOut = <SignOutButton email={step === 'names' ? undefined : context.user.email} onClick={onSignOut} disabled={logoutPending || !online} />;
  // Steps stay mounted while offline so a half-built schedule survives a dropped connection; only their submit buttons wait.
  // The session notice is live (a failed sign-out, refresh or sync), so it shows whenever it is set, on every step.
  const notice = <>{!online && <Callout tone="warning" icon="alert" role="status" title="You’re offline" actions={<Button size="sm" onClick={() => void onRefresh()}>Retry connection</Button>}>Your answers are kept here. Reconnect to continue setup.</Callout>}{sessionNotice}</>;
  const shared = { online, notice, footer: signOut };
  const open = (school: School) => { setSelected(school); setStep('choice'); };

  if (step === 'names') return <NamesStep {...shared} user={context.user} onSaved={async () => { await onRefresh(); setStep('school'); }} />;
  if (step === 'create') return <CreateStep {...shared} userId={context.user.id} onBack={() => setStep('school')} onCreated={open} onUseExisting={open} />;
  if (step === 'choice' && selected) return <ChoiceStep {...shared} school={selected} userId={context.user.id} onBack={() => setStep('school')} onJoined={onRefresh} onSchoolChanged={setSelected} />;
  return <SchoolStep {...shared} onSelect={open} onCreate={() => setStep('create')} />;
}

type StepProps = { online: boolean; notice: ReactNode; footer: ReactNode };

/* ---------- Step 1: names ---------- */

function NamesStep({ user, onSaved, online, notice, footer }: StepProps & { user: WorkspaceContext['user']; onSaved: () => Promise<void> }) {
  const suggested = user.suggestedNames;
  const [displayName, setDisplayName] = useState(user.displayName || suggested.displayName);
  const [fullName, setFullName] = useState(user.fullName || suggested.fullName);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const prefilled = !user.displayName && !!suggested.fullName;
  return <Frame step={1} title={prefilled ? 'Is this you?' : 'What should we call you?'} description={prefilled ? 'We took these from your Google account. Change anything you like.' : 'Pick a name schoolmates will see, and add your full name for verified schoolmates.'} notice={notice} footer={footer}>
    <form className="grid gap-4" onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setMessage('');
      try { await api.profile.save.mutate({ accountId: user.id, displayName: displayName.trim(), fullName: fullName.trim() }); await onSaved(); }
      catch (err) { setMessage(errorMessage(err)); } finally { setPending(false); }
    }}>
      <Field label="Display name" htmlFor="display-name" hint="The name schoolmates see in class lists and on your profile."><Input id="display-name" required autoFocus={!prefilled} autoComplete="nickname" maxLength={80} placeholder="Maya" value={displayName} className="h-11" onChange={(event) => setDisplayName(event.target.value)} /></Field>
      <Field label="Full name" htmlFor="full-name" hint="Only verified schoolmates see this, and only once you are verified too."><Input id="full-name" required autoComplete="name" maxLength={160} placeholder="Maya Chen" value={fullName} className="h-11" onChange={(event) => setFullName(event.target.value)} /></Field>
      <Hint className="break-all">Signed in as {user.email}.</Hint>
      {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
      <div><Button type="submit" variant="primary" size="lg" busy={pending} disabled={!online || !displayName.trim() || !fullName.trim()} iconRight="arrowRight" autoFocus={prefilled}>{prefilled ? 'Yes, continue' : 'Continue'}</Button></div>
    </form>
  </Frame>;
}

/* ---------- Step 2: find a school ---------- */

function SchoolRow({ school, onSelect, action = 'Choose', disabled = false }: { school: SchoolSummary; onSelect: () => void; action?: string; disabled?: boolean }) {
  // The aria-label replaces the row's text as its name, so the location, member count and status are read as its
  // description; two schools with the same name in different towns then sound different.
  const id = useId();
  return <button type="button" disabled={disabled} className="group/school flex w-full items-center gap-3 rounded-2xl bg-card px-4 py-3 text-left ring-1 ring-foreground/[0.08] transition-[box-shadow,background-color] outline-none hover:bg-muted hover:ring-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60" onClick={onSelect} aria-label={`${action} ${school.name}`} aria-describedby={`${id}-where ${id}-status`}>
    <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground"><Icon name="school" size={18} /></span>
    <div className="grid min-w-0 flex-1 gap-1">
      <strong className="text-[15px] font-bold">{school.name}</strong>
      <Hint id={`${id}-where`}>{school.location} · {pluralize(school.memberCount, 'member')}</Hint>
      <div id={`${id}-status`} className="flex flex-wrap gap-1.5">{school.approved ? <Chip tone="success" icon="check">Approved schedule</Chip> : <Chip tone="warning" icon="users">Community schedule</Chip>}{(school.supportLocked || school.memberLocked) && <Chip icon="lock">Locked</Chip>}</div>
    </div>
    <Icon name="chevronRight" size={18} className="text-muted-foreground transition-transform group-hover/school:translate-x-0.5" />
  </button>;
}

/**
 * Loads that answer only while they are still wanted: starting another load or cancelling makes an earlier one stale,
 * and a stale answer (or failure) is dropped.
 */
export function latestLoad() {
  let latest = 0;
  return {
    cancel: () => { latest += 1; },
    async run<T>(load: () => Promise<T>, onLoaded: (value: T) => void, onError: (error: unknown) => void) {
      const request = ++latest;
      let value: T;
      try { value = await load(); } catch (error) { if (request === latest) onError(error); return; }
      if (request === latest) onLoaded(value);
    },
  };
}

/**
 * Opens a picked school (searches return summaries only, so its schedule is loaded now), with the pending row disabled
 * and any failure shown. Leaving the screen, or cancel() when the student moves on within it, drops a pick that is still
 * loading, so a slow answer never pulls them off the screen they went to.
 */
function usePick(onOpen: (school: School) => void, setMessage: (message: string) => void) {
  const [opening, setOpening] = useState<string | null>(null);
  const [loads] = useState(latestLoad);
  useEffect(() => () => loads.cancel(), [loads]);
  const pick = (summary: SchoolSummary) => {
    setOpening(summary.id); setMessage('');
    return loads.run(() => api.school.get.query({ id: summary.id }), onOpen, (err) => { setMessage(errorMessage(err)); setOpening(null); });
  };
  const cancel = () => { loads.cancel(); setOpening(null); };
  return { opening, pick, cancel };
}

function SchoolStep({ onSelect, onCreate, online, notice, footer }: StepProps & { onSelect: (school: School) => void; onCreate: () => void }) {
  const [query, setQuery] = useState('');
  const [schools, setSchools] = useState<SchoolSummary[] | null>(null);
  const [message, setMessage] = useState('');
  const { opening, pick } = usePick(onSelect, setMessage);
  useEffect(() => {
    if (!online) return;
    let current = true;
    const timer = setTimeout(() => {
      api.school.list.query({ query: query.trim(), summaries: true }).then((result) => { if (current) { setSchools(result); setMessage(''); } }).catch((err) => { if (current) setMessage(errorMessage(err)); });
    }, query ? 250 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [query, online]);
  return <Frame step={2} title="Find your school" description="If a schoolmate already added it, you get their bell schedule instantly." notice={notice} footer={footer}>
    <div className="relative">
      <Icon name="search" size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="School name or location" placeholder="School name or town" autoFocus maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} className="h-12 rounded-2xl pl-11 text-[15px]" />
    </div>
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    {schools === null && !message && <Hint role="status">Loading schools…</Hint>}
    {schools && schools.length === 0 && <Panel className="text-sm text-muted-foreground">{query ? `No schools match “${query}”.` : 'No schools have been added yet. You would be the first.'}</Panel>}
    {schools && schools.length > 0 && <ul className="grid gap-2" aria-label="Schools">
      {schools.map((school) => <li key={school.id}><SchoolRow school={school} disabled={!online || opening !== null} onSelect={() => void pick(school)} /></li>)}
    </ul>}
    <Panel className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-[240px] text-sm"><strong>Can’t find it?</strong><p className="text-muted-foreground">Add your school once and everyone after you gets the bell schedule for free.</p></div>
        <Button icon="plus" onClick={onCreate}>Add a school</Button>
      </div>
      <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
        <li className="flex items-start gap-1.5"><Icon name="clock" size={13} className="mt-0.5 shrink-0" />About ten minutes</li>
        <li className="flex items-start gap-1.5"><Icon name="calendar" size={13} className="mt-0.5 shrink-0" />Have the bell schedule in front of you</li>
        <li className="flex items-start gap-1.5"><Icon name="users" size={13} className="mt-0.5 shrink-0" />Schoolmates can fix mistakes later</li>
      </ul>
    </Panel>
  </Frame>;
}

/* ---------- Step 2b: create a school, one question at a time ---------- */

type CreatePhase = 'details' | 'duplicates' | 'periods' | 'times' | 'days' | 'start' | 'review';
const PERIOD_STEPS: CreatePhase[] = ['details', 'periods', 'times', 'days', 'start', 'review'];

function slotIssues(slots: ScheduleSlot[]): string[] {
  const issues: string[] = [];
  slots.forEach((slot, index) => {
    if (!slot.start || !slot.end) issues.push(`Slot ${index + 1} needs a start and an end time.`);
    else if (slot.start >= slot.end) issues.push(`Slot ${index + 1} must end after it starts.`);
    else if (index > 0 && slots[index - 1].end && slots[index - 1].end > slot.start) issues.push(`Slot ${index + 1} overlaps the one before it.`);
  });
  if (slots.length === 0) issues.push('Add at least one period.');
  return issues;
}

function CreateStep({ userId, onBack, onCreated, onUseExisting, online, notice, footer }: StepProps & { userId: string; onBack: () => void; onCreated: (school: School) => void; onUseExisting: (school: School) => void }) {
  const timeZone = useMemo(browserTimeZone, []);
  const today = useMemo(() => todayIn(timeZone), [timeZone]);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [template, setTemplate] = useState<TemplateKind>('rotation');
  // The typed text is kept as is, so the field can be cleared and 10-19 typed digit by digit; it is checked, not clamped.
  const [cycleText, setCycleText] = useState('8');
  const [cycleLeft, setCycleLeft] = useState(false);
  const typedCycleLength = parseCycleLength(cycleText);
  const cycleLength = typedCycleLength ?? 8;
  const cycleInvalid = template === 'rotation' && typedCycleLength === null;
  const [phase, setPhase] = useState<CreatePhase>('details');
  const [duplicates, setDuplicates] = useState<SchoolSummary[]>([]);
  const [draft, setDraft] = useState<Schedule>(() => buildStarter('rotation', { timeZone, today, cycleLength: 8 }));
  const [typical, setTypical] = useState<ScheduleSlot[]>(() => typicalDaySlots(draft.periods));
  const [varies, setVaries] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const { opening, pick, cancel } = usePick(onUseExisting, setMessage);
  const multiDay = template !== 'same';
  const asksStart = template === 'ab' || template === 'rotation';
  const issues = describeIssues(draft);
  const typicalProblems = slotIssues(typical);
  const set = (patch: Partial<Schedule>) => setDraft((current) => ({ ...current, ...patch }));
  const zones = useMemo(timeZones, []);

  const visible = PERIOD_STEPS.filter((entry) => (entry !== 'days' || multiDay) && (entry !== 'start' || asksStart));
  const position = Math.max(0, visible.indexOf(phase === 'duplicates' ? 'details' : phase));
  const progress = <Hint>{phase === 'duplicates' ? 'Before you add it' : `Part ${position + 1} of ${visible.length}`}</Hint>;
  const goto = (direction: -1 | 1) => setPhase(visible[Math.min(visible.length - 1, Math.max(0, position + direction))]);

  const startDetails = async () => {
    if (cycleInvalid) { setCycleLeft(true); return; }
    setChecking(true); setMessage('');
    try {
      const trimmed = name.trim();
      const words = trimmed.split(/\s+/).filter((word) => word.length >= 4 && !/^(high|school|academy|middle|the|public|private|prep)$/i.test(word));
      const [exact, loose] = await Promise.all([api.school.list.query({ query: trimmed, summaries: true }), words[0] ? api.school.list.query({ query: words[0], summaries: true }) : Promise.resolve([] as SchoolSummary[])]);
      const found = [...exact, ...loose.filter((school) => !exact.some((entry) => entry.id === school.id))].slice(0, 5);
      const next = buildStarter(template, { timeZone, today, cycleLength, periods: draft.periods });
      setDraft(next); setTypical((current) => typicalDaySlots(next.periods, current)); setVaries(null);
      if (found.length) { setDuplicates(found); setPhase('duplicates'); } else setPhase('periods');
    } catch (err) { setMessage(errorMessage(err)); } finally { setChecking(false); }
  };

  if (phase === 'details') {
    return <Frame step={2} title="Add your school" description="Just the basics first. The bell schedule comes next, one question at a time." notice={notice} footer={footer}>
      {progress}
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void startDetails(); }}>
        <Field label="School name" htmlFor="school-name"><Input id="school-name" required autoFocus minLength={2} maxLength={160} placeholder="Lincoln High School" value={name} className="h-11" onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="City and state" htmlFor="school-location"><Input id="school-location" required minLength={2} maxLength={200} placeholder="Boston, MA" value={location} className="h-11" onChange={(event) => setLocation(event.target.value)} /></Field>
        <div className="grid gap-2">
          <Label className="text-[13px] font-semibold text-foreground/80">How does the schedule repeat?</Label>
          <ChoiceGroup<TemplateKind> className="grid gap-2 sm:grid-cols-2" label="Schedule type" value={template} onChange={setTemplate}>
            {TEMPLATES.map((entry) => <OptionCard key={entry.kind} value={entry.kind} title={entry.title} description={entry.description} />)}
          </ChoiceGroup>
          {template === 'rotation' && <Field label="Days in the cycle" htmlFor="cycle-length" className="max-w-[220px]" error={cycleInvalid && cycleLeft ? `Enter a whole number from ${CYCLE_LENGTH_MIN} to ${CYCLE_LENGTH_MAX}.` : undefined}><Input id="cycle-length" type="number" inputMode="numeric" required min={CYCLE_LENGTH_MIN} max={CYCLE_LENGTH_MAX} step={1} value={cycleText} onChange={(event) => { setCycleText(event.target.value); setCycleLeft(false); }} onBlur={() => setCycleLeft(true)} /></Field>}
        </div>
        {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
        <div className="flex flex-wrap gap-2"><Button variant="ghost" icon="arrowLeft" onClick={onBack}>Back</Button><Spacer /><Button type="submit" variant="primary" iconRight="arrowRight" busy={checking} disabled={!online || name.trim().length < 2 || location.trim().length < 2 || cycleInvalid}>Set up the schedule</Button></div>
      </form>
    </Frame>;
  }

  if (phase === 'duplicates') {
    return <Frame step={2} title="Is it one of these?" description="A school with a similar name already exists. Joining it means you share one schedule and can fix it together." notice={notice} footer={footer}>
      {progress}
      <ul className="grid gap-2" aria-label="Similar schools">{duplicates.map((school) => <li key={school.id}><SchoolRow school={school} action="Join" disabled={!online || opening !== null} onSelect={() => void pick(school)} /></li>)}</ul>
      {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
      <div className="flex flex-wrap gap-2"><Button variant="ghost" icon="arrowLeft" onClick={() => { cancel(); setPhase('details'); }}>Back</Button><Spacer /><Button variant="primary" iconRight="arrowRight" onClick={() => { cancel(); setPhase('periods'); }}>None of these, add {name.trim()}</Button></div>
    </Frame>;
  }

  if (phase === 'periods') {
    return <Frame step={2} wide title="What are the periods called?" description="List every block in a school day, including lunch. Use the names your school uses, like “Block A” or “Period 3”." notice={notice} footer={footer}>
      {progress}
      {/* Days are still empty here, so the editor is shown a stand-in with every period placed; only the period list is written back. */}
      <Periods value={{ ...draft, cycleDays: draft.cycleDays.map((day) => ({ ...day, slots: typicalDaySlots(draft.periods, typical) })) }} set={(patch) => { if (patch.periods) set({ periods: patch.periods }); }} confirmRemoval={false} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon="arrowLeft" onClick={() => setPhase('details')}>Back</Button>
        <Spacer />
        <Button variant="primary" iconRight="arrowRight" disabled={draft.periods.length === 0 || draft.periods.some((period) => !period.label.trim())} onClick={() => { setTypical((current) => typicalDaySlots(draft.periods, current)); goto(1); }}>Next: bell times</Button>
      </div>
    </Frame>;
  }

  if (phase === 'times') {
    return <Frame step={2} wide title={multiDay ? 'Bell times on a normal day' : 'Bell times'} description="Enter when each period starts and ends. Type times like 8:05 or 1:30 and tap AM/PM if needed. Nothing is filled in for you, so what you enter is what your school actually does." notice={notice} footer={footer}>
      {progress}
      <SlotsEditor slots={typical} periods={draft.periods} onChange={setTypical} emptyText="Add the periods in the order they happen." />
      {typicalProblems.length > 0 && typical.some((slot) => slot.start && slot.end) && <Callout tone="warning" icon="alert"><ul className="grid list-disc gap-0.5 pl-4 text-[13.5px]">{typicalProblems.slice(0, 4).map((issue) => <li key={issue}>{issue}</li>)}</ul></Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon="arrowLeft" onClick={() => goto(-1)}>Back</Button>
        <Spacer />
        <Button variant="primary" iconRight="arrowRight" disabled={typicalProblems.length > 0} onClick={() => { if (!varies) setDraft((current) => applyTypicalDay(current, typical)); goto(1); }}>{multiDay ? 'Next: rotation days' : 'Next: check it'}</Button>
      </div>
    </Frame>;
  }

  if (phase === 'days') {
    const dayLabels = starterDays(template, cycleLength).map((day) => day.label);
    return <Frame step={2} wide={varies === true} title="Do the days differ?" description={`Your ${dayLabels.length} rotation days (${dayLabels.slice(0, 3).join(', ')}${dayLabels.length > 3 ? '…' : ''}) all start as a copy of the normal day.`} notice={notice} footer={footer}>
      {progress}
      <ChoiceGroup<'same' | 'varies'> className="grid gap-2" label="Day differences" value={varies === null ? null : varies ? 'varies' : 'same'} onChange={(next) => {
        setVaries(next === 'varies');
        if (next === 'same') setDraft((current) => applyTypicalDay(current, typical));
      }}>
        <OptionCard icon="check" value="same" title="Same order and times every day" description="Each rotation day runs the same periods at the same times." />
        <OptionCard icon="layers" value="varies" title="The order or the times change by day" description="For example, Day 2 starts with Period 3, or Wednesdays end early. You will drag periods around next." />
      </ChoiceGroup>
      {varies && <Panel className="grid gap-3">
        <Hint>Drag a period to move it. Tap a day’s name to change its times. Every day started as a copy of the normal day, so you only need to fix what differs.</Hint>
        <Days value={draft} set={set} />
      </Panel>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon="arrowLeft" onClick={() => goto(-1)}>Back</Button>
        <Spacer />
        <Button variant="primary" iconRight="arrowRight" disabled={varies === null} onClick={() => goto(1)}>{asksStart ? 'Next: today’s day' : 'Next: check it'}</Button>
      </div>
    </Frame>;
  }

  if (phase === 'start') {
    const defaultDate = nextSchoolDay(today, draft.schoolWeekdays);
    const isSchoolDay = draft.schoolWeekdays.includes(weekdayOf(draft.anchorDate));
    return <Frame step={2} title="Which rotation day is it?" description="Quasar counts forward and backward from one date you are sure about. Today is fine, or the next school day." notice={notice} footer={footer}>
      {progress}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="On this date" htmlFor="anchor-date" hint={draft.anchorDate === defaultDate ? (defaultDate === today ? 'Today.' : `The next school day after today.`) : undefined}><Input id="anchor-date" type="date" value={draft.anchorDate} min="1900-01-01" max="2199-12-31" className="h-11" onChange={(event) => { if (event.target.value) set({ anchorDate: event.target.value }); }} /></Field>
        <Field label="…the school is on" htmlFor="anchor-day">
          <Select id="anchor-day" value={draft.anchorCycleDayId} className="h-11" onChange={(event) => set({ anchorCycleDayId: event.target.value })}>
            {draft.cycleDays.map((day) => <option key={day.id} value={day.id}>{day.label}</option>)}
          </Select>
        </Field>
      </div>
      {!isSchoolDay && <Callout tone="warning" icon="alert">{formatDate(draft.anchorDate, { weekday: 'long' })} is not a school day. Pick a weekday the rotation runs on.</Callout>}
      <Hint>Not sure? Ask a friend or check the school calendar. You can also correct this later from the School page.</Hint>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon="arrowLeft" onClick={() => goto(-1)}>Back</Button>
        <Spacer />
        <Button variant="primary" iconRight="arrowRight" disabled={!isSchoolDay} onClick={() => goto(1)}>Next: check it</Button>
      </div>
    </Frame>;
  }

  const weekAhead = upcomingSchoolDays(today, draft.schoolWeekdays, 5);
  return <Frame step={2} wide title="Does this look right?" description="Tap a date to see what Quasar thinks happens that day. If something is off, go back and fix it now, because schoolmates who join will inherit this schedule." notice={notice} footer={footer}>
    {progress}
    <Panel className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><strong className="font-bold">{name.trim()}</strong><Hint>{location.trim()}</Hint></div>
        <ScheduleSummary schedule={draft} />
      </div>
      <Field label="School time zone" htmlFor="new-school-tz" hint="Taken from this device. Change it only if your school is somewhere else.">
        <Select id="new-school-tz" small value={draft.timeZone} onChange={(event) => set({ timeZone: event.target.value })}>{!zones.includes(draft.timeZone) && <option value={draft.timeZone}>{draft.timeZone}</option>}{zones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</Select>
      </Field>
    </Panel>
    {issues.length > 0 && <Callout tone="warning" icon="alert" title={`${issues.length === 1 ? 'One thing' : `${issues.length} things`} to fix first`} role="alert"><ul className="grid list-disc gap-0.5 pl-4 text-[13.5px]">{issues.slice(0, 8).map((issue) => <li key={issue}>{issue}</li>)}</ul></Callout>}
    {issues.length === 0 && <div className="rounded-2xl bg-card p-4 ring-1 ring-foreground/[0.06]"><Preview value={draft} /></div>}
    <details className="group rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold marker:hidden [&::-webkit-details-marker]:hidden"><span className="min-w-0 flex-1">Advanced settings <Hint className="inline">(school weekdays, exceptions, every tab)</Hint></span><Icon name="chevronDown" size={16} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
      <div className="pt-3"><ScheduleEditor value={draft} onChange={setDraft} initialSection="basics" /></div>
    </details>
    {weekAhead.length > 0 && <Hint>Sanity check: {weekAhead.map((date) => formatDate(date, { weekday: 'short' })).join(', ')} come next. The preview above should show the right rotation day for each.</Hint>}
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" icon="arrowLeft" onClick={() => goto(-1)} disabled={pending}>Back</Button>
      <Spacer />
      <Button variant="primary" size="lg" busy={pending} disabled={!online || issues.length > 0} onClick={async () => {
        setPending(true); setMessage('');
        try { onCreated(await api.school.create.mutate({ accountId: userId, name: name.trim(), location: location.trim(), schedule: scheduleSchema.parse(draft) })); }
        catch (err) { setMessage(errorMessage(err)); } finally { setPending(false); }
      }}>Create school</Button>
    </div>
  </Frame>;
}

/* ---------- Step 3: explicit schedule choice ---------- */

type Choice = 'approved' | 'community' | 'personal';

function ChoiceStep({ school, userId, onBack, onJoined, onSchoolChanged, online, notice, footer }: StepProps & { school: School; userId: string; onBack: () => void; onJoined: () => Promise<unknown>; onSchoolChanged: (school: School) => void }) {
  const [grade, setGrade] = useState<Grade | ''>('');
  const sharedSchedule = scheduleForGrade(school.schedule, grade || undefined);
  const shared: Choice = school.approved ? 'approved' : 'community';
  // An unreviewed community schedule is never preselected: the student has to pick it (or a private one) explicitly.
  const [choice, setChoice] = useState<Choice | null>(school.approved ? 'approved' : null);
  const [advanced, setAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // Private-schedule edits are kept per grade, so changing the grade never throws them away.
  const [drafts, setDrafts] = useState<Partial<Record<Grade | '', Schedule>>>({});
  const base = useMemo(() => structuredClone(scheduleForGrade(school.schedule, grade || undefined)), [school.schedule, grade]);
  const custom = drafts[grade] ?? base;
  const setCustom = (value: Schedule) => setDrafts((current) => ({ ...current, [grade]: value }));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const customIssues = useMemo(() => choice === 'personal' ? describeIssues(custom) : [], [choice, custom]);
  const blocker = !grade ? 'Choose your grade to continue.' : !choice ? 'Choose which schedule to follow.' : customIssues.length > 0 ? 'Fix the private schedule issues above to continue.' : !online ? 'Reconnect to join.' : '';
  const join = async () => {
    if (!grade || !choice || !online) return;
    setPending(true); setMessage('');
    try {
      await api.school.join.mutate({ accountId: userId, schoolId: school.id, choice, grade, ...(choice === 'personal' ? { personalSchedule: scheduleSchema.parse(custom) } : {}) });
      classesStep.begin(userId);
      await onJoined();
    } catch (err) {
      // The school was loaded when it was picked. If support approval was withdrawn since (an admin change, a member
      // edit or a passed proposal), the server refuses 'approved'; reload it so the community option replaces it.
      if (choice === 'approved') {
        const fresh = await api.school.get.query({ id: school.id }).catch(() => null);
        if (fresh && !fresh.approved) {
          onSchoolChanged(fresh); setChoice(null);
          setMessage('This school’s schedule is no longer approved by support, so it is now a community schedule. Check it above, then choose it or build your own.');
          return;
        }
      }
      setMessage(errorMessage(err));
    } finally { setPending(false); }
  };
  return <Frame step={3} wide={choice === 'personal'} title="Which schedule should Quasar follow?" notice={notice} footer={footer}>
    <Field label="Your grade" htmlFor="onboarding-grade" hint="This chooses your bell schedule and lunch times. You can change it later in Account or School.">
      <Select id="onboarding-grade" required autoFocus value={grade} disabled={pending} className="h-11" onChange={(event) => {
        const next = event.target.value as Grade | '';
        // Edits made before a grade was picked belong to the grade picked first.
        if (grade === '' && next) setDrafts((current) => current[''] && !current[next] ? { ...current, [next]: current[''] } : current);
        setGrade(next);
      }}><option value="" disabled>Choose your grade…</option>{GRADES.map(entry => <option key={entry} value={entry}>{gradeLabel(entry)}</option>)}</Select>
    </Field>
    <Panel className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3"><span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground"><Icon name="school" size={18} /></span><div><strong className="font-bold">{school.name}</strong><Hint>{school.location} · {pluralize(school.memberCount, 'member')}</Hint></div></div>
        {school.approved ? <Chip tone="success" icon="check">Approved by support</Chip> : <Chip tone="warning" icon="users">Community schedule · not reviewed</Chip>}
      </div>
      <ScheduleSummary schedule={sharedSchedule} />
      <button type="button" className="inline-flex w-fit items-center gap-1 text-left text-sm font-semibold text-primary hover:underline" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Hide preview' : 'Preview this schedule on real dates'}<Icon name="chevronDown" size={14} className={cn('transition-transform', showPreview && 'rotate-180')} /></button>
      {showPreview && <div className="rounded-2xl bg-card p-4 ring-1 ring-foreground/[0.06]"><Preview value={sharedSchedule} /></div>}
    </Panel>
    <div className="grid gap-2">
      {/* The "Advanced" link sits outside the radiogroup, so the group holds only radios. */}
      <ChoiceGroup<Choice> className="grid gap-2" label="Schedule choice" value={choice} onChange={setChoice}>
        <OptionCard icon={school.approved ? 'check' : 'users'} value={shared} title={school.approved ? 'Use the approved school schedule' : 'Use the community schedule'}
          description={school.approved ? 'Support has checked this schedule. Corrections from support reach you automatically.' : 'Entered by students and not yet checked by support. Compare it with your school’s published schedule after you join. Corrections still reach you automatically.'} />
        {(advanced || choice === 'personal') && <OptionCard icon="edit" value="personal" title="Build my own private schedule" description="Starts as a copy of the school schedule. Only you see it, and school corrections will not change it." />}
      </ChoiceGroup>
      {!(advanced || choice === 'personal') && <button type="button" className="w-fit text-left text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline" onClick={() => setAdvanced(true)}>Advanced: build a private schedule instead</button>}
    </div>
    {choice === 'personal' && <div className="grid gap-3"><ScheduleEditor value={custom} onChange={setCustom} initialSection="days" /></div>}
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" icon="arrowLeft" onClick={onBack} disabled={pending}>Back</Button>
      <Spacer />
      <div className="grid justify-items-end gap-1">
        <Button variant="primary" size="lg" busy={pending} disabled={!!blocker} onClick={() => void join()}>Join {school.name}</Button>
        {blocker && <Hint role="status">{blocker}</Hint>}
      </div>
    </div>
  </Frame>;
}
