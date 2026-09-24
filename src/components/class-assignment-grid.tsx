'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { scheduleSchema, type PersonalSchedule, type Schedule, type ScheduleSlot } from '@/domain/schedule';
import { errorMessage } from '@/client/api';
import { slugId } from '@/lib/format';
import { saveTimetableEdit } from './personal-timetable';
import { ScheduleGrid } from './schedule-grid';
import { SlotsEditor } from './schedule-editor';
import { Button, Callout, Hint, Panel } from './primitives';

/**
 * Edits made while a save is running, saved together next. A timetable change is kept as a function of the
 * latest timetable, because the grid built it from a render that may not include the save still running.
 */
type QueuedEdit = { change?: (latest: Schedule) => Schedule; assign?: PersonalSchedule['assignments'] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Replays an edit that turned `before` into `after` onto `latest`: only the days and fields it touched change. */
function rebase(before: Schedule, after: Schedule): (latest: Schedule) => Schedule {
  return (latest) => {
    const merged = { ...latest } as Record<string, unknown>;
    for (const key of Object.keys(after) as (keyof Schedule)[]) {
      if (key !== 'cycleDays' && !same(after[key], before[key])) merged[key] = after[key];
    }
    const beforeDays = new Map(before.cycleDays.map((day) => [day.id, day]));
    const afterDays = new Map(after.cycleDays.map((day) => [day.id, day]));
    const days = latest.cycleDays
      .filter((day) => !(beforeDays.has(day.id) && !afterDays.has(day.id)))
      .map((day) => { const edited = afterDays.get(day.id); return edited && !same(edited, beforeDays.get(day.id)) ? edited : day; });
    for (const day of after.cycleDays) if (!beforeDays.has(day.id) && !days.some((entry) => entry.id === day.id)) days.push(day);
    return { ...(merged as Schedule), cycleDays: days };
  };
}

export function ClassAssignmentGrid({ schedule, personal, save, disabled }: {
  schedule: Schedule; personal: PersonalSchedule; save: (value: PersonalSchedule) => Promise<void>; disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const queued = useRef<QueuedEdit | null>(null);
  const waiter = useRef<{ from: PersonalSchedule; resolve: () => void } | null>(null);
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
  // The grid stays usable while saving (disabling it would drop keyboard focus), so queued edits are built from the latest render.
  const latest = useRef({ schedule, personal, assignments, draft });
  useLayoutEffect(() => {
    latest.current = { schedule, personal, assignments, draft };
    if (waiter.current && waiter.current.from !== personal) { waiter.current.resolve(); waiter.current = null; }
  });
  /** Resolves once the saved personal schedule has rendered, or after a second if it never changes. */
  const rendered = (from: PersonalSchedule) => new Promise<void>((resolve) => {
    if (latest.current.personal !== from) { resolve(); return; }
    const timer = setTimeout(() => { waiter.current = null; resolve(); }, 1000);
    waiter.current = { from, resolve: () => { clearTimeout(timer); resolve(); } };
  });
  const build = (edit: QueuedEdit) => {
    const { schedule: basis, personal: base, assignments: shown, draft: current } = latest.current;
    const next = edit.change ? saveTimetableEdit(basis, base, edit.change(current), shown) : base;
    // Assignments go last so a timetable draft cannot overwrite a class the student just placed.
    return edit.assign ? { ...next, assignments: { ...next.assignments, ...edit.assign } } : next;
  };
  const enqueue = async (edit: QueuedEdit) => {
    if (disabled) return;
    if (saving.current) {
      const earlier = queued.current?.change;
      const change = edit.change && earlier ? (latest: Schedule) => edit.change!(earlier(latest)) : edit.change ?? earlier;
      queued.current = { change, assign: { ...queued.current?.assign, ...edit.assign } };
      return;
    }
    saving.current = true; setPending(true); setError('');
    try {
      let next: QueuedEdit | null = edit;
      while (next) {
        const from = latest.current.personal;
        await save(build(next));
        next = queued.current; queued.current = null;
        if (next) await rendered(from);
      }
    } catch (err) { queued.current = null; setError(errorMessage(err)); }
    finally { saving.current = false; setPending(false); }
  };
  // `draft` is the timetable this render showed, which is what the grid built `next` from.
  const persist = (next: Schedule) => enqueue({ change: rebase(draft, next) });
  return <div className="grid gap-3 min-w-0">
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    <ScheduleGrid value={draft} personal={displayPersonal} personalClassesOnly onAssign={(periodId, classId) => enqueue({ assign: { [periodId]: classId } })} onChange={next => void persist(next)} disabled={disabled}
      onEditDay={id => { setEditing(id); setEditedSlots(draft.cycleDays.find(day => day.id === id)?.slots ?? []); }} onRemoveDay={id => {
        const days = draft.cycleDays.filter(day => day.id !== id);
        if (days.length && confirm('Remove this day from your private rotation?')) void persist({ ...draft, cycleDays: days, anchorCycleDayId: draft.anchorCycleDayId === id ? days[0].id : draft.anchorCycleDayId, exceptions: draft.exceptions.filter(entry => entry.kind !== 'reset' || entry.cycleDayId !== id) });
      }} />
    {draft.cycleDays.filter(day => day.id === editing).map(day => <Panel key={day.id} className="grid gap-2 p-3"><strong className="text-sm">{day.label} times</strong>
      <SlotsEditor slots={editedSlots} periods={draft.periods} disabled={disabled} onChange={setEditedSlots} />
      <div><Button size="sm" disabled={disabled || !scheduleSchema.safeParse({ ...draft, cycleDays: draft.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: editedSlots } : entry) }).success} onClick={() => { void persist({ ...draft, cycleDays: draft.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: editedSlots } : entry) }); setEditing(null); }}>Save times</Button></div>
    </Panel>)}
    <div><Button size="sm" icon="plus" disabled={disabled || draft.cycleDays.length >= 366} onClick={() => {
      const id = slugId(`day-${draft.cycleDays.length + 1}`, draft.cycleDays.map(day => day.id));
      void persist({ ...draft, cycleDays: [...draft.cycleDays, { id, label: `Day ${draft.cycleDays.length + 1}`, slots: [] }] });
    }}>Add rotation day</Button></div>
    {pending && <Hint role="status">Saving timetable…</Hint>}
  </div>;
}
