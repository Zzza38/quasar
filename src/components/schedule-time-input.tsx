'use client';

import { useId, useState } from 'react';
import { displayScheduleTime, parseScheduleTime } from './schedule-time';
import { Input } from './primitives';

export function ScheduleTimeInput({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState({ value, lastValid: value, text: displayScheduleTime(value) });
  const text = draft.value === value ? draft.text : displayScheduleTime(value);
  const afternoon = Number(value.slice(0, 2)) >= 12;
  const meridiem = value ? afternoon ? 'PM' : 'AM' : '';
  // The field shows a 12-hour time with no suffix and the button's aria-label replaces its
  // visible AM/PM text, so both controls point at this hidden span to expose the half of the day.
  const meridiemId = useId();
  return <div className="relative min-w-0">
    <span id={meridiemId} className="sr-only" aria-live="polite">{meridiem}</span>
    <Input small type="text" aria-label={label} aria-describedby={meridiem ? meridiemId : undefined} value={text} disabled={disabled}
      placeholder="h:mm" aria-invalid={!value || undefined} className="pr-10!"
      onChange={(event) => {
        const text = event.target.value;
        const next = parseScheduleTime(text, value || draft.lastValid) ?? '';
        setDraft({ value: next, lastValid: next || value || draft.lastValid, text });
        onChange(next);
      }}
      onBlur={() => { if (value) setDraft({ value, lastValid: value, text: displayScheduleTime(value) }); }} />
    <button type="button" disabled={disabled || !value}
      className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 py-1 text-xs font-medium text-primary disabled:opacity-50"
      aria-label={`${label} AM/PM`} aria-describedby={meridiem ? meridiemId : undefined} title="Switch AM/PM" onClick={() => {
        const next = `${String((Number(value.slice(0, 2)) + 12) % 24).padStart(2, '0')}:${value.slice(3)}`;
        setDraft({ value: next, lastValid: next, text: displayScheduleTime(next) });
        onChange(next);
      }}>{meridiem || '-'}</button>
  </div>;
}
