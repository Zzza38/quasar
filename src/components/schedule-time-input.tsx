'use client';

import { useState } from 'react';
import { displayScheduleTime, parseScheduleTime } from './schedule-time';
import { Input } from './ui';

export function ScheduleTimeInput({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState({ value, lastValid: value, text: displayScheduleTime(value) });
  const text = draft.value === value ? draft.text : displayScheduleTime(value);
  const afternoon = Number(value.slice(0, 2)) >= 12;
  return <div className="relative min-w-0">
    <Input small type="text" aria-label={label} value={text} disabled={disabled}
      placeholder="h:mm" aria-invalid={!value || undefined} className="pr-10!"
      onChange={(event) => {
        const text = event.target.value;
        const next = parseScheduleTime(text, value || draft.lastValid) ?? '';
        setDraft({ value: next, lastValid: next || value || draft.lastValid, text });
        onChange(next);
      }}
      onBlur={() => { if (value) setDraft({ value, lastValid: value, text: displayScheduleTime(value) }); }} />
    <button type="button" disabled={disabled || !value}
      className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 py-1 text-xs font-medium text-accent disabled:opacity-50"
      aria-label={`${label} AM/PM`} title="Switch AM/PM" onClick={() => {
        const next = `${String((Number(value.slice(0, 2)) + 12) % 24).padStart(2, '0')}:${value.slice(3)}`;
        setDraft({ value: next, lastValid: next, text: displayScheduleTime(next) });
        onChange(next);
      }}>{value ? afternoon ? 'PM' : 'AM' : '—'}</button>
  </div>;
}
