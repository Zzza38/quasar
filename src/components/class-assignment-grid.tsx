'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { scheduleSchema, withCycleDay, type PersonalSchedule, type Schedule, type ScheduleSlot } from '@/domain/schedule';
import { errorMessage } from '@/client/api';
import { slugId } from '@/lib/format';
import { makesPrivateCopy, queueTimetableEdit, rebaseTimetableEdit, saveTimetableEdit, type QueuedTimetableEdit } from './personal-timetable';
import { ScheduleGrid } from './schedule-grid';
import { SlotsEditor } from './schedule-editor';
import { Button, Callout, Hint, Panel } from './primitives';

/**
 * A change waiting for the student's answer in the in-place confirmation. 'copy' is an edit that makes a private
 * copy of the timetable (`actions` names each edit, e.g. 'Renaming a day'); 'remove' removes a day from the copy.
 */
export type PendingChange =
  | { kind: 'copy'; actions: string[]; runs: Array<() => void> }
  | { kind: 'remove'; dayId: string; label: string; runs: Array<() => void> };

/**
 * Adds a change to the ones waiting for an answer instead of replacing them: a rename committed by the blur of the
 * click that then adds or removes a day must not be dropped. Edits that make the private copy share one prompt,
 * so confirming it saves all of them; a second removal of the same day adds nothing.
 */
export function queuePendingChange(queue: PendingChange[], change: PendingChange): PendingChange[] {
  if (change.kind === 'copy') {
    const index = queue.findIndex((entry) => entry.kind === 'copy');
    if (index < 0) return [...queue, change];
    const current = queue[index] as Extract<PendingChange, { kind: 'copy' }>;
    const merged = { ...current, actions: [...current.actions, ...change.actions.filter((action) => !current.actions.includes(action))], runs: [...current.runs, ...change.runs] };
    return queue.map((entry, position) => position === index ? merged : entry);
  }
  return queue.some((entry) => entry.kind === 'remove' && entry.dayId === change.dayId) ? queue : [...queue, change];
}

/** The prompt shown for a waiting change. */
export function describePendingChange(change: PendingChange): { title: string; body: string; confirmLabel: string } {
  if (change.kind === 'remove') return { title: `Remove ${change.label} from your private rotation?`, body: 'Dates will be recalculated across the remaining days.', confirmLabel: 'Remove day' };
  const [first, ...rest] = change.actions.map((action, index) => index === 0 ? action : action.charAt(0).toLowerCase() + action.slice(1));
  const subject = rest.length === 0 ? first : `${[first, ...rest.slice(0, -1)].join(', ')} and ${rest[rest.length - 1]}`;
  return {
    title: 'Make your own copy of the timetable?',
    body: `${subject} ${rest.length ? 'make' : 'makes'} your own copy of the timetable. School corrections, such as new bell times, will no longer reach you.`,
    confirmLabel: 'Make my own copy',
  };
}

export function ClassAssignmentGrid({ schedule, personal, save, disabled }: {
  schedule: Schedule; personal: PersonalSchedule; save: (value: PersonalSchedule) => Promise<void>; disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const queued = useRef<QueuedTimetableEdit | null>(null);
  const waiter = useRef<{ from: PersonalSchedule; resolve: () => void } | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editedSlots, setEditedSlots] = useState<ScheduleSlot[]>([]);
  /** Changes waiting for the student's answer in the in-place confirmation; the first one is shown. */
  const [waiting, setWaiting] = useState<PendingChange[]>([]);
  const ask = (change: PendingChange) => setWaiting((queue) => queuePendingChange(queue, change));
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
  // A removal waiting behind another is dropped once its day is gone, and cannot remove the last day: the grid
  // disables its trash button at one day, but both removals of a two-day rotation can be waiting at once.
  const live = (entry: PendingChange) => entry.kind !== 'remove' || draft.cycleDays.some((day) => day.id === entry.dayId);
  const confirming = waiting.find(live);
  const prompt = confirming && describePendingChange(confirming);
  const lastDay = confirming?.kind === 'remove' && draft.cycleDays.length <= 1;
  /** Takes the shown change off the queue, with any removal whose day is already gone (a reused day ID must not revive it). */
  const answered = () => setWaiting((queue) => queue.filter((entry) => entry !== confirming && live(entry)));
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
  const build = (edit: QueuedTimetableEdit) => {
    const { schedule: basis, personal: base, assignments: shown, draft: current } = latest.current;
    const next = edit.change ? saveTimetableEdit(basis, base, edit.change(current), shown) : base;
    // Assignments go last so a timetable draft cannot overwrite a class the student just placed.
    return edit.assign ? { ...next, assignments: { ...next.assignments, ...edit.assign } } : next;
  };
  const enqueue = async (edit: QueuedTimetableEdit) => {
    if (disabled) return;
    if (saving.current) { queued.current = queueTimetableEdit(queued.current, edit); return; }
    saving.current = true; setPending(true); setError('');
    try {
      let next: QueuedTimetableEdit | null = edit;
      while (next) {
        const from = latest.current.personal;
        await save(build(next));
        next = queued.current; queued.current = null;
        if (next) await rendered(from);
      }
    } catch (err) { queued.current = null; setError(errorMessage(err)); }
    finally { saving.current = false; setPending(false); }
  };
  /**
   * Saves a timetable change once. Rotation-day overrides only hold slots, so an edit they cannot express (renaming,
   * adding or removing a day, or placing a class in a block the school does not have) saves a private copy of the
   * whole timetable, which school corrections no longer reach. Every such edit asks first, in place (docs/CHAT.md
   * §Dialogs: no native confirm()), and is saved only when the student agrees; then this returns false.
   */
  const persist = (next: Schedule, action: string, then?: () => void): boolean => {
    // `draft` is the timetable this render showed, which is what `next` was built from.
    const run = () => { void enqueue({ change: rebaseTimetableEdit(draft, next) }); then?.(); };
    if (!makesPrivateCopy(schedule, personal, next, assignments)) { run(); return true; }
    ask({ kind: 'copy', actions: [action], runs: [run] });
    return false;
  };
  const renames = (next: Schedule) => next.cycleDays.some(day => draft.cycleDays.some(entry => entry.id === day.id && entry.label !== day.label));
  return <div className="grid gap-3 min-w-0">
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    {confirming && prompt && <Callout tone="warning" icon="alert" role="alert" title={prompt.title} actions={<>
      <Button size="sm" variant="danger" disabled={disabled || lastDay} onClick={() => { answered(); for (const run of confirming.runs) run(); }}>{prompt.confirmLabel}</Button>
      <Button size="sm" autoFocus onClick={answered}>Cancel</Button>
    </>}>{prompt.body}</Callout>}
    <ScheduleGrid value={draft} personal={displayPersonal} personalClassesOnly onAssign={(periodId, classId) => enqueue({ assign: { [periodId]: classId } })} onChange={next => persist(next, renames(next) ? 'Renaming a day' : 'Placing this class')} disabled={disabled}
      onEditDay={id => { setEditing(id); setEditedSlots(draft.cycleDays.find(day => day.id === id)?.slots ?? []); }} onRemoveDay={id => {
        const days = draft.cycleDays.filter(day => day.id !== id);
        if (!days.length) return;
        const remove = () => persist({ ...draft, cycleDays: days, anchorCycleDayId: draft.anchorCycleDayId === id ? days[0].id : draft.anchorCycleDayId, exceptions: draft.exceptions.filter(entry => entry.kind !== 'reset' || entry.cycleDayId !== id) }, 'Removing a day');
        // Without a private copy yet, removing a day makes one, and that confirmation already asks.
        if (!personal.customSchedule) { remove(); return; }
        const label = draft.cycleDays.find(day => day.id === id)?.label ?? 'this day';
        ask({ kind: 'remove', dayId: id, label, runs: [() => void remove()] });
      }} />
    {draft.cycleDays.filter(day => day.id === editing).map(day => <Panel key={day.id} className="grid gap-2 p-3"><strong className="text-sm">{day.label} times</strong>
      <SlotsEditor slots={editedSlots} periods={draft.periods} disabled={disabled} onChange={setEditedSlots} />
      <div><Button size="sm" disabled={disabled || !scheduleSchema.safeParse({ ...draft, cycleDays: draft.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: editedSlots } : entry) }).success} onClick={() => { persist({ ...draft, cycleDays: draft.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: editedSlots } : entry) }, 'Saving these times', () => setEditing(null)); }}>Save times</Button></div>
    </Panel>)}
    <div><Button size="sm" icon="plus" disabled={disabled || draft.cycleDays.length >= 366} onClick={() => {
      const id = slugId(`day-${draft.cycleDays.length + 1}`, draft.cycleDays.map(day => day.id));
      persist(withCycleDay(draft, { id, label: `Day ${draft.cycleDays.length + 1}`, slots: [] }), 'Adding a day');
    }}>Add rotation day</Button></div>
    {pending && <Hint role="status">Saving timetable…</Hint>}
  </div>;
}
