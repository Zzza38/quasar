'use client';

import { useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { describeDayIssues, effectiveSchedule, emptyPersonalSchedule, resolveDay, scheduleSchema, type PersonalSchedule, type Schedule, type ScheduleSlot } from '@/domain/schedule';
import { formatDate, formatRange } from '@/lib/format';
import { Icon } from './icon';
import { useSchoolTimetable } from './personal-timetable';
import { ScheduleEditor, SlotsEditor, describeIssues } from './schedule-editor';
import { Button, Callout, Chip, Field, Hint, Input, Modal, Panel, Segmented, Spacer, Toggle } from './primitives';
import { Label } from './ui/label';

/** The schedule a student's overrides are expressed against. */
export { effectiveSchedule } from '@/domain/schedule';

function schoolOnly(personal: PersonalSchedule): PersonalSchedule {
  return { ...emptyPersonalSchedule(), grade: personal.grade, customSchedule: personal.customSchedule ?? null };
}

type DateMode = 'default' | 'closed' | 'open' | 'custom';

/**
 * The shift field's text as whole minutes, clamped to ±720, or null while it is not a number yet (empty, a lone
 * '-', a decimal). The typed text is never rewritten from a null, so a partial entry does not snap to 0
 * mid-typing; committedShift decides which shift that text saves.
 */
export function parseShift(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Math.max(-720, Math.min(720, Number(trimmed))) || 0;
}

/**
 * The shift to commit for the field's text. An emptied field means no shift, so clearing it and pressing Save
 * removes the shift. Browsers report a lone '-' in a number field as '' too, which is harmless: the field keeps
 * showing what was typed, and finishing the number ('-5') commits it. Any other partial entry keeps `current`.
 */
export function committedShift(text: string, current: number): number {
  return parseShift(text) ?? (text.trim() ? current : 0);
}

export function DateAdjustmentSheet({ open, onClose, date, school, personal, save }: { open: boolean; onClose: () => void; date: string; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  return open ? <DateAdjustmentBody key={date} onClose={onClose} date={date} school={school} personal={personal} save={save} /> : null;
}

function DateAdjustmentBody({ onClose, date, school, personal, save }: { onClose: () => void; date: string; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  const schedule = effectiveSchedule(school, personal);
  const existing = personal.dateOverrides.find((entry) => entry.date === date);
  const schoolDay = useMemo(() => resolveDay(school, date, schoolOnly(personal)), [school, date, personal]);
  const schoolSlots: ScheduleSlot[] = schoolDay.periods.map((period) => ({ id: period.slotId, periodId: period.periodId, start: period.start, end: period.end }));
  const [mode, setMode] = useState<DateMode>(existing?.closed === true ? 'closed' : existing?.slots ? 'custom' : existing?.closed === false ? 'open' : 'default');
  const [shift, setShiftMinutes] = useState(existing?.shiftMinutes ?? 0);
  // The typed text is kept apart from the committed shift (as ScheduleTimeInput does), so clearing the field or
  // starting with '-' is not snapped back to '0'. Blur shows the committed value again.
  const [shiftText, setShiftText] = useState(String(shift));
  const setShift = (minutes: number) => { setShiftMinutes(minutes); setShiftText(String(minutes)); };
  const [slots, setSlots] = useState<ScheduleSlot[]>(existing?.slots ?? schoolSlots);
  const [initial] = useState(() => JSON.stringify({ mode, shift, slots }));
  const dirty = JSON.stringify({ mode, shift, slots }) !== initial;
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
  return <Modal open onClose={onClose} dirty={dirty} busy={pending} title={`Adjust ${formatDate(date, { weekday: 'long' })}`}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer />{existing && <Button variant="danger" disabled={pending} onClick={async () => { setMode('default'); setShift(0); setError(''); setPending(true); try { await save({ ...personal, dateOverrides: personal.dateOverrides.filter((entry) => entry.date !== date) }); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } }}>Remove adjustment</Button>}<Button variant="primary" busy={pending} onClick={() => void submit()}>Save</Button></>}>
    <div className="grid gap-1.5"><Label className="text-muted-foreground">This day for me</Label><Segmented label="Day mode" value={mode} onChange={setMode} options={modes} /></div>
    {mode === 'open' && schoolSlots.length === 0 && <Callout tone="info" icon="info">The school has no periods on this date. Choose “My own periods” to add some.</Callout>}
    {mode === 'custom' && <div className="grid gap-1.5"><Label className="text-muted-foreground">Periods on this day</Label><SlotsEditor slots={slots} periods={schedule.periods} onChange={setSlots} emptyText="Add the periods you have on this day." /></div>}
    {mode !== 'closed' && <div className="grid gap-2">
      <Field label="Shift all times" hint="Positive numbers move periods later." htmlFor="shift">
        <div className="flex flex-wrap items-center gap-2">
          <Input id="shift" small type="number" min={-720} max={720} step={5} value={shiftText} onChange={(event) => { const text = event.target.value; setShiftText(text); setShiftMinutes(committedShift(text, shift)); }} onBlur={() => setShiftText(String(shift))} className="max-w-[110px]" />
          <Hint>minutes</Hint>
          {[-60, -30, 30, 60, 120].map((preset) => <Button key={preset} size="sm" variant="ghost" onClick={() => setShift(preset)}>{preset > 0 ? '+' : ''}{preset}</Button>)}
          {shift !== 0 && <Button size="sm" variant="ghost" onClick={() => setShift(0)}>Reset</Button>}
        </div>
      </Field>
    </div>}
    <Panel className="grid gap-2">
      <div className="flex items-center justify-between"><strong className="text-sm font-bold">Preview</strong>{preview?.closed ? <Chip>No school</Chip> : preview ? <Chip tone="accent">{preview.cycleDayLabel}</Chip> : null}</div>
      {preview && !preview.closed && preview.periods.length === 0 && <Hint>No periods.</Hint>}
      {preview && preview.periods.length > 0 && <ul className="grid gap-1 text-sm">{preview.periods.map((period) => <li key={period.slotId} className="flex justify-between gap-3 rounded-lg bg-card px-3 py-1.5 ring-1 ring-foreground/[0.05]"><span className="font-medium">{period.class?.name ?? period.label}</span><span className="tabular-nums text-muted-foreground">{formatRange(period.start, period.end)}</span></li>)}</ul>}
      {preview && preview.issues.length > 0 && <Hint tone="danger">{describeDayIssues(preview.issues, true).join(' ')}</Hint>}
    </Panel>
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </Modal>;
}

export function CycleDayAdjustmentSheet({ open, onClose, cycleDayId, school, personal, save }: { open: boolean; onClose: () => void; cycleDayId: string | null; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  return open && cycleDayId ? <CycleDayBody key={cycleDayId} onClose={onClose} cycleDayId={cycleDayId} school={school} personal={personal} save={save} /> : null;
}

function CycleDayBody({ onClose, cycleDayId, school, personal, save }: { onClose: () => void; cycleDayId: string; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  const schedule = effectiveSchedule(school, personal);
  const day = schedule.cycleDays.find((entry) => entry.id === cycleDayId);
  const existing = personal.cycleDayOverrides.find((entry) => entry.cycleDayId === cycleDayId);
  const [enabled, setEnabled] = useState(Boolean(existing));
  const [slots, setSlots] = useState<ScheduleSlot[]>(existing?.slots ?? day?.slots ?? []);
  const [initial] = useState(() => JSON.stringify({ enabled, slots }));
  const dirty = JSON.stringify({ enabled, slots }) !== initial;
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
  return <Modal open onClose={onClose} dirty={dirty} busy={pending} title={`Adjust ${day?.label ?? 'rotation day'}`}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} onClick={() => void submit()}>Save</Button></>}>
    {!day && <Callout tone="warning" icon="alert">This rotation day no longer exists in the school schedule. You can remove your adjustment.</Callout>}
    <Toggle label={`Use my own periods on ${day?.label ?? 'this day'}`} checked={enabled} onChange={setEnabled} />
    {enabled && <SlotsEditor slots={slots} periods={schedule.periods} onChange={setSlots} />}
    {!enabled && day && <Panel><ul className="grid gap-1 text-sm">{day.slots.map((slot) => <li key={slot.id} className="flex justify-between gap-3"><span>{schedule.periods.find((period) => period.id === slot.periodId)?.label ?? slot.periodId}</span><span className="tabular-nums text-muted-foreground">{formatRange(slot.start, slot.end)}</span></li>)}{day.slots.length === 0 && <li className="text-xs text-muted-foreground">No periods.</li>}</ul></Panel>}
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </Modal>;
}

export function PrivateScheduleSheet({ open, onClose, school, personal, save }: { open: boolean; onClose: () => void; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  return open ? <PrivateScheduleBody onClose={onClose} school={school} personal={personal} save={save} /> : null;
}

function PrivateScheduleBody({ onClose, school, personal, save }: { onClose: () => void; school: Schedule; personal: PersonalSchedule; save: (personal: PersonalSchedule) => Promise<void> }) {
  const [draft, setDraft] = useState<Schedule>(() => structuredClone(effectiveSchedule(school, personal)));
  const [initial] = useState(() => JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== initial;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const issues = describeIssues(draft);
  const submit = async () => {
    setError(''); setPending(true);
    try { await save({ ...personal, customSchedule: scheduleSchema.parse(draft) }); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  // The in-place confirmation for going back to the school schedule (docs/CHAT.md §Dialogs: no native confirm()).
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setError(''); setPending(true);
    try { await save(useSchoolTimetable(school, personal)); onClose(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <Modal open onClose={onClose} dirty={dirty} busy={pending} wide fullWidth title={personal.customSchedule ? 'Edit my private schedule' : 'Build a private schedule'} description="A private schedule replaces the school schedule for you only. It starts as a copy of the school schedule."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer />{personal.customSchedule && <Button variant="danger" disabled={pending || stopping} onClick={() => setStopping(true)}>Use the school schedule instead</Button>}<Button variant="primary" busy={pending} disabled={issues.length > 0} onClick={() => void submit()}>Save private schedule</Button></>}>
    <ScheduleEditor value={draft} onChange={setDraft} personal={personal} disabled={pending} />
    {stopping && personal.customSchedule && <Callout tone="warning" icon="alert" role="alert" title="Go back to the school schedule?" actions={<>
      <Button size="sm" variant="danger" busy={pending} onClick={() => void stop()}>Use the school schedule</Button>
      <Button size="sm" autoFocus disabled={pending} onClick={() => setStopping(false)}>Keep my private schedule</Button>
    </>}>Your private timetable and date and rotation day adjustments will be cleared. Classes and assignments to school periods will stay saved.</Callout>}
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </Modal>;
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
      return <Panel key={entry.cycleDayId} className="flex items-center gap-3 px-3 py-2.5">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-xl bg-now-soft text-now-foreground"><Icon name="layers" size={16} /></span>
        <div className="min-w-0 flex-1"><strong className="text-sm font-bold">{day?.label ?? entry.cycleDayId}</strong><Hint>{day ? `Your own ${entry.slots.length} periods every ${day.label}` : 'This rotation day no longer exists'}</Hint></div>
        <Button size="sm" variant="ghost" onClick={() => onEditCycleDay(entry.cycleDayId)}>Edit</Button>
        <Button size="sm" variant="ghost" icon="x" aria-label={`Remove adjustment for ${day?.label ?? entry.cycleDayId}`} onClick={() => void run({ ...personal, cycleDayOverrides: personal.cycleDayOverrides.filter((item) => item.cycleDayId !== entry.cycleDayId) })} />
      </Panel>;
    })}
    {[...personal.dateOverrides].sort((left, right) => left.date.localeCompare(right.date)).map((entry) => <Panel key={entry.date} className="flex items-center gap-3 px-3 py-2.5">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-xl bg-now-soft text-now-foreground"><Icon name="calendar" size={16} /></span>
      <div className="min-w-0 flex-1"><strong className="text-sm font-bold">{formatDate(entry.date, { weekday: 'short', year: true })}</strong><Hint>{[entry.closed === true && 'No school for me', entry.closed === false && 'Open for me', entry.slots && `${entry.slots.length} custom periods`, entry.shiftMinutes && `times shifted ${entry.shiftMinutes > 0 ? '+' : ''}${entry.shiftMinutes} min`].filter(Boolean).join(' · ') || 'Adjusted'}</Hint></div>
      <Button size="sm" variant="ghost" onClick={() => onEditDate(entry.date)}>Edit</Button>
      <Button size="sm" variant="ghost" icon="x" aria-label={`Remove adjustment for ${entry.date}`} onClick={() => void run({ ...personal, dateOverrides: personal.dateOverrides.filter((item) => item.date !== entry.date) })} />
    </Panel>)}
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </div>;
}
