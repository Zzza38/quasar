'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage, type School } from '@/client/api';
import { scheduleSchema, type Schedule } from '@/domain/schedule';
import { browserTimeZone, pluralize, todayIn } from '@/lib/format';
import { buildTemplate, TEMPLATES, type TemplateKind } from '@/lib/templates';
import type { WorkspaceContext } from './app-state';
import { Icon } from './icon';
import { describeIssues, Preview, ScheduleEditor, ScheduleSummary } from './schedule-editor';
import { Brand } from './shell';
import { Button, Callout, Chip, Field, Input } from './ui';

type Step = 'names' | 'school' | 'create' | 'choice';

function Frame({ step, total, title, description, children, wide, footer }: { step: number; total: number; title: ReactNode; description?: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  return <main className="welcome items-start sm:items-center">
    <div className={`card onboarding-card fade-in${wide ? ' wide' : ''}`}>
      <div className="flex items-center justify-between gap-3"><Brand /><span className="eyebrow">Step {step} of {total}</span></div>
      <div className="grid gap-1"><h1 className="text-[24px]">{title}</h1>{description && <p className="text-sm text-text-2">{description}</p>}</div>
      {children}
      {footer && <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">{footer}</div>}
    </div>
  </main>;
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
      <Button variant="primary" onClick={() => void onRefresh()}>Retry connection</Button>
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
      <p className="hint">Signed in as {user.email}.</p>
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
  return <Frame step={2} total={3} title="Find your school" description="Search by name or town. If nobody has added your school yet, you can add it and enter its bell schedule." footer={footer}>
    <div className="relative">
      <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-3" />
      <Input aria-label="School name or location" placeholder="School name or town" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} className="pl-10" />
    </div>
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    {schools === null && !message && <p className="hint" role="status">Loading schools…</p>}
    {schools && schools.length === 0 && <div className="panel p-4 text-sm text-text-2">{query ? `No schools match “${query}”.` : 'No schools have been added yet.'}</div>}
    {schools && schools.length > 0 && <ul className="grid gap-2" aria-label="Schools">
      {schools.map((school) => <li key={school.id}>
        <button type="button" className="school-option" onClick={() => onSelect(school)}>
          <div className="min-w-0 flex-1 grid gap-1">
            <strong className="text-[15px]">{school.name}</strong>
            <span className="hint">{school.location} · {pluralize(school.memberCount, 'member')}</span>
            <div className="flex gap-1.5 flex-wrap">{school.approved ? <Chip tone="success" icon="check">Approved schedule</Chip> : <Chip tone="warning" icon="users">Community schedule</Chip>}{(school.supportLocked || school.memberLocked) && <Chip icon="lock">Locked</Chip>}</div>
          </div>
          <Icon name="chevronRight" size={18} className="text-text-3" />
        </button>
      </li>)}
    </ul>}
    <div className="flex items-center gap-3 flex-wrap panel p-4">
      <div className="min-w-0 flex-1 basis-[240px] text-sm"><strong>Can’t find it?</strong><p className="text-text-2">Add your school with its rotation and bell times. Others from your school can use it too.</p></div>
      <Button icon="plus" onClick={onCreate}>Add a school</Button>
    </div>
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
    return <Frame step={2} total={3} title="Add your school" description="New schools start with a community schedule that support can review and lock later." footer={footer}>
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        const timeZone = browserTimeZone();
        setSchedule(buildTemplate(template, { timeZone, today: todayIn(timeZone), cycleLength }));
        setPhase('schedule');
      }}>
        <Field label="School name" htmlFor="school-name"><Input id="school-name" required autoFocus minLength={2} maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="City and state" htmlFor="school-location"><Input id="school-location" required minLength={2} maxLength={200} placeholder="Boston, MA" value={location} onChange={(event) => setLocation(event.target.value)} /></Field>
        <div className="grid gap-2">
          <span className="label">How does the schedule repeat?</span>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Schedule type">
            {TEMPLATES.map((entry) => <button key={entry.kind} type="button" role="radio" aria-checked={template === entry.kind} className={`option-card${template === entry.kind ? ' selected' : ''}`} onClick={() => setTemplate(entry.kind)}>
              <strong className="text-sm">{entry.title}</strong><span className="hint">{entry.description}</span>
            </button>)}
          </div>
          {template === 'rotation' && <Field label="Days in the cycle" htmlFor="cycle-length" className="max-w-[160px]"><Input id="cycle-length" type="number" min={2} max={60} value={cycleLength} onChange={(event) => setCycleLength(Math.max(2, Math.min(60, Number(event.target.value) || 2)))} /></Field>}
        </div>
        <p className="hint">You’ll adjust period names, times and the starting day next. Everything can be corrected later.</p>
        <div className="flex gap-2 flex-wrap"><Button variant="ghost" icon="arrowLeft" onClick={onBack}>Back</Button><span className="flex-1" /><Button type="submit" variant="primary" iconRight="arrowRight" disabled={name.trim().length < 2 || location.trim().length < 2}>Set up the schedule</Button></div>
      </form>
    </Frame>;
  }
  return <Frame step={2} total={3} wide title={`${name.trim()} schedule`} description="Enter the bell schedule as your school publishes it. Use Preview to check a few real dates before creating the school." footer={footer}>
    {schedule && <ScheduleEditor value={schedule} onChange={setSchedule} initialSection="periods" />}
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    <div className="flex gap-2 flex-wrap items-center">
      <Button variant="ghost" icon="arrowLeft" onClick={() => setPhase('details')} disabled={pending}>Back</Button>
      <span className="flex-1" />
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
  const shared: Choice = school.approved ? 'approved' : 'community';
  const [choice, setChoice] = useState<Choice | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [custom, setCustom] = useState<Schedule>(() => structuredClone(school.schedule));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const customIssues = useMemo(() => choice === 'personal' ? describeIssues(custom) : [], [choice, custom]);
  const join = async () => {
    if (!choice) return;
    setPending(true); setMessage('');
    try {
      await api.school.join.mutate({ schoolId: school.id, choice, ...(choice === 'personal' ? { personalSchedule: scheduleSchema.parse(custom) } : {}) });
      await onJoined();
    } catch (err) { setMessage(errorMessage(err)); } finally { setPending(false); }
  };
  return <Frame step={3} total={3} wide={choice === 'personal'} title="Which schedule should Quasar follow?" description="You can change this later. Personal adjustments never change the shared school schedule." footer={footer}>
    <div className="panel p-4 grid gap-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div><strong>{school.name}</strong><div className="hint">{school.location} · {pluralize(school.memberCount, 'member')}</div></div>
        {school.approved ? <Chip tone="success" icon="check">Approved by support</Chip> : <Chip tone="warning" icon="users">Community schedule · not reviewed</Chip>}
      </div>
      <ScheduleSummary schedule={school.schedule} />
      <button type="button" className="text-sm text-accent text-left font-medium" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Hide preview' : 'Preview this schedule on real dates'}</button>
      {showPreview && <div className="card p-4" style={{ boxShadow: 'none' }}><Preview value={school.schedule} /></div>}
    </div>
    <div className="grid gap-2" role="radiogroup" aria-label="Schedule choice">
      <button type="button" role="radio" aria-checked={choice === shared} className={`option-card${choice === shared ? ' selected' : ''}`} onClick={() => setChoice(shared)}>
        <strong className="text-sm">{school.approved ? 'Use the approved school schedule' : 'Use the community schedule'}</strong>
        <span className="hint">{school.approved ? 'Support has checked this schedule. Corrections from support reach you automatically.' : 'Entered by students and not yet checked by support. Compare it with your school’s published schedule. Corrections still reach you automatically.'}</span>
      </button>
      <button type="button" role="radio" aria-checked={choice === 'personal'} className={`option-card${choice === 'personal' ? ' selected' : ''}`} onClick={() => setChoice('personal')}>
        <strong className="text-sm">Build my own private schedule</strong>
        <span className="hint">Starts as a copy of the school schedule. Only you see it, and school corrections will not change it.</span>
      </button>
    </div>
    {choice === 'personal' && <div className="grid gap-3"><ScheduleEditor value={custom} onChange={setCustom} initialSection="days" /></div>}
    {message && <Callout tone="danger" icon="alert" role="alert">{message}</Callout>}
    <div className="flex gap-2 flex-wrap items-center">
      <Button variant="ghost" icon="arrowLeft" onClick={onBack} disabled={pending}>Back</Button>
      <span className="flex-1" />
      <Button variant="primary" size="lg" busy={pending} disabled={!choice || customIssues.length > 0} onClick={() => void join()}>Join {school.name}</Button>
    </div>
  </Frame>;
}
