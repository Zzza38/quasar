'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { scheduledPeriodIds } from '@/domain/period-status';
import { classSchema, type PersonalSchedule, type StudentClass } from '@/domain/schedule';
import { classColor, formatDate, slugId, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { ChangedWhileEditing, type FieldSpec } from '../conflicts';
import { ClassAssignmentGrid } from '../class-assignment-grid';
import { Icon } from '../icon';
import { AdjustmentsList, CycleDayAdjustmentSheet, DateAdjustmentSheet, PrivateScheduleSheet, effectiveSchedule } from '../overrides';
import { Button, Callout, Chip, EmptyState, Field, Hint, Input, Modal, PageHeader, Panel, Section, Select, Spacer } from '../primitives';
import { Card } from '../ui/card';
import { ClassColorPicker } from '../class-color-picker';
import { ColorPicker } from '../ui/color-picker';
import { SchoolDirectory } from '../school-directory';
import { ScanScheduleSheet } from '../scan-schedule';

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
  const [directoryOpen, setDirectoryOpen] = useState(state.params.get('directory') === 'open');
  const [scanOpen, setScanOpen] = useState(false);
  const [scanEnabled, setScanEnabled] = useState(false);
  useEffect(() => {
    if (!state.online) return;
    let active = true;
    api.scan.status.query().then(result => { if (active) setScanEnabled(result.enabled); }).catch(() => {});
    return () => { active = false; };
  }, [state.online]);
  const [pickDate, setPickDate] = useState(() => todayIn(schedule.timeZone, state.now));

  /** Which rotation days each period appears on. */
  const meets = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const period of schedule.periods) map.set(period.id, schedule.cycleDays.filter((day) => day.slots.some((slot) => slot.periodId === period.id)).map((day) => day.label));
    return map;
  }, [schedule]);
  const knownPeriods = [...schedule.periods, ...school.periods.filter(period => !schedule.periods.some(entry => entry.id === period.id))];
  const scheduled = scheduledPeriodIds(schedule, personal);
  const stale = Object.keys(personal.assignments).filter((periodId) => !knownPeriods.some((period) => period.id === periodId));
  const run = async (next: PersonalSchedule) => { setError(''); try { await state.savePersonal(next); } catch (err) { setError(errorMessage(err)); } };
  const current = editing && editing !== 'new' ? personal.classes.find((entry) => entry.id === editing) ?? null : null;

  return <div className="grid gap-5 animate-in fade-in-0 duration-300">
    <PageHeader title="Classes" eyebrow="Your timetable" description={personal.classes.length > 0 ? `${personal.classes.length} ${personal.classes.length === 1 ? 'class' : 'classes'} · drag them onto school periods below.` : undefined}
      actions={<>{scanEnabled && <Button icon="camera" disabled={!state.online} onClick={() => setScanOpen(true)}>Scan timetable</Button>}<Button icon="search" onClick={() => setDirectoryOpen(true)}>Browse school classes</Button><Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add class</Button></>} />
    {directoryOpen && <SchoolDirectory schoolId={state.context.school.id} online={state.online} personal={personal} onClose={() => setDirectoryOpen(false)} onAdd={async (classes) => {
      if (!state.personalValid) throw new Error('Retry sync before changing your saved classes.');
      const added = classes.filter(cls => !personal.classes.some(existing => existing.id === cls.id || existing.directoryId === cls.directoryId));
      await state.savePersonal({ ...personal, classes: [...personal.classes, ...added] });
    }} />}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {!state.personalValid && <Callout tone="warning" icon="alert">Your saved personal schedule could not be read. Retry sync before editing.</Callout>}

    {personal.classes.length === 0 && <Card><EmptyState icon="book" title="No classes yet" action={<div className="flex flex-wrap justify-center gap-2"><Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add your first class</Button><Button icon="search" onClick={() => setDirectoryOpen(true)}>Browse the directory</Button>{scanEnabled && <Button icon="camera" disabled={!state.online} onClick={() => setScanOpen(true)}>Scan a photo</Button>}</div>}>Add the classes you take, then drop each one onto its period in the timetable.</EmptyState></Card>}
    {personal.classes.length > 0 && <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Your classes">
      {personal.classes.map((cls) => {
        const periods = knownPeriods.filter((period) => personal.assignments[period.id] === cls.id);
        const days = new Set(periods.flatMap((period) => meets.get(period.id) ?? []));
        const color = classColor(cls.id, 'class', cls.color);
        // Same surface as <Card>, rendered as a list item so the colour bar sits on the item itself.
        return <li key={cls.id} className="relative grid grid-cols-[minmax(0,1fr)] content-start gap-3 rounded-2xl border-t-4 bg-card px-4 pt-3.5 pb-4 text-sm text-card-foreground shadow-card ring-1 ring-foreground/[0.06] transition-shadow hover:shadow-float has-[[data-color-picker-open=true]]:border-t-transparent! dark:ring-foreground/[0.09]" style={{ borderTopColor: color.dot }}>
          <ClassColorPicker cls={cls} disabled={!state.personalValid} onSave={(color) => state.savePersonal({ ...personal, classes: personal.classes.map((entry) => entry.id === cls.id ? { ...entry, color } : entry) })} />
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl text-[15px] font-extrabold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]" style={{ background: `linear-gradient(135deg, ${color.dot}, color-mix(in srgb, ${color.dot} 75%, #0b1020))` }}>{cls.name.trim().slice(0, 1).toUpperCase()}</span>
            <div className="grid min-w-0 flex-1 gap-1">
              <strong className="line-clamp-3 text-[16px] leading-snug font-bold tracking-tight break-words" title={cls.name}>{cls.name}</strong>
              <span className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                {(cls.room || cls.teacher) && <Icon name="pin" size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />}
                {cls.room || cls.teacher ? <span className="min-w-0 break-words">{[cls.room && `Room ${cls.room}`, cls.teacher].filter(Boolean).join(' · ')}</span> : <span className="italic">No room or teacher yet</span>}
              </span>
            </div>
            <Button size="sm" variant="ghost" icon="edit" className="shrink-0" aria-label={`Edit ${cls.name}`} onClick={() => setEditing(cls.id)}>Edit</Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {periods.length === 0 && <Chip tone="warning" icon="alert">Not matched to a period</Chip>}
            {periods.map((period) => <Chip key={period.id} tone="accent">{period.label}{!scheduled.has(period.id) ? ' · Unscheduled' : ''}</Chip>)}
            {days.size > 0 && schedule.cycleDays.length > 1 && <Chip tone="outline">{days.size === schedule.cycleDays.length ? 'Every day' : `${days.size} of ${schedule.cycleDays.length} days`}</Chip>}
          </div>
        </li>;
      })}
    </ul>}

    <Section id="assignments-title" title="Your class timetable" icon="layers" description="Drag a class onto a school period, or select a class and tap the block. Resize to fine-tune times.">
      {stale.length > 0 && <Callout tone="warning" icon="alert" title="Some assignments refer to periods the school removed" actions={<Button size="sm" onClick={() => void run({ ...personal, assignments: Object.fromEntries(Object.entries(personal.assignments).filter(([periodId]) => !stale.includes(periodId))) })}>Clear them</Button>}>
        {stale.map((periodId) => `${personal.classes.find((cls) => cls.id === personal.assignments[periodId])?.name ?? 'Saved class'} — assigned to a period that is no longer listed`).join(', ')}
      </Callout>}
      <ClassAssignmentGrid schedule={schedule} personal={personal} save={state.savePersonal} disabled={!state.personalValid} />
    </Section>

    <Section id="adjust-title" title="Adjustments" icon="edit" description="Change a single date or a whole rotation day for yourself only.">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Adjust a date" htmlFor="adjust-date"><div className="flex gap-2"><Input id="adjust-date" small type="date" value={pickDate} min="1900-01-01" max="2199-12-31" onChange={(event) => { if (event.target.value) setPickDate(event.target.value); }} className="max-w-[160px]" /><Button size="sm" onClick={() => setAdjustDate(pickDate)} disabled={!pickDate}>Open {formatDate(pickDate)}</Button></div></Field>
        {schedule.cycleDays.length > 1 && <Field label="Adjust a rotation day" htmlFor="adjust-day"><Select id="adjust-day" small value="" onChange={(event) => { if (event.target.value) setAdjustCycleDay(event.target.value); }}><option value="">Choose a day…</option>{schedule.cycleDays.map((day) => <option key={day.id} value={day.id}>{day.label}</option>)}</Select></Field>}
      </div>
      <AdjustmentsList school={school} personal={personal} save={state.savePersonal} onEditDate={setAdjustDate} onEditCycleDay={setAdjustCycleDay} />
      <Panel className="flex flex-wrap items-center gap-3">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', personal.customSchedule ? 'bg-now-soft text-now-foreground' : 'bg-primary-soft text-primary-soft-foreground')}><Icon name={personal.customSchedule ? 'edit' : 'school'} size={17} /></span>
        <div className="min-w-0 flex-1 basis-[240px] text-sm">
          <strong>{personal.customSchedule ? 'Your timetable has personal changes' : 'Your timetable starts with the school schedule'}</strong>
          <Hint>{personal.customSchedule ? 'School corrections do not change your private copy.' : 'School corrections reach you automatically.'}</Hint>
        </div>
        <Button size="sm" icon={personal.customSchedule ? 'edit' : 'layers'} onClick={() => setPrivateOpen(true)}>Advanced schedule settings</Button>
      </Panel>
    </Section>

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
    <ScanScheduleSheet open={scanOpen} onClose={() => setScanOpen(false)} accountId={state.context.user.id} schedule={schedule} personal={personal} disabled={!state.personalValid} onSave={state.savePersonal} />
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
  if (open && initial === null && !isNew) return <Modal open onClose={onClose} title="Class not found"><p className="text-sm text-muted-foreground">This class was removed on another device.</p></Modal>;
  const submit = () => run(async () => {
    const id = draft.id || slugId(draft.name, usedIds, 'class');
    const value = classSchema.parse({ id, ...(draft.directoryId ? { directoryId: draft.directoryId } : {}), name: draft.name.trim(), ...(draft.color ? { color: draft.color } : {}), ...(draft.room?.trim() ? { room: draft.room.trim() } : {}), ...(draft.teacher?.trim() ? { teacher: draft.teacher.trim() } : {}) });
    await onSave(value);
  });
  const previewColor = draft.color ?? classColor(draft.id || slugId(draft.name, usedIds, 'class')).dot;
  return <Modal open={open} onClose={onClose} title={isNew ? 'Add a class' : 'Edit class'}
    footer={<>{onDelete && <Button variant="danger" disabled={pending || changed} onClick={() => { if (confirm(`Remove ${draft.name || 'this class'}? Its period assignments are cleared. Tasks keep their notes.`)) void run(onDelete); }}>Remove</Button>}<Spacer /><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Button variant="primary" form="class-form" type="submit" busy={pending} disabled={changed || !draft.name.trim()}>{isNew ? 'Add class' : 'Save'}</Button></>}>
    <form id="class-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!changed) void submit(); }}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-2xl text-lg font-extrabold text-white transition-colors" style={{ background: `linear-gradient(135deg, ${previewColor}, color-mix(in srgb, ${previewColor} 75%, #0b1020))` }}>{draft.name.trim().slice(0, 1).toUpperCase() || '?'}</span>
        <Field label="Class name" htmlFor="class-name" className="flex-1"><Input id="class-name" autoFocus required maxLength={120} placeholder="Algebra II" value={draft.name} className="h-11 text-[16px] font-semibold" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Room (optional)" htmlFor="class-room"><Input id="class-room" maxLength={120} placeholder="204" value={draft.room ?? ''} onChange={(event) => setDraft({ ...draft, room: event.target.value })} /></Field>
        <Field label="Teacher (optional)" htmlFor="class-teacher"><Input id="class-teacher" maxLength={120} placeholder="Ms. Ortiz" value={draft.teacher ?? ''} onChange={(event) => setDraft({ ...draft, teacher: event.target.value })} /></Field>
      </div>
      <Field label="Class color" htmlFor="class-color">
        <div className="grid gap-3 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <ColorPicker id="class-color" label="Class color" value={previewColor} disabled={pending || changed} onValueChange={(color) => setDraft({ ...draft, color })} />
          <div><Button size="sm" disabled={pending || !draft.color} onClick={() => setDraft({ ...draft, color: undefined })}>Use automatic color</Button></div>
        </div>
      </Field>
      {changed && <ChangedWhileEditing draft={draft as unknown as Record<string, unknown>} current={current as unknown as Record<string, unknown> | null} fields={classFields} onKeep={() => setAcknowledged(serialized)} onLoad={() => { if (current) { setDraft(current); setAcknowledged(serialized); } else onClose(); }} />}
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
    </form>
  </Modal>;
}
