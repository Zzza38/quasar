'use client';

import { useState } from 'react';
import { GRADES, gradeLabel, scheduleForGrade, type Grade, type Schedule } from '@/domain/schedule';
import { schoolExceptionGroups, setSchoolExceptionForGrades, slotCopySources, type SchoolExceptionGroup } from '@/domain/school-exceptions';
import { addDays, todayIn } from '@/lib/format';
import { ExceptionForm, ExceptionRow, summarizeException } from './schedule-editor';
import { Icon } from './icon';
import { Button, Hint } from './primitives';
import { Toggle } from './ui/toggle';

type Exception = Schedule['exceptions'][number];
const keyFor = (exception: Exception) => JSON.stringify(exception);

function audience({ grades, schoolDefault }: SchoolExceptionGroup): string {
  if (grades.length === GRADES.length) return 'All grades';
  const names = grades.length === 0 ? '' : grades.length === 1 ? gradeLabel(grades[0]) : `Grades ${grades.join(', ')}`;
  return [names, schoolDefault && 'School default'].filter(Boolean).join(' + ');
}

const GRADE_TOGGLE = 'gap-1.5 rounded-full bg-card px-3 font-semibold text-muted-foreground hover:text-foreground data-[state=on]:border-primary/40 data-[state=on]:bg-primary-soft data-[state=on]:text-primary-soft-foreground dark:bg-input/20 dark:data-[state=on]:bg-primary-soft';

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
    <Hint>Each exception can apply to some grades or all of them. Every grade keeps its own regular rotation and bell times.</Hint>
    {groups.length === 0 && <Hint>No exceptions yet.</Hint>}
    <div className="grid gap-2">
      {groups.map(group => {
        const { exception, grades } = group;
        const expanded = editing === keyFor(exception);
        // Include every selected grade's dates so the date field catches conflicts across the whole selection.
        const otherDates = [...(group.schoolDefault ? value.exceptions : []), ...grades.flatMap(grade => scheduleForGrade(value, grade).exceptions)].filter(entry => keyFor(entry) !== keyFor(exception));
        const schedule = { ...group.schedule, exceptions: [...otherDates, exception] };
        // Any grade's days can be copied, as long as every schedule this exception reaches has the periods they use.
        const targets = [...(group.schoolDefault ? [value] : []), ...grades.map(grade => scheduleForGrade(value, grade))];
        const copySources = slotCopySources(GRADES.map(grade => ({ grade, schedule: scheduleForGrade(value, grade) })), targets, exception.date);
        const everyone = grades.length === GRADES.length;
        return <ExceptionRow key={expanded ? 'editing' : keyFor(exception)} exception={exception} expanded={expanded} disabled={disabled}
          summary={`${summarizeException(exception, group.schedule)} · ${audience(group)}`}
          onToggle={() => { setEditing(expanded ? null : keyFor(exception)); setError(''); }}
          removeLabel={`Remove exception on ${exception.date} for ${everyone ? 'all grades' : grades.map(gradeLabel).join(', ') || 'the school default'}`}
          onRemove={() => replace(group, null)}>
          <ExceptionForm exception={exception} schedule={schedule} disabled={disabled} copySources={copySources} onChange={next => replace(group, next)}
            scope={<fieldset disabled={disabled} className="grid gap-2">
              <legend className="mb-1.5 text-[13px] font-semibold text-foreground/80">Grades for this exception</legend>
              <div className="flex flex-wrap gap-1.5">
                <Toggle variant="outline" size="sm" className={GRADE_TOGGLE} pressed={everyone} onPressedChange={() => changeGrades(group, [...GRADES])}>{everyone && <Icon name="check" size={13} strokeWidth={2.6} />}All grades</Toggle>
                {GRADES.map(grade => <Toggle key={grade} variant="outline" size="sm" className={GRADE_TOGGLE} pressed={grades.includes(grade)} disabled={disabled || grades.length === 1 && grades.includes(grade)} onPressedChange={selected => changeGrades(group, selected ? GRADES.filter(entry => entry === grade || grades.includes(entry)) : grades.filter(entry => entry !== grade))}>{grades.includes(grade) && <Icon name="check" size={13} strokeWidth={2.6} />}{gradeLabel(grade)}</Toggle>)}
              </div>
              {error && <Hint tone="danger" role="alert">{error}</Hint>}
            </fieldset>} />
        </ExceptionRow>;
      })}
    </div>
    <div><Button size="sm" icon="plus" disabled={disabled} onClick={add}>Add exception</Button></div>
  </div>;
}
