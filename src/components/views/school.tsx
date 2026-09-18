'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { GRADES, gradeLabel, scheduleForGrade, scheduleSchema, type Grade, type Schedule } from '@/domain/schedule';
import { pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { Icon, type IconName } from '../icon';
import { PrivateScheduleSheet } from '../overrides';
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

export function SchoolView({ state }: { state: AppState }) {
  const { context, personal, online } = state;
  const school = context.school;
  const sharedSchedule = scheduleForGrade(school.schedule, personal.grade);
  const [gradeError, setGradeError] = useState('');
  const locked = school.supportLocked || school.memberLocked || school.memberCount >= 10;
  const [editing, setEditing] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  return <div className="grid gap-5 animate-in fade-in-0 duration-300">
    <header className="flex flex-wrap items-center gap-4">
      <SchoolCrest name={school.name} />
      <div className="grid min-w-0 flex-1 gap-1">
        <h1>{school.name}</h1>
        <p className="text-sm text-muted-foreground">{school.location} · {pluralize(school.memberCount, 'member')}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {school.approved ? <Chip tone="success" icon="check">Approved by support</Chip> : <Chip tone="warning" icon="users">Community schedule · not reviewed</Chip>}
        {school.supportLocked && <Chip icon="lock">Locked by support</Chip>}
        {!school.supportLocked && (school.memberLocked || school.memberCount >= 10) && <Chip icon="lock">Locked at 10 members</Chip>}
        {!locked && <Chip icon="unlock">Members can edit</Chip>}
      </div>
    </header>

    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Section id="status-title" title="How this schedule is managed" icon="info">
        <ul className="grid gap-3">
          <FactRow icon={school.approved ? 'checkCircle' : 'info'} tone={school.approved ? 'success' : 'warning'}>{school.approved ? 'Support has checked this schedule against the school’s published one.' : 'This schedule was entered by students and has not been checked by support yet. Compare it with the school’s published schedule.'}</FactRow>
          <FactRow icon={locked ? 'lock' : 'unlock'}>{school.supportLocked ? 'Support locked the shared schedule. Changes go through a correction request.' : school.memberLocked || school.memberCount >= 10 ? 'Shared editing locked when the school reached 10 members, so one person cannot change everyone’s schedule. Changes go through a correction request.' : `Any member can edit the shared schedule until the school reaches 10 members (${school.memberCount} now). Every edit is saved as a new revision that other members review.`}</FactRow>
          <FactRow icon="users">Corrections never touch your classes or adjustments. When the shared schedule changes, you see what changed and anything of yours it affects.</FactRow>
        </ul>
      </Section>

      <Section id="source-title" title="Your schedule source" icon="school">
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
          <Button size="sm" onClick={() => setPrivateOpen(true)}>{personal.customSchedule ? 'Manage' : 'Build a private schedule'}</Button>
        </Panel>
      </Section>
    </div>

    <Section id="shared-title" title="Shared schedule" icon="layers" description={`Revision ${school.version}`}
      action={!locked ? <Button size="sm" icon="edit" disabled={!online} title={!online ? 'Connect to edit the shared schedule.' : undefined} onClick={() => setEditing(true)}>Edit shared schedule</Button> : undefined}>
      <ScheduleSummary schedule={sharedSchedule} />
      <button type="button" className="inline-flex w-fit items-center gap-1 text-left text-sm font-semibold text-primary hover:underline" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Hide preview' : 'Preview on real dates'}<Icon name="chevronDown" size={14} className={cn('transition-transform', showPreview && 'rotate-180')} /></button>
      {showPreview && <Preview value={sharedSchedule} />}
      {!online && !locked && <Hint>Connect to the internet to edit the shared schedule.</Hint>}
    </Section>

    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Section id="school-directory-title" title="School class directory" icon="book" description="Find classes shared by schoolmates and add personal copies to your timetable.">
        <div><Button icon="search" onClick={() => state.navigate('classes', { directory: 'open' })}>Browse school classes</Button></div>
      </Section>
      <CorrectionRequest online={online} />
    </div>

    <SharedEditorSheet open={editing} onClose={() => setEditing(false)} schedule={school.schedule} initialGrade={personal.grade ?? '9'} schoolId={school.id} version={school.version} onSaved={state.refresh} />
    <PrivateScheduleSheet open={privateOpen} onClose={() => setPrivateOpen(false)} school={sharedSchedule} personal={personal} save={state.savePersonal} />
  </div>;
}

function CorrectionRequest({ online }: { online: boolean }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  return <Section id="correction-title" title="Request a correction" icon="inbox" description="Spotted a wrong bell time or a missing day off? Tell support.">
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setError(''); setSent(false);
      try { await api.school.requestCorrection.mutate({ message: message.trim() }); setMessage(''); setSent(true); }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>
      <Field label="What needs to change?" htmlFor="correction" hint="At least 10 characters."><Textarea id="correction" required minLength={10} maxLength={5000} value={message} placeholder="Example: Day 3 lunch is 11:20–11:50, not 11:40–12:10. See the district bell schedule PDF…" onChange={(event) => setMessage(event.target.value)} /></Field>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      {sent && <Callout tone="success" icon="check" role="status">Sent to support. You will see the correction here once it is published.</Callout>}
      <div className="flex items-center gap-3"><Button type="submit" variant="primary" busy={pending} disabled={!online || message.trim().length < 10}>Send to support</Button>{!online && <Hint>Connect to send a request.</Hint>}</div>
    </form>
  </Section>;
}

function SharedEditorSheet({ open, onClose, schedule, initialGrade, schoolId, version, onSaved }: { open: boolean; onClose: () => void; schedule: Schedule; initialGrade: Grade; schoolId: string; version: number; onSaved: () => Promise<void> }) {
  return open ? <SharedEditorBody onClose={onClose} schedule={schedule} initialGrade={initialGrade} schoolId={schoolId} version={version} onSaved={onSaved} /> : null;
}

function SharedEditorBody({ onClose, schedule, initialGrade, schoolId, version, onSaved }: { onClose: () => void; schedule: Schedule; initialGrade: Grade; schoolId: string; version: number; onSaved: () => Promise<void> }) {
  const [grade, setGrade] = useState<Grade>(initialGrade);
  const [copyGrades, setCopyGrades] = useState<Grade[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<Grade, Schedule>>>({});
  const draft = drafts[grade] ?? scheduleForGrade(schedule, grade);
  const setDraft = (value: Schedule) => setDrafts((current) => ({ ...current, [grade]: value }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const issues = describeIssues(draft);
  const submit = async () => {
    setPending(true); setError(''); setStale(false);
    try {
      await api.school.update.mutate({ schoolId, expectedVersion: version, schedule: scheduleSchema.parse(draft), grades: [grade, ...copyGrades] });
      await onSaved();
      const remaining = { ...drafts };
      for (const savedGrade of [grade, ...copyGrades]) delete remaining[savedGrade];
      setDrafts(remaining);
      setCopyGrades([]);
      if (Object.keys(remaining).length === 0) onClose();
      else setError(`${gradeLabel(grade)} published. Other grades still have unpublished edits.`);
    }
    catch (err) {
      const text = errorMessage(err);
      setError(text);
      if (/changed\. Reload/i.test(text)) setStale(true);
    } finally { setPending(false); }
  };
  return <Modal open onClose={onClose} wide fullWidth title="Edit the shared schedule" description="Every member of the school sees your revision. Personal classes and adjustments are never changed by it."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer />{stale && <Button variant="secondary" disabled={pending} onClick={async () => { await onSaved(); setStale(false); setError('Reloaded. Your draft is still here; saving now replaces the newer revision.'); }}>Reload latest</Button>}<Button variant="primary" busy={pending} disabled={issues.length > 0} onClick={() => void submit()}>Publish revision</Button></>}>
    <div className="grid gap-4 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04] lg:grid-cols-2">
      <div className="grid gap-2">
        <Label className="text-[13px] font-semibold text-foreground/80">Grade to edit</Label>
        <Segmented<Grade> label="Grade to edit" value={grade} disabled={pending} options={GRADES.map((entry) => ({ value: entry, label: `${gradeLabel(entry)}${drafts[entry] ? ' *' : ''}` }))} onChange={(entry) => {
          setGrade(entry);
          setCopyGrades([]);
          setError('');
        }} />
        <Hint>* marks unpublished edits.</Hint>
      </div>
      <div className="grid gap-2">
        <Label className="text-[13px] font-semibold text-foreground/80">Copy from</Label>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Copy from">
          {GRADES.filter((entry) => entry !== grade).map((entry) => <Button key={entry} size="sm" disabled={pending} onClick={() => {
            setDraft(structuredClone(drafts[entry] ?? scheduleForGrade(schedule, entry)));
            setError('');
          }}>{gradeLabel(entry)}</Button>)}
        </div>
        <Hint>Replace the current {gradeLabel(grade)} draft with another grade’s schedule.</Hint>
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
    {error && <Callout tone={stale ? 'warning' : 'danger'} icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
