'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { GRADES, gradeLabel, scheduleForGrade, scheduleSchema, type Grade, type Schedule } from '@/domain/schedule';
import { pluralize } from '@/lib/format';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { PrivateScheduleSheet } from '../overrides';
import { describeIssues, Preview, ScheduleEditor, ScheduleSummary } from '../schedule-editor';
import { Button, Callout, Chip, Field, SectionHeader, Sheet, Textarea } from '../ui';

export function SchoolView({ state }: { state: AppState }) {
  const { context, personal, online } = state;
  const school = context.school;
  const sharedSchedule = scheduleForGrade(school.schedule, personal.grade);
  const [gradeError, setGradeError] = useState('');
  const locked = school.supportLocked || school.memberLocked || school.memberCount >= 10;
  const [editing, setEditing] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  return <div className="grid gap-4 fade-in">
    <header className="grid gap-2">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div><h1>{school.name}</h1><p className="text-sm text-text-2">{school.location} · {pluralize(school.memberCount, 'member')}</p></div>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {school.approved ? <Chip tone="success" icon="check">Approved by support</Chip> : <Chip tone="warning" icon="users">Community schedule · not reviewed</Chip>}
        {school.supportLocked && <Chip icon="lock">Locked by support</Chip>}
        {!school.supportLocked && (school.memberLocked || school.memberCount >= 10) && <Chip icon="lock">Locked at 10 members</Chip>}
        {!locked && <Chip icon="unlock">Members can edit</Chip>}
      </div>
    </header>

    <div className="grid gap-4 lg:grid-cols-2 items-start">
      <section className="card card-pad grid gap-3" aria-labelledby="status-title">
        <SectionHeader title={<span id="status-title">How this schedule is managed</span>} />
        <ul className="grid gap-2 text-sm">
          <li className="flex gap-2"><Icon name={school.approved ? 'checkCircle' : 'info'} size={17} className="mt-0.5 text-text-3" /><span>{school.approved ? 'Support has checked this schedule against the school’s published one.' : 'This schedule was entered by students and has not been checked by support yet. Compare it with the school’s published schedule.'}</span></li>
          <li className="flex gap-2"><Icon name={locked ? 'lock' : 'unlock'} size={17} className="mt-0.5 text-text-3" /><span>{school.supportLocked ? 'Support locked the shared schedule. Changes go through a correction request.' : school.memberLocked || school.memberCount >= 10 ? 'Shared editing locked when the school reached 10 members, so one person cannot change everyone’s schedule. Changes go through a correction request.' : `Any member can edit the shared schedule until the school reaches 10 members (${school.memberCount} now). Every edit is saved as a new revision that other members review.`}</span></li>
          <li className="flex gap-2"><Icon name="users" size={17} className="mt-0.5 text-text-3" /><span>Corrections never touch your classes or adjustments. When the shared schedule changes, you see what changed and anything of yours it affects.</span></li>
        </ul>
      </section>

      <section className="card card-pad grid gap-3" aria-labelledby="source-title">
        <SectionHeader title={<span id="source-title">Your schedule source</span>} />
        <div className="grid gap-2">
          <span className="label">Your grade</span>
          <div className="segmented flex-wrap" role="group" aria-label="Your grade">
            {GRADES.map((grade) => <button key={grade} type="button" aria-pressed={personal.grade === grade} onClick={() => {
              setGradeError('');
              void state.savePersonal({ ...personal, grade }).catch((err) => setGradeError(errorMessage(err)));
            }}>{gradeLabel(grade)}</button>)}
          </div>
        </div>
        {gradeError && <Callout tone="danger" role="alert">{gradeError}</Callout>}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0 flex-1 basis-[240px] text-sm">
            <strong>{personal.customSchedule ? 'Private schedule' : 'School schedule'}</strong>
            <p className="text-text-2">{personal.customSchedule ? 'You follow your own copy. School corrections do not change it.' : 'You follow the shared schedule above, plus your own adjustments.'}</p>
          </div>
          <Button size="sm" onClick={() => setPrivateOpen(true)}>{personal.customSchedule ? 'Manage' : 'Build a private schedule'}</Button>
        </div>
      </section>
    </div>

    <section className="card card-pad grid gap-3" aria-labelledby="shared-title">
      <SectionHeader title={<span id="shared-title">Shared schedule</span>} description={`Revision ${school.version}`}
        action={!locked ? <Button size="sm" icon="edit" disabled={!online} title={!online ? 'Connect to edit the shared schedule.' : undefined} onClick={() => setEditing(true)}>Edit shared schedule</Button> : undefined} />
      <ScheduleSummary schedule={sharedSchedule} />
      <button type="button" className="text-sm text-accent text-left font-medium" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Hide preview' : 'Preview on real dates'}</button>
      {showPreview && <Preview value={sharedSchedule} />}
      {!online && !locked && <p className="hint">Connect to the internet to edit the shared schedule.</p>}
    </section>

    <CorrectionRequest online={online} />

    <SharedEditorSheet open={editing} onClose={() => setEditing(false)} schedule={school.schedule} initialGrade={personal.grade ?? '9'} schoolId={school.id} version={school.version} onSaved={state.refresh} />
    <PrivateScheduleSheet open={privateOpen} onClose={() => setPrivateOpen(false)} school={sharedSchedule} personal={personal} save={state.savePersonal} />
  </div>;
}

function CorrectionRequest({ online }: { online: boolean }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  return <section className="card card-pad grid gap-3" aria-labelledby="correction-title">
    <SectionHeader title={<span id="correction-title">Request a correction</span>} />
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setError(''); setSent(false);
      try { await api.school.requestCorrection.mutate({ message: message.trim() }); setMessage(''); setSent(true); }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>
      <Field label="What needs to change?" htmlFor="correction" hint="At least 10 characters."><Textarea id="correction" required minLength={10} maxLength={5000} value={message} placeholder="Example: Day 3 lunch is 11:20–11:50, not 11:40–12:10. See the district bell schedule PDF…" onChange={(event) => setMessage(event.target.value)} /></Field>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      {sent && <Callout tone="success" icon="check" role="status">Sent to support. You will see the correction here once it is published.</Callout>}
      <div className="flex items-center gap-3"><Button type="submit" variant="primary" busy={pending} disabled={!online || message.trim().length < 10}>Send to support</Button>{!online && <span className="hint">Connect to send a request.</span>}</div>
    </form>
  </section>;
}

function SharedEditorSheet({ open, onClose, schedule, initialGrade, schoolId, version, onSaved }: { open: boolean; onClose: () => void; schedule: Schedule; initialGrade: Grade; schoolId: string; version: number; onSaved: () => Promise<void> }) {
  return open ? <SharedEditorBody onClose={onClose} schedule={schedule} initialGrade={initialGrade} schoolId={schoolId} version={version} onSaved={onSaved} /> : <Sheet open={false} onClose={onClose} title="Edit shared schedule"><span /></Sheet>;
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
  return <Sheet open onClose={onClose} wide fullWidth title="Edit the shared schedule"
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><span className="spacer" />{stale && <Button variant="secondary" disabled={pending} onClick={async () => { await onSaved(); setStale(false); setError('Reloaded. Your draft is still here; saving now replaces the newer revision.'); }}>Reload latest</Button>}<Button variant="primary" busy={pending} disabled={issues.length > 0} onClick={() => void submit()}>Publish revision</Button></>}>
    <div className="grid gap-2">
      <span className="label">Grade to edit</span>
      <div className="segmented flex-wrap" role="group" aria-label="Grade to edit">
        {GRADES.map((entry) => <button key={entry} type="button" disabled={pending} aria-pressed={grade === entry} onClick={() => {
          setGrade(entry);
          setCopyGrades([]);
          setError('');
        }}>{gradeLabel(entry)}{drafts[entry] ? ' *' : ''}</button>)}
      </div>
      <p className="hint">* marks unpublished edits.</p>
    </div>
    <div className="panel p-3 grid gap-2">
      <span className="label">Copy from</span>
      <p className="hint">Replace the current {gradeLabel(grade)} draft with another grade’s schedule.</p>
      <div className="flex gap-2 flex-wrap" role="group" aria-label="Copy from">
        {GRADES.filter((entry) => entry !== grade).map((entry) => <Button key={entry} size="sm" disabled={pending} onClick={() => {
          setDraft(structuredClone(drafts[entry] ?? scheduleForGrade(schedule, entry)));
          setError('');
        }}>{gradeLabel(entry)}</Button>)}
      </div>
    </div>
    <ScheduleEditor key={grade} value={draft} onChange={setDraft} disabled={pending} />
    <fieldset disabled={pending} className="panel p-3 grid gap-2">
      <legend className="label">Copy to other grades (optional)</legend>
      <p className="hint">Publishing saves {gradeLabel(grade)} and replaces the schedules of any grades selected below.</p>
      <div className="flex gap-2 flex-wrap" role="group" aria-label="Copy to">
        {GRADES.filter((entry) => entry !== grade).map((entry) => <Button key={entry} size="sm" variant={copyGrades.includes(entry) ? 'primary' : 'secondary'} aria-pressed={copyGrades.includes(entry)} onClick={() => setCopyGrades(copyGrades.includes(entry) ? copyGrades.filter((target) => target !== entry) : [...copyGrades, entry])}>
          {copyGrades.includes(entry) && <Icon name="check" size={14} />}{gradeLabel(entry)}
        </Button>)}
      </div>
    </fieldset>
    {error && <Callout tone={stale ? 'warning' : 'danger'} icon="alert" role="alert">{error}</Callout>}
  </Sheet>;
}
