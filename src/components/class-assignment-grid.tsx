'use client';

import { useRef, useState } from 'react';
import { scheduleSchema, type PersonalSchedule, type Schedule, type ScheduleSlot } from '@/domain/schedule';
import { errorMessage } from '@/client/api';
import { slugId } from '@/lib/format';
import { saveTimetableEdit } from './personal-timetable';
import { ScheduleGrid } from './schedule-grid';
import { SlotsEditor } from './schedule-editor';
import { Button, Callout } from './ui';

export function ClassAssignmentGrid({ schedule, personal, save, disabled }: {
  schedule: Schedule; personal: PersonalSchedule; save: (value: PersonalSchedule) => Promise<void>; disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editedSlots, setEditedSlots] = useState<ScheduleSlot[]>([]);
  // Reuse existing period IDs for assigned classes; new classes get a stable private period.
  const periods = [...schedule.periods];
  const assignments = { ...personal.assignments };
  for (const cls of personal.classes) {
    if (periods.some(period => assignments[period.id] === cls.id)) continue;
    const id = slugId(`class-${cls.id}`, periods.map(period => period.id));
    periods.push({ id, label: cls.name, kind: 'class' }); assignments[id] = cls.id;
  }
  const draft: Schedule = { ...schedule, periods, cycleDays: schedule.cycleDays.map(day => ({ ...day,
    slots: personal.cycleDayOverrides.find(entry => entry.cycleDayId === day.id)?.slots ?? day.slots,
  })) };
  const displayPersonal = { ...personal, assignments };
  const persist = async (next: Schedule) => {
    if (disabled || saving.current) return;
    saving.current = true; setPending(true); setError('');
    try { await save(saveTimetableEdit(schedule, personal, next, assignments)); }
    catch (err) { setError(errorMessage(err)); }
    finally { saving.current = false; setPending(false); }
  };
  return <div className="grid gap-3 min-w-0">
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    <ScheduleGrid value={draft} personal={displayPersonal} personalClassesOnly onAssign={async (periodId, classId) => {
      if (disabled || saving.current) return;
      saving.current = true; setPending(true); setError('');
      try { await save({ ...personal, assignments: { ...personal.assignments, [periodId]: classId } }); }
      catch (err) { setError(errorMessage(err)); }
      finally { saving.current = false; setPending(false); }
    }} onChange={next => void persist(next)} disabled={disabled || pending}
      onEditDay={id => { setEditing(id); setEditedSlots(draft.cycleDays.find(day => day.id === id)?.slots ?? []); }} onRemoveDay={id => {
        const days = draft.cycleDays.filter(day => day.id !== id);
        if (days.length && confirm('Remove this day from your private rotation?')) void persist({ ...draft, cycleDays: days, anchorCycleDayId: draft.anchorCycleDayId === id ? days[0].id : draft.anchorCycleDayId, exceptions: draft.exceptions.filter(entry => entry.kind !== 'reset' || entry.cycleDayId !== id) });
      }} />
    {draft.cycleDays.filter(day => day.id === editing).map(day => <div key={day.id} className="panel p-3 grid gap-2"><strong>{day.label} times</strong>
      <SlotsEditor slots={editedSlots} periods={draft.periods} disabled={disabled || pending} onChange={setEditedSlots} />
      <Button size="sm" disabled={pending || !scheduleSchema.safeParse({ ...draft, cycleDays: draft.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: editedSlots } : entry) }).success} onClick={() => { void persist({ ...draft, cycleDays: draft.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: editedSlots } : entry) }); setEditing(null); }}>Save times</Button>
    </div>)}
    <div><Button size="sm" icon="plus" disabled={disabled || pending || draft.cycleDays.length >= 366} onClick={() => {
      const id = slugId(`day-${draft.cycleDays.length + 1}`, draft.cycleDays.map(day => day.id));
      void persist({ ...draft, cycleDays: [...draft.cycleDays, { id, label: `Day ${draft.cycleDays.length + 1}`, slots: [] }] });
    }}>Add rotation day</Button></div>
    {pending && <p className="hint" role="status">Saving timetable…</p>}
  </div>;
}
