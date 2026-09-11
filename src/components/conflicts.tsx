'use client';

import { useState, type ReactNode } from 'react';
import type { Workspace } from '@/client/api';
import { errorMessage } from '@/client/api';
import type { WorkspaceSnapshot } from '@/client/offline';
import { detectOverrideConflicts, personalScheduleSchema, resolveDay, type PersonalSchedule, type Schedule } from '@/domain/schedule';
import type { Entity } from '@/domain/sync';
import { taskSchema } from '@/domain/task';
import { formatDate, formatDateTime, formatRange, WEEKDAYS } from '@/lib/format';
import { Button, Callout, Chip } from './ui';

/* ---------- Generic field comparison ---------- */

export interface FieldSpec<T> { key: string; label: string; render: (value: T) => ReactNode }

export function DiffTable<T>({ left, right, leftTitle, rightTitle, fields, onlyChanged = false }: { left: T | null; right: T | null; leftTitle: string; rightTitle: string; fields: FieldSpec<T>[]; onlyChanged?: boolean }) {
  const rows = fields.map((field) => {
    const a = left ? field.render(left) : null;
    const b = right ? field.render(right) : null;
    return { field, a, b, changed: JSON.stringify(a) !== JSON.stringify(b) };
  }).filter((row) => !onlyChanged || row.changed);
  return <div className="overflow-x-auto"><table className="diff-table">
    <thead><tr><th style={{ width: '22%' }}>Field</th><th>{leftTitle}</th><th>{rightTitle}</th></tr></thead>
    <tbody>
      {left === null && <tr><td colSpan={3}><em>{leftTitle}: deleted</em></td></tr>}
      {right === null && <tr><td colSpan={3}><em>{rightTitle}: deleted</em></td></tr>}
      {rows.map((row) => <tr key={row.field.key}><td className="text-text-2 font-medium">{row.field.label}</td><td className={row.changed ? 'changed' : ''}>{row.a ?? <span className="text-text-3">—</span>}</td><td className={row.changed ? 'changed' : ''}>{row.b ?? <span className="text-text-3">—</span>}</td></tr>)}
      {rows.length === 0 && <tr><td colSpan={3} className="text-text-3">No differences.</td></tr>}
    </tbody>
  </table></div>;
}

const empty = (value: unknown) => value === null || value === undefined || value === '' ? null : String(value);

export function taskFields(classes: Array<{ id: string; name: string }>): FieldSpec<Record<string, unknown>>[] {
  return [
    { key: 'title', label: 'Title', render: (task) => empty(task.title) },
    { key: 'due', label: 'Due', render: (task) => typeof task.dueDate === 'string' ? formatDateTime(task.dueDate, typeof task.dueTime === 'string' ? task.dueTime : null) : null },
    { key: 'classId', label: 'Class', render: (task) => classes.find((item) => item.id === task.classId)?.name ?? empty(task.classId) },
    { key: 'notes', label: 'Notes', render: (task) => empty(task.notes) },
    { key: 'completed', label: 'Status', render: (task) => task.completed ? 'Completed' : 'Open' },
  ];
}

export function personalFields(schedule: Schedule): FieldSpec<Record<string, unknown>>[] {
  const parse = (value: Record<string, unknown>) => { const parsed = personalScheduleSchema.safeParse(value); return parsed.success ? parsed.data : null; };
  const periodLabel = (id: string) => schedule.periods.find((period) => period.id === id)?.label ?? id;
  return [
    { key: 'classes', label: 'Classes', render: (value) => { const personal = parse(value); return personal ? personal.classes.map((item) => [item.name, item.room && `Rm ${item.room}`, item.teacher].filter(Boolean).join(' · ')).join('; ') || null : 'Unreadable'; } },
    { key: 'assignments', label: 'Period assignments', render: (value) => { const personal = parse(value); return personal ? Object.entries(personal.assignments).map(([period, classId]) => `${periodLabel(period)} → ${personal.classes.find((item) => item.id === classId)?.name ?? classId}`).join('; ') || null : null; } },
    { key: 'cycleDayOverrides', label: 'Rotation-day adjustments', render: (value) => { const personal = parse(value); return personal ? personal.cycleDayOverrides.map((entry) => schedule.cycleDays.find((day) => day.id === entry.cycleDayId)?.label ?? entry.cycleDayId).join(', ') || null : null; } },
    { key: 'dateOverrides', label: 'Date adjustments', render: (value) => { const personal = parse(value); return personal ? personal.dateOverrides.map((entry) => `${formatDate(entry.date)}${entry.closed ? ' (closed)' : ''}${entry.shiftMinutes ? ` (${entry.shiftMinutes > 0 ? '+' : ''}${entry.shiftMinutes} min)` : ''}${entry.slots ? ' (custom periods)' : ''}`).join(', ') || null : null; } },
    { key: 'customSchedule', label: 'Private schedule', render: (value) => { const personal = parse(value); return personal ? (personal.customSchedule ? `${personal.customSchedule.cycleDays.length}-day private schedule` : 'Uses the school schedule') : null; } },
  ];
}

/* ---------- Draft protection while editing ---------- */

export function ChangedWhileEditing<T extends Record<string, unknown>>({ draft, current, fields, onKeep, onLoad }: { draft: T; current: T | null; fields: FieldSpec<Record<string, unknown>>[]; onKeep: () => void; onLoad: () => void }) {
  return <Callout tone="warning" icon="alert" title={current === null ? 'This was deleted on another device' : 'This changed on another device while you were editing'} role="alert"
    actions={<><Button size="sm" variant="secondary" onClick={onKeep}>Keep my draft</Button><Button size="sm" variant="secondary" onClick={onLoad}>{current === null ? 'Discard my draft' : 'Use the saved version'}</Button></>}>
    <div className="mt-2 bg-surface rounded-lg"><DiffTable left={draft} right={current} leftTitle="My draft" rightTitle="Saved version" fields={fields} onlyChanged /></div>
  </Callout>;
}

/* ---------- Device conflicts ---------- */

export function DeviceConflicts({ snapshot, schedule, classes, resolve }: { snapshot: WorkspaceSnapshot; schedule: Schedule | null; classes: Array<{ id: string; name: string }>; resolve: (mutationId: string, choice: 'local' | 'remote') => Promise<void> }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  if (snapshot.conflicts.length === 0) return null;
  return <div className="grid gap-3">
    {snapshot.conflicts.map((conflict) => {
      const local = snapshot.entities.find((entity) => entity.kind === conflict.mutation.kind && entity.id === conflict.mutation.id) ?? null;
      const isTask = conflict.mutation.kind === 'task';
      const fields = isTask ? taskFields(classes) : schedule ? personalFields(schedule) : [];
      const title = isTask ? (taskSchema.safeParse(local?.data).data?.title ?? taskSchema.safeParse(conflict.current?.data).data?.title ?? 'a task') : 'your personal schedule';
      const choose = async (choice: 'local' | 'remote') => {
        setError(''); setPending(conflict.mutation.mutationId);
        try { await resolve(conflict.mutation.mutationId, choice); } catch (err) { setError(errorMessage(err)); } finally { setPending(null); }
      };
      return <section key={conflict.mutation.mutationId} className="card card-pad grid gap-3 border-l-4" style={{ borderLeftColor: 'var(--now)' }} aria-labelledby={`conflict-${conflict.mutation.mutationId}`}>
        <div><h2 id={`conflict-${conflict.mutation.mutationId}`} className="text-[17px]">Choose which changes to keep</h2><p className="text-sm text-text-2 mt-1">{isTask ? `“${title}”` : 'Your personal schedule'} was edited here and on another device. Nothing is lost until you choose.</p></div>
        <DiffTable left={local && !local.deleted ? local.data : null} right={conflict.current && !conflict.current.deleted ? conflict.current.data : null} leftTitle="This device" rightTitle="Other device" fields={fields} />
        {error && <p className="callout callout-danger" role="alert">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" busy={pending === conflict.mutation.mutationId} onClick={() => void choose('local')}>Keep my changes</Button>
          <Button variant="secondary" disabled={pending !== null} onClick={() => void choose('remote')}>Use the other device’s version</Button>
        </div>
      </section>;
    })}
  </div>;
}

/* ---------- School schedule changes ---------- */

const weekdayNames = (values: number[]) => values.map((value) => WEEKDAYS.find((day) => day.value === value)?.short ?? value).join(', ') || 'none';

export function describeScheduleChanges(previous: Schedule, current: Schedule): string[] {
  const changes: string[] = [];
  if (previous.timeZone !== current.timeZone) changes.push(`Time zone changed from ${previous.timeZone} to ${current.timeZone}.`);
  if (JSON.stringify(previous.schoolWeekdays) !== JSON.stringify(current.schoolWeekdays)) changes.push(`School days are now ${weekdayNames(current.schoolWeekdays)} (was ${weekdayNames(previous.schoolWeekdays)}).`);
  if (JSON.stringify(previous.advanceWeekdays) !== JSON.stringify(current.advanceWeekdays)) changes.push(`Rotation advance days are now ${weekdayNames(current.advanceWeekdays)} (was ${weekdayNames(previous.advanceWeekdays)}).`);
  if (previous.anchorDate !== current.anchorDate || previous.anchorCycleDayId !== current.anchorCycleDayId) {
    const day = current.cycleDays.find((entry) => entry.id === current.anchorCycleDayId)?.label ?? current.anchorCycleDayId;
    changes.push(`Starting point is now ${day} on ${formatDate(current.anchorDate, { year: true })}.`);
  }
  for (const period of current.periods) {
    const old = previous.periods.find((entry) => entry.id === period.id);
    if (!old) changes.push(`Added period ${period.label}${period.kind !== 'class' ? ` (${period.kind})` : ''}.`);
    else if (old.label !== period.label || old.kind !== period.kind) changes.push(`Period ${old.label} is now ${period.label}${old.kind !== period.kind ? ` (${period.kind})` : ''}.`);
  }
  for (const period of previous.periods) if (!current.periods.some((entry) => entry.id === period.id)) changes.push(`Removed period ${period.label}.`);
  for (const day of current.cycleDays) {
    const old = previous.cycleDays.find((entry) => entry.id === day.id);
    if (!old) changes.push(`Added rotation day ${day.label}.`);
    else {
      if (old.label !== day.label) changes.push(`Rotation day ${old.label} is now ${day.label}.`);
      if (JSON.stringify(old.slots) !== JSON.stringify(day.slots)) changes.push(`${day.label}: periods or times changed (${day.slots.map((slot) => `${current.periods.find((period) => period.id === slot.periodId)?.label ?? slot.periodId} ${formatRange(slot.start, slot.end)}`).join(', ')}).`);
    }
  }
  for (const day of previous.cycleDays) if (!current.cycleDays.some((entry) => entry.id === day.id)) changes.push(`Removed rotation day ${day.label}.`);
  for (const exception of current.exceptions) {
    const old = previous.exceptions.find((entry) => entry.date === exception.date);
    const summary = exception.kind === 'closure' ? 'no school' : exception.kind === 'replacement' ? 'special schedule' : `rotation restarts on ${current.cycleDays.find((day) => day.id === exception.cycleDayId)?.label ?? exception.cycleDayId}`;
    if (!old) changes.push(`${formatDate(exception.date, { weekday: 'short', year: true })}: ${summary}.`);
    else if (JSON.stringify(old) !== JSON.stringify(exception)) changes.push(`${formatDate(exception.date, { weekday: 'short', year: true })}: exception changed (${summary}).`);
  }
  for (const exception of previous.exceptions) if (!current.exceptions.some((entry) => entry.date === exception.date)) changes.push(`${formatDate(exception.date, { weekday: 'short', year: true })}: exception removed.`);
  if (changes.length === 0 && JSON.stringify(previous) !== JSON.stringify(current)) changes.push('Minor changes that do not affect any dates.');
  return changes;
}

export function SchoolReview({ review, personal, online, onAcknowledge, onOpenClasses, today }: { review: NonNullable<Workspace['review']>; personal: PersonalSchedule; online: boolean; onAcknowledge: () => Promise<void>; onOpenClasses: () => void; today: string }) {
  const conflicts = detectOverrideConflicts(review.previous, review.current, personal);
  const changes = describeScheduleChanges(review.previous, review.current);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const todayBefore = resolveDay(review.previous, today, personal);
  const todayAfter = resolveDay(review.current, today, personal);
  const todayChanged = JSON.stringify(todayBefore) !== JSON.stringify(todayAfter);
  return <section className="card card-pad grid gap-3 border-l-4" style={{ borderLeftColor: 'var(--accent)' }} aria-labelledby="review-title">
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div><h2 id="review-title" className="text-[17px]">Your school’s schedule was updated</h2><p className="text-sm text-text-2 mt-1">Your classes and personal adjustments are untouched. Here is what changed.</p></div>
      {todayChanged ? <Chip tone="now" icon="alert">Today looks different</Chip> : <Chip tone="success" icon="check">Today is unaffected</Chip>}
    </div>
    <ul className="grid gap-1 text-sm list-disc pl-5">{(showAll ? changes : changes.slice(0, 6)).map((change) => <li key={change}>{change}</li>)}</ul>
    {changes.length > 6 && <button type="button" className="text-sm text-accent text-left" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${changes.length} changes`}</button>}
    {conflicts.length > 0 && <Callout tone="warning" icon="alert" title="Some of your personal settings refer to what changed" actions={<Button size="sm" variant="secondary" onClick={onOpenClasses}>Review my classes and adjustments</Button>}>
      <ul className="grid gap-1 mt-1 list-disc pl-4 text-[13.5px]">{conflicts.map((conflict) => <li key={conflict.id}>{conflict.message}</li>)}</ul>
    </Callout>}
    {error && <p className="callout callout-danger" role="alert">{error}</p>}
    <div className="flex flex-wrap gap-2 items-center">
      <Button variant="primary" disabled={!online} busy={pending} onClick={async () => { setError(''); setPending(true); try { await onAcknowledge(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } }}>Got it, keep my settings</Button>
      {!online && <span className="hint">Connect to dismiss this notice.</span>}
    </div>
  </section>;
}
