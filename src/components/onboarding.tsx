'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage, type School } from '@/client/api';
import { GRADES, gradeLabel, scheduleForGrade, scheduleSchema, type Grade, type Schedule } from '@/domain/schedule';
import { browserTimeZone, pluralize, todayIn } from '@/lib/format';
import { buildTemplate, TEMPLATES, type TemplateKind } from '@/lib/templates';
import { cn } from '@/lib/utils';
import type { WorkspaceContext } from './app-state';
import { Icon } from './icon';
import { describeIssues, Preview, ScheduleEditor, ScheduleSummary } from './schedule-editor';
import { Brand } from './shell';
import { Button, Callout, Chip, Eyebrow, Field, Hint, Input, Panel, Select, Spacer } from './primitives';
import { Card, CardContent } from './ui/card';
import { Label } from './ui/label';

type Step = 'names' | 'school' | 'create' | 'choice';

function Frame({ step, total, title, description, children, wide, footer }: { step: number; total: number; title: ReactNode; description?: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  return <main className="welcome-bg grid min-h-dvh place-items-center items-start p-3 sm:items-center sm:px-4 sm:py-6">
    <Card className={cn('w-full animate-in fade-in-0 slide-in-from-bottom-1 duration-200 sm:py-7', wide ? 'max-w-[960px]' : 'max-w-[560px]')}>
      <CardContent className="grid gap-5 sm:px-6">
        <div className="flex items-center justify-between gap-3"><Brand /><Eyebrow>Step {step} of {total}</Eyebrow></div>
        <div className="grid gap-1"><h1 className="text-2xl">{title}</h1>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>
        {children}
        {footer && <div className="flex flex-wrap items-center gap-2 border-t pt-4">{footer}</div>}
      </CardContent>
    </Card>
  </main>;
}

/** Large selectable option, used as a radio inside a radiogroup. */
function OptionCard({ selected, onSelect, title, description, className }: { selected: boolean; onSelect: () => void; title: ReactNode; description: ReactNode; className?: string }) {
  return <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
    className={cn('grid gap-1 rounded-xl border bg-card px-4 py-3.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50', selected && 'border-primary bg-primary-soft ring-1 ring-primary hover:bg-primary-soft', className)}>
    <strong className="text-sm">{title}</strong><Hint className={cn(selected && 'text-primary-soft-foreground/80')}>{description}</Hint>
  </button>;
}

export function Onboarding({ context, online, error, onRefresh, onSignOut, logoutPending }: { context: WorkspaceContext; online: boolean; error: string; onRefresh: () => Promise<void>; onSignOut: () => void; logoutPending: boolean }) {
  const needsNames = !context.user.displayName || !context.user.fullName;
  const [step, setStep] = useState<Step>(needsNames ? 'names' : 'school');
  const [selected, setSelected] = useState<School | null>(null);
  useEffect(() => { if (!needsNames && step === 'names') setStep('school'); }, [needsNames, step]);
  const signOut = <Button variant="ghost" size="sm" icon="logout" onClick={onSignOut} disabled={logoutPending || !online}>Sign out ({context.user.email})</Button>;

  if (!online) {
    return <Frame step={needsNames ? 1 : 2} total={3} title="Connect to finish setup" description="Choosing a school and entering your names happen online. Your account is saved on this device for later." footer={signOut}>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      <div><Button variant="primary" onClick={() => void onRefresh()}>Retry connection</Button></div>
    </Frame>;
  }

  if (step === 'names') return <NamesStep user={context.user} error={error} onSaved={async () => { await onRefresh(); setStep('school'); }} footer={signOut} />;
  if (step === 'create') return <CreateStep onBack={() => setStep('school')} onCreated={(school) => { setSelected(school); setStep('choice'); }} footer={signOut} />;
  if (step === 'choice' && selected) return <ChoiceStep school={selected} onBack={() => setStep('school')} onJoined={onRefresh} footer={signOut} />;
  return <SchoolStep error={error} onSelect={(school) => { setSelected(school); setStep('choice'); }} onCreate={() => setStep('create')} footer={signOut} />;
}

/* ---------- Step 1: names ---------- */

function NamesStep({ user, error, onSaved, footer }: { user: WorkspaceContext['user']; error: string; onSaved: () => Promise<void>; footer: ReactNode }) {
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [fullName, setFullName] = useState(user.fullName ?? '');
  const [message, setMessage] = useState(error);
  const [pending, setPending] = useState(false);
  return <Frame step={1} total={3} title="What should we call you?" description="Your display name is what other students see later. Your full name is only shown to verified schoolmates." footer={footer}>
    <form className="grid gap-4" onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setMessage('');
      try { await api.profile.save.mutate({ displayName: displayName.trim(), fullName: fullName.trim() }); await onSaved(); }
      catch (err) { setMessage(errorMessage(err)); } finally { setPending(false); }
    }}>
      <Field label="Display name" htmlFor="display-name"><Input id="display-name" required autoFocus autoComplete="nickname" maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
      <Field label="Full name" htmlFor="full-name"><Input id="full-name" required autoComplete="name" maxLength={160} value={fullName} onChange={(event) => setFullName(event.target.value)} /></Field>
      <Hint>Signed in as {user.email}.</Hint>
      {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
      <div><Button type="submit" variant="primary" size="lg" busy={pending} disabled={!displayName.trim() || !fullName.trim()} iconRight="arrowRight">Continue</Button></div>
    </form>
  </Frame>;
}

/* ---------- Step 2: find a school ---------- */

function SchoolStep({ error, onSelect, onCreate, footer }: { error: string; onSelect: (school: School) => void; onCreate: () => void; footer: ReactNode }) {
  const [query, setQuery] = useState('');
  const [schools, setSchools] = useState<School[] | null>(null);
  const [message, setMessage] = useState(error);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      api.school.list.query({ query: query.trim() }).then((result) => { if (current) { setSchools(result); setMessage(''); } }).catch((err) => { if (current) setMessage(errorMessage(err)); });
    }, query ? 250 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [query]);
  return <Frame step={2} total={3} title="Find your school" footer={footer}>
    <div className="relative">
      <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="School name or location" placeholder="School name or town" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} className="h-11 pl-10" />
    </div>
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    {schools === null && !message && <Hint role="status">Loading schools…</Hint>}
    {schools && schools.length === 0 && <Panel className="text-sm text-muted-foreground">{query ? `No schools match “${query}”.` : 'No schools have been added yet.'}</Panel>}
    {schools && schools.length > 0 && <ul className="grid gap-2" aria-label="Schools">
      {schools.map((school) => <li key={school.id}>
        <button type="button" className="flex w-full items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors outline-none hover:border-primary hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => onSelect(school)}>
          <div className="grid min-w-0 flex-1 gap-1">
            <strong className="text-[15px]">{school.name}</strong>
            <Hint>{school.location} · {pluralize(school.memberCount, 'member')}</Hint>
            <div className="flex flex-wrap gap-1.5">{school.approved ? <Chip tone="success" icon="check">Approved schedule</Chip> : <Chip tone="warning" icon="users">Community schedule</Chip>}{(school.supportLocked || school.memberLocked) && <Chip icon="lock">Locked</Chip>}</div>
          </div>
          <Icon name="chevronRight" size={18} className="text-muted-foreground" />
        </button>
      </li>)}
    </ul>}
    <Panel className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1 basis-[240px] text-sm"><strong>Can’t find it?</strong><p className="text-muted-foreground">Add your school with its rotation and bell times. Others from your school can use it too.</p></div>
      <Button icon="plus" onClick={onCreate}>Add a school</Button>
    </Panel>
  </Frame>;
}

/* ---------- Step 2b: create a school ---------- */

function CreateStep({ onBack, onCreated, footer }: { onBack: () => void; onCreated: (school: School) => void; footer: ReactNode }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [template, setTemplate] = useState<TemplateKind>('rotation');
  const [cycleLength, setCycleLength] = useState(10);
  const [phase, setPhase] = useState<'details' | 'schedule'>('details');
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const issues = schedule ? describeIssues(schedule) : [];
  if (phase === 'details') {
    return <Frame step={2} total={3} title="Add your school" footer={footer}>
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        const timeZone = browserTimeZone();
        setSchedule(buildTemplate(template, { timeZone, today: todayIn(timeZone), cycleLength }));
        setPhase('schedule');
      }}>
        <Field label="School name" htmlFor="school-name"><Input id="school-name" required autoFocus minLength={2} maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="City and state" htmlFor="school-location"><Input id="school-location" required minLength={2} maxLength={200} placeholder="Boston, MA" value={location} onChange={(event) => setLocation(event.target.value)} /></Field>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">How does the schedule repeat?</Label>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Schedule type">
            {TEMPLATES.map((entry) => <OptionCard key={entry.kind} selected={template === entry.kind} onSelect={() => setTemplate(entry.kind)} title={entry.title} description={entry.description} />)}
          </div>
          {template === 'rotation' && <Field label="Days in the cycle" htmlFor="cycle-length" className="max-w-[160px]"><Input id="cycle-length" type="number" min={2} max={60} value={cycleLength} onChange={(event) => setCycleLength(Math.max(2, Math.min(60, Number(event.target.value) || 2)))} /></Field>}
        </div>
        <div className="flex flex-wrap gap-2"><Button variant="ghost" icon="arrowLeft" onClick={onBack}>Back</Button><Spacer /><Button type="submit" variant="primary" iconRight="arrowRight" disabled={name.trim().length < 2 || location.trim().length < 2}>Set up the schedule</Button></div>
      </form>
    </Frame>;
  }
  return <Frame step={2} total={3} wide title={`${name.trim()} schedule`} footer={footer}>
    {schedule && <ScheduleEditor value={schedule} onChange={setSchedule} initialSection="periods" />}
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" icon="arrowLeft" onClick={() => setPhase('details')} disabled={pending}>Back</Button>
      <Spacer />
      <Button variant="primary" busy={pending} disabled={!schedule || issues.length > 0} onClick={async () => {
        if (!schedule) return;
        setPending(true); setMessage('');
        try { onCreated(await api.school.create.mutate({ name: name.trim(), location: location.trim(), schedule: scheduleSchema.parse(schedule) })); }
        catch (err) { setMessage(errorMessage(err)); } finally { setPending(false); }
      }}>Create school</Button>
    </div>
  </Frame>;
}

/* ---------- Step 3: explicit schedule choice ---------- */

type Choice = 'approved' | 'community' | 'personal';

function ChoiceStep({ school, onBack, onJoined, footer }: { school: School; onBack: () => void; onJoined: () => Promise<void>; footer: ReactNode }) {
  const [grade, setGrade] = useState<Grade | ''>('');
  const sharedSchedule = scheduleForGrade(school.schedule, grade || undefined);
  const shared: Choice = school.approved ? 'approved' : 'community';
  const [choice, setChoice] = useState<Choice | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [custom, setCustom] = useState<Schedule>(() => structuredClone(school.schedule));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const customIssues = useMemo(() => choice === 'personal' ? describeIssues(custom) : [], [choice, custom]);
  const join = async () => {
    if (!choice || !grade) return;
    setPending(true); setMessage('');
    try {
      await api.school.join.mutate({ schoolId: school.id, choice, grade, ...(choice === 'personal' ? { personalSchedule: scheduleSchema.parse(custom) } : {}) });
      await onJoined();
    } catch (err) { setMessage(errorMessage(err)); } finally { setPending(false); }
  };
  return <Frame step={3} total={3} wide={choice === 'personal'} title="Which schedule should Quasar follow?" footer={footer}>
    <Field label="Your grade" htmlFor="onboarding-grade" hint="This chooses your bell schedule and lunch times. You can change it later in Account or School.">
      <Select id="onboarding-grade" required value={grade} disabled={pending} onChange={(event) => {
        const next = event.target.value as Grade | '';
        setGrade(next); setChoice(null);
        setCustom(structuredClone(scheduleForGrade(school.schedule, next || undefined)));
      }}><option value="" disabled>Choose your grade…</option>{GRADES.map(entry => <option key={entry} value={entry}>{gradeLabel(entry)}</option>)}</Select>
    </Field>
    <Panel className="grid gap-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><strong>{school.name}</strong><Hint>{school.location} · {pluralize(school.memberCount, 'member')}</Hint></div>
        {school.approved ? <Chip tone="success" icon="check">Approved by support</Chip> : <Chip tone="warning" icon="users">Community schedule · not reviewed</Chip>}
      </div>
      <ScheduleSummary schedule={sharedSchedule} />
      <button type="button" className="w-fit text-left text-sm font-medium text-primary hover:underline" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Hide preview' : 'Preview this schedule on real dates'}</button>
      {showPreview && <div className="rounded-xl border bg-card p-4"><Preview value={sharedSchedule} /></div>}
    </Panel>
    <div className="grid gap-2" role="radiogroup" aria-label="Schedule choice">
      <OptionCard selected={choice === shared} onSelect={() => setChoice(shared)} title={school.approved ? 'Use the approved school schedule' : 'Use the community schedule'}
        description={school.approved ? 'Support has checked this schedule. Corrections from support reach you automatically.' : 'Entered by students and not yet checked by support. Compare it with your school’s published schedule. Corrections still reach you automatically.'} />
      <OptionCard selected={choice === 'personal'} onSelect={() => setChoice('personal')} title="Build my own private schedule" description="Starts as a copy of the school schedule. Only you see it, and school corrections will not change it." />
    </div>
    {choice === 'personal' && <div className="grid gap-3"><ScheduleEditor value={custom} onChange={setCustom} initialSection="days" /></div>}
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" icon="arrowLeft" onClick={onBack} disabled={pending}>Back</Button>
      <Spacer />
      <Button variant="primary" size="lg" busy={pending} disabled={!grade || !choice || customIssues.length > 0} onClick={() => void join()}>Join {school.name}</Button>
    </div>
  </Frame>;
}
