'use client';

import { useRef, useState } from 'react';
import { errorMessage } from '@/client/api';
import { effectiveSchedule, type ResolvedPeriod } from '@/domain/schedule';
import { formatDate, formatRange } from '@/lib/format';
import type { AppState } from './app-state';
import { Button, Field, Hint, Modal, Select } from './primitives';

/**
 * Opened from a Timeline row on Today or Schedule: pick which class sits in this period, or jump to a
 * one-day adjustment. Assignments are keyed by period, so the choice applies on every rotation day
 * that has the period; the hint says which days those are.
 */
export function PeriodSheet({ state, period, date, onClose, onAdjustDay }: { state: AppState; period: ResolvedPeriod | null; date: string; onClose: () => void; onAdjustDay: () => void }) {
  return period ? <PeriodSheetBody key={`${period.slotId}:${date}`} state={state} period={period} date={date} onClose={onClose} onAdjustDay={onAdjustDay} /> : null;
}

function PeriodSheetBody({ state, period, date, onClose, onAdjustDay }: { state: AppState; period: ResolvedPeriod; date: string; onClose: () => void; onAdjustDay: () => void }) {
  const { personal } = state;
  const [pending, setPending] = useState(false);
  // Controls stay enabled while saving (disabling the picker would drop its focus); this ref blocks
  // a second save and any close until the first save finishes. `busy` on the Modal covers Escape and X.
  const pendingRef = useRef(false);
  const whenIdle = (action: () => void) => () => { if (!pendingRef.current) action(); };
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const assigned = personal.assignments[period.periodId] ?? '';
  const current = personal.classes.find((cls) => cls.id === assigned);
  const days = effectiveSchedule(state.schedule, personal).cycleDays.filter((day) => day.slots.some((slot) => slot.periodId === period.periodId)).map((day) => day.label);
  const scope = days.length > 1 ? `Applies on every day with ${period.label}: ${days.join(', ')}.` : days.length === 1 ? `Applies on ${days[0]}.` : `Applies wherever ${period.label} meets.`;

  const assign = async (classId: string) => {
    if (classId === assigned || pendingRef.current) return;
    const assignments = { ...personal.assignments };
    if (classId) assignments[period.periodId] = classId;
    else delete assignments[period.periodId];
    pendingRef.current = true; setPending(true); setError(''); setSaved(false);
    try { await state.savePersonal({ ...personal, assignments }); setSaved(true); } catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setPending(false); }
  };

  return <Modal open onClose={onClose} busy={pending} title={current?.name ?? period.label}
    description={`${period.label} · ${formatRange(period.start, period.end)} · ${formatDate(date, { weekday: 'long' })}`}
    footer={<Button variant="primary" onClick={whenIdle(onClose)}>Done</Button>}>
    <Field label={`Class in ${period.label}`} htmlFor="period-class" hint={scope} error={error}>
      {personal.classes.length > 0
        ? <Select id="period-class" value={assigned} onChange={(event) => void assign(event.target.value)}>
          <option value="">No class</option>
          {personal.classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name}</option>)}
        </Select>
        : <div className="flex flex-wrap items-center gap-2"><Hint>You have not added any classes yet.</Hint><Button size="sm" onClick={() => { onClose(); state.navigate('classes'); }}>Add a class</Button></div>}
    </Field>
    {saved && <Hint role="status">Class updated.</Hint>}
    <div className="grid gap-1.5">
      <div><Button icon="calendar" onClick={whenIdle(onAdjustDay)}>Adjust this day</Button></div>
      <Hint>Close, reopen or move periods on {formatDate(date, { weekday: 'long' })} only.</Hint>
    </div>
    <div><Button variant="link" className="h-auto px-0" onClick={whenIdle(() => { onClose(); state.navigate('school', { fix: 'times' }); })}>Bell time wrong? Fix the school schedule</Button></div>
  </Modal>;
}
