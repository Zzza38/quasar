'use client';

import { useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { classSchema, type PersonalSchedule, type StudentClass } from '@/domain/schedule';
import { classColor, formatDate, slugId, todayIn } from '@/lib/format';
import type { AppState } from '../app-state';
import { ChangedWhileEditing, type FieldSpec } from '../conflicts';
import { ClassAssignmentGrid } from '../class-assignment-grid';
import { AdjustmentsList, CycleDayAdjustmentSheet, DateAdjustmentSheet, PrivateScheduleSheet, effectiveSchedule } from '../overrides';
import { Button, Callout, Chip, ColorDot, EmptyState, Field, Input, SectionHeader, Select, Sheet } from '../ui';

const classFields: FieldSpec<Record<string, unknown>>[] = [
  { key: 'name', label: 'Name', render: (value) => (value.name as string) || null },
  { key: 'color', label: 'Color', render: (value) => (value.color as string) || 'Automatic' },
  { key: 'room', label: 'Room', render: (value) => (value.room as string) || null },
  { key: 'teacher', label: 'Teacher', render: (value) => (value.teacher as string) || null },
];

export function ClassesView({ state }: { state: AppState }) {
  const { schedule: school, personal } = state;
  const schedule = effectiveSchedule(school, personal);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const [adjustDate, setAdjustDate] = useState<string | null>(null);
  const [adjustCycleDay, setAdjustCycleDay] = useState<string | null>(null);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [pickDate, setPickDate] = useState(() => todayIn(schedule.timeZone, state.now));

  /** Which rotation days each period appears on. */
  const meets = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const period of schedule.periods) map.set(period.id, schedule.cycleDays.filter((day) => day.slots.some((slot) => slot.periodId === period.id)).map((day) => day.label));
    return map;
  }, [schedule]);
  const assignable = schedule.periods.filter((period) => period.kind !== 'lunch');
  const stale = Object.keys(personal.assignments).filter((periodId) => !schedule.periods.some((period) => period.id === periodId));
  const run = async (next: PersonalSchedule) => { setError(''); try { await state.savePersonal(next); } catch (err) { setError(errorMessage(err)); } };
  const current = editing && editing !== 'new' ? personal.classes.find((entry) => entry.id === editing) ?? null : null;

  return <div className="grid gap-4 fade-in">
    <header className="flex items-end justify-between gap-3 flex-wrap">
      <div><h1>Classes</h1><p className="text-sm text-text-2">{personal.classes.length === 0 ? 'Add your classes, then match them to the school’s periods.' : `${personal.classes.length} classes · ${Object.keys(personal.assignments).length} of ${assignable.length} periods assigned`}</p></div>
      <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add class</Button>
    </header>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {!state.personalValid && <Callout tone="warning" icon="alert">Your saved personal schedule could not be read. Retry sync before editing.</Callout>}

    {personal.classes.length === 0 && <section className="card"><EmptyState icon="book" title="No classes yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add your first class</Button>}>Each class gets a colour and shows up in your day once it is matched to a period.</EmptyState></section>}
    {personal.classes.length > 0 && <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Your classes">
      {personal.classes.map((cls) => {
        const periods = schedule.periods.filter((period) => personal.assignments[period.id] === cls.id);
        const days = new Set(periods.flatMap((period) => meets.get(period.id) ?? []));
        const color = classColor(cls.id, 'class', cls.color);
        return <li key={cls.id} className="card class-card" style={{ borderTopColor: color.dot }}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 grid gap-0.5">
              <strong className="text-[15px] truncate">{cls.name}</strong>
              <span className="hint truncate">{[cls.room && `Room ${cls.room}`, cls.teacher].filter(Boolean).join(' · ') || ' '}</span>
            </div>
            <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${cls.name}`} onClick={() => setEditing(cls.id)}>Edit</Button>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {periods.length === 0 && <Chip tone="warning">Not matched to a period</Chip>}
            {periods.map((period) => <Chip key={period.id} tone="accent">{period.label}</Chip>)}
            {periods.length > 0 && schedule.cycleDays.length > 1 && <Chip>{days.size === schedule.cycleDays.length ? 'Every day' : `${days.size} of ${schedule.cycleDays.length} days`}</Chip>}
          </div>
        </li>;
      })}
    </ul>}

    <section className="card card-pad grid gap-3" aria-labelledby="assignments-title">
      <SectionHeader title={<span id="assignments-title">Your class timetable</span>} description="Drag your classes into the schedule. Days run across the top, with periods and times down the side." />
      {stale.length > 0 && <Callout tone="warning" icon="alert" title="Some assignments refer to periods the school removed" actions={<Button size="sm" onClick={() => void run({ ...personal, assignments: Object.fromEntries(Object.entries(personal.assignments).filter(([periodId]) => !stale.includes(periodId))) })}>Clear them</Button>}>
        {stale.map((periodId) => `${personal.classes.find((cls) => cls.id === personal.assignments[periodId])?.name ?? 'Saved class'} — assigned to a period that is no longer listed`).join(', ')}
      </Callout>}
      <ClassAssignmentGrid schedule={schedule} personal={personal} save={state.savePersonal} disabled={!state.personalValid} />
    </section>

    <section className="card card-pad grid gap-3" aria-labelledby="adjust-title">
      <SectionHeader title={<span id="adjust-title">Adjustments</span>} description="Change what a date or rotation day looks like for you only. The school schedule stays the same for everyone else." />
      <div className="flex gap-2 flex-wrap items-end">
        <Field label="Adjust a date" htmlFor="adjust-date"><div className="flex gap-2"><Input id="adjust-date" small type="date" value={pickDate} min="1900-01-01" max="2199-12-31" onChange={(event) => { if (event.target.value) setPickDate(event.target.value); }} className="max-w-[160px]" /><Button size="sm" onClick={() => setAdjustDate(pickDate)} disabled={!pickDate}>Open {formatDate(pickDate)}</Button></div></Field>
        {schedule.cycleDays.length > 1 && <Field label="Adjust a rotation day" htmlFor="adjust-day"><Select id="adjust-day" small value="" onChange={(event) => { if (event.target.value) setAdjustCycleDay(event.target.value); }}><option value="">Choose a day…</option>{schedule.cycleDays.map((day) => <option key={day.id} value={day.id}>{day.label}</option>)}</Select></Field>}
      </div>
      <AdjustmentsList school={school} personal={personal} save={state.savePersonal} onEditDate={setAdjustDate} onEditCycleDay={setAdjustCycleDay} />
      <div className="panel p-4 flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1 basis-[240px] text-sm">
          <strong>{personal.customSchedule ? 'You use a private schedule' : 'You follow the school schedule'}</strong>
          <p className="text-text-2">{personal.customSchedule ? 'School corrections do not change it. You can switch back at any time.' : 'If the school schedule never matches your day, build a private copy that only you see.'}</p>
        </div>
        <Button size="sm" icon={personal.customSchedule ? 'edit' : 'layers'} onClick={() => setPrivateOpen(true)}>{personal.customSchedule ? 'Edit private schedule' : 'Build a private schedule'}</Button>
      </div>
    </section>

    <ClassSheet key={editing ?? 'closed'} open={editing !== null} onClose={() => setEditing(null)} initial={editing === 'new' ? { id: '', name: '', room: '', teacher: '' } : current} current={editing === 'new' ? undefined : current} usedIds={personal.classes.map((cls) => cls.id)}
      onSave={async (value) => {
        const exists = personal.classes.some((cls) => cls.id === value.id);
        await state.savePersonal({ ...personal, classes: exists ? personal.classes.map((cls) => cls.id === value.id ? value : cls) : [...personal.classes, value] });
        setEditing(null);
      }}
      onDelete={current ? async () => {
        await state.savePersonal({ ...personal, classes: personal.classes.filter((cls) => cls.id !== current.id), assignments: Object.fromEntries(Object.entries(personal.assignments).filter(([, classId]) => classId !== current.id)) });
        setEditing(null);
      } : undefined} />
    <DateAdjustmentSheet open={adjustDate !== null} onClose={() => setAdjustDate(null)} date={adjustDate ?? pickDate} school={school} personal={personal} save={state.savePersonal} />
    <CycleDayAdjustmentSheet open={adjustCycleDay !== null} onClose={() => setAdjustCycleDay(null)} cycleDayId={adjustCycleDay} school={school} personal={personal} save={state.savePersonal} />
    <PrivateScheduleSheet open={privateOpen} onClose={() => setPrivateOpen(false)} school={school} personal={personal} save={state.savePersonal} />
  </div>;
}

function ClassSheet({ open, onClose, initial, current, usedIds, onSave, onDelete }: { open: boolean; onClose: () => void; initial: StudentClass | null; current?: StudentClass | null; usedIds: string[]; onSave: (value: StudentClass) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [draft, setDraft] = useState<StudentClass>(initial ?? { id: '', name: '', room: '', teacher: '' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const serialized = JSON.stringify(current);
  const [acknowledged, setAcknowledged] = useState(serialized);
  const changed = current !== undefined && serialized !== acknowledged;
  const isNew = current === undefined;
  const run = async (action: () => Promise<void>) => { setPending(true); setError(''); try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } };
  if (open && initial === null && !isNew) return <Sheet open onClose={onClose} title="Class not found"><p className="text-sm text-text-2">This class was removed on another device.</p></Sheet>;
  const submit = () => run(async () => {
    const id = draft.id || slugId(draft.name, usedIds, 'class');
    const value = classSchema.parse({ id, name: draft.name.trim(), ...(draft.color ? { color: draft.color } : {}), ...(draft.room?.trim() ? { room: draft.room.trim() } : {}), ...(draft.teacher?.trim() ? { teacher: draft.teacher.trim() } : {}) });
    await onSave(value);
  });
  return <Sheet open={open} onClose={onClose} title={isNew ? 'Add a class' : 'Edit class'}
    footer={<>{onDelete && <Button variant="danger" disabled={pending || changed} onClick={() => { if (confirm(`Remove ${draft.name || 'this class'}? Its period assignments are cleared. Tasks keep their notes.`)) void run(onDelete); }}>Remove</Button>}<span className="spacer" /><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Button variant="primary" form="class-form" type="submit" busy={pending} disabled={changed || !draft.name.trim()}>{isNew ? 'Add class' : 'Save'}</Button></>}>
    <form id="class-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!changed) void submit(); }}>
      <Field label="Class name" htmlFor="class-name"><Input id="class-name" autoFocus required maxLength={120} placeholder="Algebra II" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label="Class color" htmlFor="class-color">
        <div className="flex items-center gap-3">
          <input id="class-color" type="color" className="h-10 w-14 cursor-pointer rounded border border-border" value={draft.color ?? classColor(draft.id || slugId(draft.name, usedIds, 'class')).dot} disabled={pending} onChange={(event) => setDraft({ ...draft, color: event.target.value })} />
          <Button size="sm" disabled={pending || !draft.color} onClick={() => setDraft({ ...draft, color: undefined })}>Use automatic color</Button>
        </div>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Room" hint="Optional" htmlFor="class-room"><Input id="class-room" maxLength={120} value={draft.room ?? ''} onChange={(event) => setDraft({ ...draft, room: event.target.value })} /></Field>
        <Field label="Teacher" hint="Optional" htmlFor="class-teacher"><Input id="class-teacher" maxLength={120} value={draft.teacher ?? ''} onChange={(event) => setDraft({ ...draft, teacher: event.target.value })} /></Field>
      </div>
      {changed && <ChangedWhileEditing draft={draft as unknown as Record<string, unknown>} current={current as unknown as Record<string, unknown> | null} fields={classFields} onKeep={() => setAcknowledged(serialized)} onLoad={() => { if (current) { setDraft(current); setAcknowledged(serialized); } else onClose(); }} />}
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
    </form>
  </Sheet>;
}
