'use client';

import { useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { emptyPersonalSchedule, resolveDay, scheduleSchema, type PersonalSchedule, type Schedule, type ScheduleSlot } from '@/domain/schedule';
import { formatDate, formatRange } from '@/lib/format';
import { ScheduleEditor, SlotsEditor, describeIssues } from './schedule-editor';
import { Button, Callout, Chip, Field, Input, Segmented, Sheet, Toggle } from './ui';

/** The schedule a student's overrides are expressed against. */
export function effectiveSchedule(school: Schedule, personal: PersonalSchedule): Schedule {
  return personal.customSchedule ?? school;
}

function schoolOnly(personal: PersonalSchedule): PersonalSchedule {
  return { ...emptyPersonalSchedule(), customSchedule: personal.customSchedule ?? null };
}

type DateMode = 'default' | 'closed' | 'open' | 'custom';

export function DateAdjustmentSheet({ open, onClose, date, school, personal, save }: { open: boolean; onClose: () => void; date: string; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  return open ? <DateAdjustmentBody key={date} onClose={onClose} date={date} school={school} personal={personal} save={save} /> : <Sheet open={false} onClose={onClose} title="Adjust this day"><span /></Sheet>;
}

function DateAdjustmentBody({ onClose, date, school, personal, save }: { onClose: () => void; date: string; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  const schedule = effectiveSchedule(school, personal);
  const existing = personal.dateOverrides.find((entry) => entry.date === date);
  const schoolDay = useMemo(() => resolveDay(school, date, schoolOnly(personal)), [school, date, personal]);
  const schoolSlots: ScheduleSlot[] = schoolDay.periods.map((period) => ({ id: period.slotId, periodId: period.periodId, start: period.start, end: period.end }));
  const [mode, setMode] = useState<DateMode>(existing?.closed === true ? 'closed' : existing?.slots ? 'custom' : existing?.closed === false ? 'open' : 'default');
  const [shift, setShift] = useState(existing?.shiftMinutes ?? 0);
  const [slots, setSlots] = useState<ScheduleSlot[]>(existing?.slots ?? schoolSlots);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const draft = useMemo<PersonalSchedule>(() => {
    const others = personal.dateOverrides.filter((entry) => entry.date !== date);
    if (mode === 'default' && !shift) return { ...personal, dateOverrides: others };
    const override: PersonalSchedule['dateOverrides'][number] = { date };
    if (mode === 'closed') override.closed = true;
    if (mode === 'open') override.closed = false;
    if (mode === 'custom') override.slots = slots;
    if (shift && mode !== 'closed') override.shiftMinutes = shift;
    return { ...personal, dateOverrides: [...others, override].sort((left, right) => left.date.localeCompare(right.date)) };
  }, [personal, date, mode, shift, slots]);
  const preview = useMemo(() => { try { return resolveDay(school, date, draft); } catch { return null; } }, [school, date, draft]);
  const modes: Array<{ value: DateMode; label: string }> = [
    { value: 'default', label: schoolDay.closed ? 'Closed (school default)' : 'School default' },
    ...(schoolDay.closed ? [{ value: 'open' as const, label: 'Open for me' }] : [{ value: 'closed' as const, label: 'No school for me' }]),
    { value: 'custom', label: 'My own periods' },
  ];
  const submit = async () => {
    setError(''); setPending(true);
    try { await save(draft); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <Sheet open onClose={onClose} title={`Adjust ${formatDate(date, { weekday: 'long' })}`} description="Only your view changes. The school schedule stays the same for everyone else."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><span className="spacer" />{existing && <Button variant="danger" disabled={pending} onClick={async () => { setMode('default'); setShift(0); setError(''); setPending(true); try { await save({ ...personal, dateOverrides: personal.dateOverrides.filter((entry) => entry.date !== date) }); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } }}>Remove adjustment</Button>}<Button variant="primary" busy={pending} onClick={() => void submit()}>Save</Button></>}>
    <div className="grid gap-1.5"><span className="label">This day for me</span><Segmented label="Day mode" value={mode} onChange={setMode} options={modes} /></div>
    {mode === 'open' && schoolSlots.length === 0 && <Callout tone="info" icon="info">The school has no periods on this date. Choose “My own periods” to add some.</Callout>}
    {mode === 'custom' && <div className="grid gap-1.5"><span className="label">Periods on this day</span><SlotsEditor slots={slots} periods={schedule.periods} onChange={setSlots} emptyText="Add the periods you have on this day." /></div>}
    {mode !== 'closed' && <div className="grid gap-2">
      <Field label="Shift all times" hint="Useful for late starts or early dismissals that only apply to you. Positive numbers move periods later." htmlFor="shift">
        <div className="flex gap-2 items-center flex-wrap">
          <Input id="shift" small type="number" min={-720} max={720} step={5} value={shift} onChange={(event) => setShift(Math.max(-720, Math.min(720, Number(event.target.value) || 0)))} className="max-w-[110px]" />
          <span className="hint">minutes</span>
          {[-60, -30, 30, 60, 120].map((preset) => <Button key={preset} size="sm" variant="ghost" onClick={() => setShift(preset)}>{preset > 0 ? '+' : ''}{preset}</Button>)}
          {shift !== 0 && <Button size="sm" variant="ghost" onClick={() => setShift(0)}>Reset</Button>}
        </div>
      </Field>
    </div>}
    <div className="panel p-4 grid gap-2">
      <div className="flex items-center justify-between"><strong className="text-sm">Preview</strong>{preview?.closed ? <Chip>No school</Chip> : preview ? <Chip tone="accent">{preview.cycleDayLabel}</Chip> : null}</div>
      {preview && !preview.closed && preview.periods.length === 0 && <p className="hint">No periods.</p>}
      {preview && preview.periods.length > 0 && <ul className="grid gap-1 text-sm">{preview.periods.map((period) => <li key={period.slotId} className="flex justify-between gap-3"><span>{period.class?.name ?? period.label}</span><span className="tabular text-text-2">{formatRange(period.start, period.end)}</span></li>)}</ul>}
      {preview && preview.issues.length > 0 && <p className="hint" style={{ color: 'var(--danger-text)' }}>{preview.issues.length} period(s) would fall outside this day with the current shift.</p>}
    </div>
    {error && <p className="callout callout-danger" role="alert">{error}</p>}
  </Sheet>;
}

export function CycleDayAdjustmentSheet({ open, onClose, cycleDayId, school, personal, save }: { open: boolean; onClose: () => void; cycleDayId: string | null; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  return open && cycleDayId ? <CycleDayBody key={cycleDayId} onClose={onClose} cycleDayId={cycleDayId} school={school} personal={personal} save={save} /> : <Sheet open={false} onClose={onClose} title="Adjust rotation day"><span /></Sheet>;
}

function CycleDayBody({ onClose, cycleDayId, school, personal, save }: { onClose: () => void; cycleDayId: string; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  const schedule = effectiveSchedule(school, personal);
  const day = schedule.cycleDays.find((entry) => entry.id === cycleDayId);
  const existing = personal.cycleDayOverrides.find((entry) => entry.cycleDayId === cycleDayId);
  const [enabled, setEnabled] = useState(Boolean(existing));
  const [slots, setSlots] = useState<ScheduleSlot[]>(existing?.slots ?? day?.slots ?? []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError(''); setPending(true);
    try {
      const others = personal.cycleDayOverrides.filter((entry) => entry.cycleDayId !== cycleDayId);
      await save({ ...personal, cycleDayOverrides: enabled ? [...others, { cycleDayId, slots }] : others });
      onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <Sheet open onClose={onClose} title={`Adjust ${day?.label ?? 'rotation day'}`} description="Applies every time this rotation day comes around, for you only."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><span className="spacer" /><Button variant="primary" busy={pending} onClick={() => void submit()}>Save</Button></>}>
    {!day && <Callout tone="warning" icon="alert">This rotation day no longer exists in the school schedule. You can remove your adjustment.</Callout>}
    <Toggle label={`Use my own periods on ${day?.label ?? 'this day'}`} checked={enabled} onChange={setEnabled} />
    {enabled && <SlotsEditor slots={slots} periods={schedule.periods} onChange={setSlots} />}
    {!enabled && day && <ul className="grid gap-1 text-sm panel p-4">{day.slots.map((slot) => <li key={slot.id} className="flex justify-between gap-3"><span>{schedule.periods.find((period) => period.id === slot.periodId)?.label ?? slot.periodId}</span><span className="tabular text-text-2">{formatRange(slot.start, slot.end)}</span></li>)}{day.slots.length === 0 && <li className="hint">No periods.</li>}</ul>}
    {error && <p className="callout callout-danger" role="alert">{error}</p>}
  </Sheet>;
}

export function PrivateScheduleSheet({ open, onClose, school, personal, save }: { open: boolean; onClose: () => void; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  return open ? <PrivateScheduleBody onClose={onClose} school={school} personal={personal} save={save} /> : <Sheet open={false} onClose={onClose} title="Private schedule"><span /></Sheet>;
}

function PrivateScheduleBody({ onClose, school, personal, save }: { onClose: () => void; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  const [draft, setDraft] = useState<Schedule>(() => structuredClone(personal.customSchedule ?? school));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const issues = describeIssues(draft);
  const submit = async () => {
    setError(''); setPending(true);
    try { await save({ ...personal, customSchedule: scheduleSchema.parse(draft) }); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const stop = async () => {
    if (!confirm('Go back to the school schedule? Your private schedule will be deleted. Classes, assignments and date adjustments are kept.')) return;
    setError(''); setPending(true);
    try { await save({ ...personal, customSchedule: null }); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <Sheet open onClose={onClose} wide title={personal.customSchedule ? 'Edit my private schedule' : 'Build a private schedule'} description="A private schedule replaces the school schedule for you only. It starts as a copy of the school schedule."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><span className="spacer" />{personal.customSchedule && <Button variant="danger" disabled={pending} onClick={() => void stop()}>Use the school schedule instead</Button>}<Button variant="primary" busy={pending} disabled={issues.length > 0} onClick={() => void submit()}>Save private schedule</Button></>}>
    <ScheduleEditor value={draft} onChange={setDraft} />
    {error && <p className="callout callout-danger" role="alert">{error}</p>}
  </Sheet>;
}

/** Compact list of everything a student has adjusted, with edit/remove controls. */
export function AdjustmentsList({ school, personal, save, onEditDate, onEditCycleDay }: { school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void>; onEditDate: (date: string) => void; onEditCycleDay: (cycleDayId: string) => void }) {
  const schedule = effectiveSchedule(school, personal);
  const [error, setError] = useState('');
  const run = async (next: PersonalSchedule) => { setError(''); try { await save(next); } catch (err) { setError(errorMessage(err)); } };
  const count = personal.cycleDayOverrides.length + personal.dateOverrides.length;
  if (count === 0) return null;
  return <div className="grid gap-2">
    {personal.cycleDayOverrides.map((entry) => {
      const day = schedule.cycleDays.find((item) => item.id === entry.cycleDayId);
      return <div key={entry.cycleDayId} className="flex items-center gap-3 panel px-3 py-2.5">
        <div className="min-w-0 flex-1"><strong className="text-sm">{day?.label ?? entry.cycleDayId}</strong><div className="hint">{day ? `Your own ${entry.slots.length} periods every ${day.label}` : 'This rotation day no longer exists'}</div></div>
        <Button size="sm" variant="ghost" onClick={() => onEditCycleDay(entry.cycleDayId)}>Edit</Button>
        <Button size="sm" variant="ghost" icon="x" aria-label={`Remove adjustment for ${day?.label ?? entry.cycleDayId}`} onClick={() => void run({ ...personal, cycleDayOverrides: personal.cycleDayOverrides.filter((item) => item.cycleDayId !== entry.cycleDayId) })} />
      </div>;
    })}
    {[...personal.dateOverrides].sort((left, right) => left.date.localeCompare(right.date)).map((entry) => <div key={entry.date} className="flex items-center gap-3 panel px-3 py-2.5">
      <div className="min-w-0 flex-1"><strong className="text-sm">{formatDate(entry.date, { weekday: 'short', year: true })}</strong><div className="hint">{[entry.closed === true && 'No school for me', entry.closed === false && 'Open for me', entry.slots && `${entry.slots.length} custom periods`, entry.shiftMinutes && `times shifted ${entry.shiftMinutes > 0 ? '+' : ''}${entry.shiftMinutes} min`].filter(Boolean).join(' · ') || 'Adjusted'}</div></div>
      <Button size="sm" variant="ghost" onClick={() => onEditDate(entry.date)}>Edit</Button>
      <Button size="sm" variant="ghost" icon="x" aria-label={`Remove adjustment for ${entry.date}`} onClick={() => void run({ ...personal, dateOverrides: personal.dateOverrides.filter((item) => item.date !== entry.date) })} />
    </div>)}
    {error && <p className="callout callout-danger" role="alert">{error}</p>}
  </div>;
}
