'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { scheduledPeriodIds } from '@/domain/period-status';
import { classSchema, cycleDaysWithPeriod, type PersonalSchedule, type StudentClass } from '@/domain/schedule';
import { heroBase } from '@/lib/color';
import { classColor, formatDate, formatRoom, slugId, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { ChangedWhileEditing, type FieldSpec } from '../conflicts';
import { ClassAssignmentGrid } from '../class-assignment-grid';
import { ClassNameInput, useClassDirectory } from '../class-name-input';
import { removeClass, useSchoolTimetable } from '../personal-timetable';
import { Icon } from '../icon';
import { AdjustmentsList, CycleDayAdjustmentSheet, DateAdjustmentSheet, PrivateScheduleSheet, effectiveSchedule } from '../overrides';
import { Button, Callout, Chip, EmptyState, Field, Hint, Input, Modal, PageHeader, Panel, Section, Select, Spacer } from '../primitives';
import { Card } from '../ui/card';
import { ClassColorPicker } from '../class-color-picker';
import { ColorPicker } from '../ui/color-picker';
import { SchoolDirectory } from '../school-directory';
import { ScanScheduleSheet } from '../scan-schedule';

/** The white initial on a class avatar: light class colours are darkened just enough for 4.5:1, as on the Now card. */
const initialBackground = (dot: string) => { const base = heroBase(dot); return `linear-gradient(135deg, ${base}, color-mix(in srgb, ${base} 75%, #0b1020))`; };

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
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  // "Wrong time?" links (openBellTimes) arrive with ?private=open; open the sheet once and drop the param.
  const privateParam = state.params.get('private');
  useEffect(() => { if (privateParam === 'open') { setPrivateOpen(true); state.navigate('classes', undefined, { replace: true }); } }, [privateParam, state]);
  // ?directory=open (School → Browse school classes) is one-shot too: open the directory and drop the param, so Back or a reload does not reopen it.
  const directoryParam = state.params.get('directory');
  const [directoryOpen, setDirectoryOpen] = useState(directoryParam === 'open');
  useEffect(() => { if (directoryParam === 'open') { setDirectoryOpen(true); state.navigate('classes', undefined, { replace: true }); } }, [directoryParam, state]);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanEnabled, setScanEnabled] = useState(false);
  useEffect(() => {
    if (!state.online) return;
    let active = true;
    api.scan.status.query().then(result => { if (active) setScanEnabled(result.enabled); }).catch(() => {});
    return () => { active = false; };
  }, [state.online]);
  // Only an explicit pick is stored, so the default follows today when the app resumes on a later day.
  const [pickedDate, setPickDate] = useState<string | null>(null);
  const pickDate = pickedDate ?? todayIn(schedule.timeZone, state.now);

  /** Which rotation days each period appears on for this student, cycle-day adjustments included. */
  const meets = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const period of schedule.periods) map.set(period.id, cycleDaysWithPeriod(schedule, personal, period.id));
    return map;
  }, [schedule, personal]);
  const knownPeriods = [...schedule.periods, ...school.periods.filter(period => !schedule.periods.some(entry => entry.id === period.id))];
  const scheduled = scheduledPeriodIds(schedule, personal);
  const stale = Object.keys(personal.assignments).filter((periodId) => !knownPeriods.some((period) => period.id === periodId));
  const run = async (next: PersonalSchedule) => { setError(''); try { await state.savePersonal(next); } catch (err) { setError(errorMessage(err)); } };
  const current = editing && editing !== 'new' ? personal.classes.find((entry) => entry.id === editing) ?? null : null;

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <PageHeader title="Classes" eyebrow="Your timetable" description={personal.classes.length > 0 ? `${personal.classes.length} ${personal.classes.length === 1 ? 'class' : 'classes'} · unlock the timetable to place them on school periods.` : undefined}
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
          <ClassColorPicker cls={cls} disabled={!state.personalValid} onSave={(color) => state.savePersonal({ ...personal, classes: personal.classes.map((entry) => entry.id === cls.id ? { ...entry, color } : entry) })}>{(colorButton) => <>
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl text-[15px] font-extrabold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]" style={{ background: initialBackground(color.dot) }}>{cls.name.trim().slice(0, 1).toUpperCase()}</span>
            <div className="grid min-w-0 flex-1 gap-1">
              <strong className="line-clamp-3 text-[16px] leading-snug font-bold tracking-tight break-words" title={cls.name}>{cls.name}</strong>
              <span className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                {(cls.room || cls.teacher) && <Icon name="pin" size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />}
                {cls.room || cls.teacher ? <span className="min-w-0 break-words">{[cls.room && formatRoom(cls.room), cls.teacher].filter(Boolean).join(' · ')}</span> : <span className="italic">No room or teacher yet</span>}
              </span>
            </div>
            <div className="flex shrink-0 items-center">
              {colorButton}
              <Button size="sm" variant="ghost" icon="edit" className="shrink-0" aria-label={`Edit ${cls.name}`} onClick={() => setEditing(cls.id)}>Edit</Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {periods.length === 0 && <Chip tone="warning" icon="alert">Not on your timetable yet</Chip>}
            {periods.map((period) => <Chip key={period.id} tone="accent">{period.label}{!scheduled.has(period.id) ? ' · No times set' : ''}</Chip>)}
            {days.size > 0 && schedule.cycleDays.length > 1 && <Chip tone="outline">{days.size === schedule.cycleDays.length ? 'Every day' : `${days.size} of ${schedule.cycleDays.length} days`}</Chip>}
          </div>
          </>}</ClassColorPicker>
        </li>;
      })}
    </ul>}

    <Section id="assignments-title" title="Your class timetable" icon="layers" description="Unlock to move classes, change times, or remove blocks. Lock it again when you finish.">
      {stale.length > 0 && <Callout tone="warning" icon="alert" title="Some assignments refer to periods the school removed" actions={<Button size="sm" onClick={() => void run({ ...personal, assignments: Object.fromEntries(Object.entries(personal.assignments).filter(([periodId]) => !stale.includes(periodId))) })}>Clear them</Button>}>
        {stale.map((periodId) => `${personal.classes.find((cls) => cls.id === personal.assignments[periodId])?.name ?? 'Saved class'}, assigned to a period that is no longer listed`).join(', ')}
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
        <div className="flex flex-wrap gap-2">
          {(personal.customSchedule || personal.cycleDayOverrides.length > 0 || personal.dateOverrides.length > 0) && <Button size="sm" icon="refresh" onClick={() => setResetOpen(true)}>Revert to school timetable</Button>}
          <Button size="sm" icon={personal.customSchedule ? 'edit' : 'layers'} onClick={() => setPrivateOpen(true)}>Advanced schedule settings</Button>
        </div>
      </Panel>
    </Section>

    <ClassSheet key={editing ?? 'closed'} schoolId={state.context.school.id} online={state.online} personal={personal} open={editing !== null} onClose={() => setEditing(null)} initial={editing === 'new' ? { id: '', name: '', room: '', teacher: '' } : current} current={editing === 'new' ? undefined : current} usedIds={personal.classes.map((cls) => cls.id)}
      onSave={async (value) => {
        const exists = personal.classes.some((cls) => cls.id === value.id);
        await state.savePersonal({ ...personal, classes: exists ? personal.classes.map((cls) => cls.id === value.id ? value : cls) : [...personal.classes, value] });
        setEditing(null);
      }}
      onDelete={current ? async () => {
        await state.savePersonal(removeClass(personal, current.id));
        setEditing(null);
      } : undefined} />
    <DateAdjustmentSheet open={adjustDate !== null} onClose={() => setAdjustDate(null)} date={adjustDate ?? pickDate} school={school} personal={personal} save={state.savePersonal} />
    <CycleDayAdjustmentSheet open={adjustCycleDay !== null} onClose={() => setAdjustCycleDay(null)} cycleDayId={adjustCycleDay} school={school} personal={personal} save={state.savePersonal} />
    <ScanScheduleSheet open={scanOpen} onClose={() => setScanOpen(false)} accountId={state.context.user.id} schoolId={state.context.school.id} online={state.online} schedule={schedule} personal={personal} disabled={!state.personalValid} onSave={state.savePersonal} />
    <PrivateScheduleSheet open={privateOpen} onClose={() => setPrivateOpen(false)} school={school} personal={personal} save={state.savePersonal} />
    <Modal open={resetOpen} onClose={() => setResetOpen(false)} busy={resetPending} title="Revert to the school timetable?"
      footer={<><Button variant="ghost" disabled={resetPending} onClick={() => setResetOpen(false)}>Keep my timetable</Button><Spacer /><Button variant="danger" busy={resetPending} onClick={async () => { setResetPending(true); setError(''); try { await state.savePersonal(useSchoolTimetable(school, personal)); setResetOpen(false); } catch (err) { setError(errorMessage(err)); } finally { setResetPending(false); } }}>Revert timetable</Button></>}>
      <p className="text-sm text-muted-foreground">Your private timetable and date and rotation day adjustments will be cleared. Your classes and their assignments to school periods will stay saved.</p>
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
    </Modal>
  </div>;
}

function ClassSheet({ schoolId, online, personal, open, onClose, initial, current, usedIds, onSave, onDelete }: { schoolId: string; online: boolean; personal: PersonalSchedule; open: boolean; onClose: () => void; initial: StudentClass | null; current?: StudentClass | null; usedIds: string[]; onSave: (value: StudentClass) => Promise<void>; onDelete?: () => Promise<void> }) {
  const { directory } = useClassDirectory(schoolId, open && online);
  const [original, setOriginal] = useState<StudentClass>(initial ?? { id: '', name: '', room: '', teacher: '' });
  const [draft, setDraft] = useState<StudentClass>(original);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const serialized = JSON.stringify(current);
  const [acknowledged, setAcknowledged] = useState(serialized);
  const changed = current !== undefined && serialized !== acknowledged;
  const isNew = current === undefined;
  // Decided once per opening (the sheet is keyed by the class): a class removed while the form is open keeps the draft and shows ChangedWhileEditing.
  const [missingAtOpen] = useState(open && initial === null && !isNew);
  const removed = current === null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const run = async (action: () => Promise<void>) => { setPending(true); setError(''); try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } };
  const [removing, setRemoving] = useState(false);
  if (open && missingAtOpen) return <Modal open onClose={onClose} title="Class not found"><p className="text-sm text-muted-foreground">This class was removed on another device.</p></Modal>;
  const submit = () => run(async () => {
    const id = draft.id || slugId(draft.name, usedIds, 'class');
    const value = classSchema.parse({ id, ...(draft.directoryId ? { directoryId: draft.directoryId } : {}), name: draft.name.trim(), ...(draft.color ? { color: draft.color } : {}), ...(draft.room?.trim() ? { room: draft.room.trim() } : {}), ...(draft.teacher?.trim() ? { teacher: draft.teacher.trim() } : {}) });
    await onSave(value);
  });
  const previewColor = draft.color ?? classColor(draft.id || slugId(draft.name, usedIds, 'class')).dot;
  return <><Modal open={open} onClose={onClose} dirty={dirty} busy={pending} title={isNew ? 'Add a class' : 'Edit class'}
    footer={<>{onDelete && !removed && <Button variant="danger" disabled={pending || changed} onClick={() => setRemoving(true)}>Remove</Button>}<Spacer /><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Button variant="primary" form="class-form" type="submit" busy={pending} disabled={changed || !draft.name.trim()}>{isNew || removed ? 'Add class' : 'Save'}</Button></>}>
    <form id="class-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!changed) void submit(); }}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-2xl text-lg font-extrabold text-white transition-colors" style={{ background: initialBackground(previewColor) }}>{draft.name.trim().slice(0, 1).toUpperCase() || '?'}</span>
        <Field label="Class name" htmlFor="class-name" className="min-w-0 flex-1"><ClassNameInput id="class-name" autoFocus={isNew} required maxLength={120} placeholder="Algebra II" value={draft.name} className="font-semibold" disabled={pending || changed}
          entries={directory?.classes ?? []} grade={personal.grade} onValueChange={name => setDraft({ ...draft, name, ...(isNew ? { directoryId: undefined } : {}) })}
          onChoose={entry => setDraft({ ...draft, directoryId: entry.id, name: entry.name, room: entry.room ?? '', teacher: entry.teacher ?? '' })} /></Field>
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
      {changed && !pending && <ChangedWhileEditing draft={draft as unknown as Record<string, unknown>} current={current as unknown as Record<string, unknown> | null} fields={classFields} onKeep={() => setAcknowledged(serialized)} onLoad={() => { if (current) { setDraft(current); setOriginal(current); setAcknowledged(serialized); } else onClose(); }} />}
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
    </form>
  </Modal>
  <Modal open={removing && !!onDelete && !removed} onClose={() => setRemoving(false)} busy={pending} title={`Remove ${draft.name.trim() || 'this class'}?`}
    footer={<><Button variant="ghost" onClick={() => setRemoving(false)} disabled={pending}>Keep class</Button><Spacer /><Button variant="danger" busy={pending} disabled={changed} onClick={() => { if (onDelete) void run(onDelete); }}>Remove class</Button></>}>
    <p className="text-sm text-muted-foreground">The class and its period assignments will be removed. Its time blocks will stay on your timetable, and tasks will keep their notes.</p>
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </Modal></>;
}
