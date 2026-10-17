'use client';

import { useState } from 'react';
import { GRADES, gradeLabel, scheduleForGrade, type Grade, type Schedule } from '@/domain/schedule';
import { schoolExceptionGroups, setSchoolExceptionForGrades, type SchoolExceptionGroup } from '@/domain/school-exceptions';
import { addDays, formatDate, todayIn } from '@/lib/format';
import { ExceptionForm } from './schedule-editor';
import { Button, Chip, Hint, IconButton } from './primitives';
import { Toggle } from './ui/toggle';

type Exception = Schedule['exceptions'][number];
const keyFor = (exception: Exception) => JSON.stringify(exception);

function description({ exception, schedule }: SchoolExceptionGroup): string {
  if (exception.kind === 'closure') return 'No school';
  if (exception.kind === 'replacement') return `Special schedule · ${exception.slots.length} periods`;
  return `Restart on ${schedule.cycleDays.find(day => day.id === exception.cycleDayId)?.label ?? exception.cycleDayId}`;
}

export function SchoolExceptions({ value, onChange, disabled }: { value: Schedule; onChange: (value: Schedule) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const groups = schoolExceptionGroups(value);
  const replace = (group: SchoolExceptionGroup, next: Exception | null, grades = group.grades, includeDefault = group.schoolDefault) => {
    onChange(setSchoolExceptionForGrades(value, group.exception, next, grades, includeDefault));
    setEditing(next ? keyFor(next) : null);
    setError('');
  };
  const changeGrades = (group: SchoolExceptionGroup, grades: Grade[]) => {
    const conflicts = grades.filter(grade => scheduleForGrade(value, grade).exceptions.some(exception => exception.date === group.exception.date && keyFor(exception) !== keyFor(group.exception)));
    if (conflicts.length) {
      setError(`${conflicts.map(gradeLabel).join(', ')} already ${conflicts.length === 1 ? 'has' : 'have'} a different exception on this date. Edit or remove it first.`);
      return;
    }
    replace(group, group.exception, grades, grades.length === GRADES.length);
  };
  const add = () => {
    let date = todayIn(value.timeZone);
    while (groups.some(group => group.exception.date === date)) date = addDays(date, 1);
    const exception: Exception = { date, kind: 'closure', advanceCycle: false };
    onChange(setSchoolExceptionForGrades(value, null, exception, [...GRADES]));
    setEditing(keyFor(exception));
    setError('');
  };
  return <div className="grid gap-4">
    <Hint>Choose the grades for each exception. Each grade keeps its own regular rotation and bell times.</Hint>
    {groups.length === 0 && <Hint>No exceptions yet.</Hint>}
    <div className="grid gap-2">
      {groups.map(group => {
        const { exception, grades } = group;
        const expanded = editing === keyFor(exception);
        // Include every selected grade's dates so the date field catches conflicts across the whole selection.
        const otherDates = [...(group.schoolDefault ? value.exceptions : []), ...grades.flatMap(grade => scheduleForGrade(value, grade).exceptions)].filter(entry => keyFor(entry) !== keyFor(exception));
        const schedule = { ...group.schedule, exceptions: [...otherDates, exception] };
        return <div key={expanded ? 'editing' : keyFor(exception)} className="overflow-hidden rounded-2xl bg-muted/60 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <strong className="text-sm font-bold">{formatDate(exception.date, { weekday: 'short', year: true })}</strong>
              <Hint>{description(group)}</Hint>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {grades.length === GRADES.length ? <Chip>All grades</Chip> : grades.map(grade => <Chip key={grade}>{gradeLabel(grade)}</Chip>)}
                {group.schoolDefault && grades.length !== GRADES.length && <Chip>School default</Chip>}
              </div>
            </div>
            <Button size="sm" variant="ghost" disabled={disabled} aria-expanded={expanded} onClick={() => { setEditing(expanded ? null : keyFor(exception)); setError(''); }}>{expanded ? 'Done' : 'Edit'}</Button>
            <IconButton size="sm" icon="trash" label={`Remove exception on ${exception.date} for ${grades.length === GRADES.length ? 'all grades' : grades.map(gradeLabel).join(', ') || 'the school default'}`} disabled={disabled} onClick={() => replace(group, null)} />
          </div>
          {expanded && <div className="grid gap-3 border-t border-foreground/[0.05] bg-card p-3">
            <fieldset disabled={disabled} className="grid gap-2">
              <legend className="mb-2 text-sm font-semibold">Grades for this exception</legend>
              <div className="flex flex-wrap gap-2">
                <Toggle variant="outline" size="sm" pressed={grades.length === GRADES.length} onPressedChange={() => changeGrades(group, [...GRADES])}>All grades</Toggle>
                {GRADES.map(grade => <Toggle key={grade} variant="outline" size="sm" pressed={grades.includes(grade)} disabled={disabled || grades.length === 1 && grades.includes(grade)} onPressedChange={selected => changeGrades(group, selected ? GRADES.filter(entry => entry === grade || grades.includes(entry)) : grades.filter(entry => entry !== grade))}>{gradeLabel(grade)}</Toggle>)}
              </div>
            </fieldset>
            {error && <Hint tone="danger" role="alert">{error}</Hint>}
            <ExceptionForm exception={exception} schedule={schedule} disabled={disabled} onChange={next => replace(group, next)} />
          </div>}
        </div>;
      })}
    </div>
    <div><Button size="sm" icon="plus" disabled={disabled} onClick={add}>Add exception</Button></div>
  </div>;
}
