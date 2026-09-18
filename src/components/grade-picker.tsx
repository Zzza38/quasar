'use client';

import { useId, useState } from 'react';
import { GRADES, gradeLabel, type Grade, type PersonalSchedule } from '@/domain/schedule';
import { errorMessage } from '@/client/api';
import { Callout, Field, Hint, Select } from './primitives';

export function GradePicker({ personal, save, disabled }: { personal: PersonalSchedule; save: (value: PersonalSchedule) => Promise<void>; disabled?: boolean }) {
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <div className="grid gap-2">
    <Field label="Your grade" htmlFor={id} hint="Used for your school schedule and lunch times.">
      <Select id={id} value={personal.grade ?? ''} disabled={disabled || pending} onChange={async (event) => {
        const grade = event.target.value as Grade;
        setPending(true); setError('');
        try { await save({ ...personal, grade }); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
      }}><option value="" disabled>Choose your grade…</option>{GRADES.map(grade => <option key={grade} value={grade}>{gradeLabel(grade)}</option>)}</Select>
    </Field>
    {personal.customSchedule && <Hint>Your private timetable stays unchanged. Use School → Manage to return to your grade’s shared schedule.</Hint>}
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </div>;
}
