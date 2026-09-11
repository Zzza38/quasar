'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { resolveDay, scheduleSchema, type Schedule, type SchoolPeriod, type ScheduleSlot } from '@/domain/schedule';
import { addDays, formatDate, formatRange, randomId, slugId, timeZones, todayIn, weekOf } from '@/lib/format';
import { Icon } from './icon';
import { Button, Callout, Chip, Field, IconButton, Input, Segmented, Select, Toggle, WeekdayPicker } from './ui';

type CycleDay = Schedule['cycleDays'][number];
type Exception = Schedule['exceptions'][number];
type Section = 'basics' | 'periods' | 'days' | 'exceptions' | 'preview';

/* ---------- Validation messages ---------- */

export function describeIssues(schedule: Schedule): string[] {
  const parsed = scheduleSchema.safeParse(schedule);
  if (parsed.success) return [];
  const messages = parsed.error.issues.map((issue) => {
    const [root, index, ...rest] = issue.path as Array<string | number>;
    let prefix = '';
    if (root === 'periods' && typeof index === 'number') prefix = `${schedule.periods[index]?.label || `Period ${index + 1}`}: `;
    else if (root === 'periods') prefix = 'Periods: ';
    else if (root === 'cycleDays' && typeof index === 'number') {
      const day = schedule.cycleDays[index];
      prefix = `${day?.label || `Day ${index + 1}`}${rest[0] === 'slots' && typeof rest[1] === 'number' ? `, slot ${rest[1] + 1}` : ''}: `;
    } else if (root === 'cycleDays') prefix = 'Rotation days: ';
    else if (root === 'exceptions' && typeof index === 'number') prefix = `Exception on ${schedule.exceptions[index]?.date || `#${index + 1}`}: `;
    else if (root === 'anchorDate' || root === 'anchorCycleDayId') prefix = 'Starting point: ';
    else if (root === 'timeZone') prefix = 'Time zone: ';
    else if (root === 'schoolWeekdays') prefix = 'School days: ';
    else if (root === 'advanceWeekdays') prefix = 'Advance days: ';
    return `${prefix}${issue.message}`;
  });
  return [...new Set(messages)];
}

/* ---------- Slot list ---------- */

function nextSlot(slots: ScheduleSlot[], periods: SchoolPeriod[]): ScheduleSlot {
  const last = slots[slots.length - 1];
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const toTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const start = last ? Math.min(23 * 60, toMinutes(last.end) + 5) : 8 * 60;
  const end = Math.min(23 * 60 + 59, start + 50);
  const used = new Set(slots.map((slot) => slot.periodId));
  const period = periods.find((entry) => !used.has(entry.id)) ?? periods[0];
  return { id: randomId(), periodId: period?.id ?? '', start: toTime(start), end: toTime(end) };
}

export function SlotsEditor({ slots, periods, onChange, disabled, emptyText = 'No periods yet.' }: { slots: ScheduleSlot[]; periods: SchoolPeriod[]; onChange: (slots: ScheduleSlot[]) => void; disabled?: boolean; emptyText?: string }) {
  const update = (index: number, patch: Partial<ScheduleSlot>) => onChange(slots.map((slot, position) => position === index ? { ...slot, ...patch } : slot));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= slots.length) return;
    const next = [...slots];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return <div className="grid gap-2">
    {slots.length === 0 && <p className="hint">{emptyText}</p>}
    {slots.map((slot, index) => <div key={slot.id} className="slot-row">
      <Select small aria-label={`Slot ${index + 1} period`} value={slot.periodId} disabled={disabled} onChange={(event) => update(index, { periodId: event.target.value })}>
        {!periods.some((period) => period.id === slot.periodId) && <option value={slot.periodId}>{slot.periodId || 'Choose a period'}</option>}
        {periods.map((period) => <option key={period.id} value={period.id}>{period.label}{period.kind === 'lunch' ? ' (lunch)' : ''}</option>)}
      </Select>
      <div className="slot-times contents max-[480px]:grid">
        <Input small type="time" aria-label={`Slot ${index + 1} start`} value={slot.start} disabled={disabled} onChange={(event) => update(index, { start: event.target.value })} />
        <Input small type="time" aria-label={`Slot ${index + 1} end`} value={slot.end} disabled={disabled} onChange={(event) => update(index, { end: event.target.value })} />
      </div>
      <div className="flex items-center gap-0.5">
        <IconButton size="sm" label={`Move slot ${index + 1} up`} icon="arrowUp" disabled={disabled || index === 0} onClick={() => move(index, -1)} className="max-[480px]:hidden" />
        <IconButton size="sm" label={`Remove slot ${index + 1}`} icon="x" disabled={disabled} onClick={() => onChange(slots.filter((_, position) => position !== index))} />
      </div>
    </div>)}
    <div><Button size="sm" icon="plus" disabled={disabled || periods.length === 0} onClick={() => onChange([...slots, nextSlot(slots, periods)])}>Add period</Button></div>
  </div>;
}

/* ---------- Editor ---------- */

export function ScheduleEditor({ value, onChange, disabled, initialSection = 'basics' }: { value: Schedule; onChange: (value: Schedule) => void; disabled?: boolean; initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection);
  const issues = useMemo(() => describeIssues(value), [value]);
  const set = (patch: Partial<Schedule>) => onChange({ ...value, ...patch });
  return <div className="grid gap-4">
    <div className="overflow-x-auto -mx-1 px-1">
      <Segmented<Section> label="Schedule editor section" value={section} onChange={setSection} options={[
        { value: 'basics', label: 'Basics' }, { value: 'periods', label: `Periods · ${value.periods.length}` }, { value: 'days', label: `Days · ${value.cycleDays.length}` }, { value: 'exceptions', label: `Exceptions · ${value.exceptions.length}` }, { value: 'preview', label: 'Preview' },
      ]} />
    </div>
    {issues.length > 0 && <Callout tone="warning" icon="alert" title={`${issues.length === 1 ? 'One thing' : `${issues.length} things`} to fix before saving`} role="alert">
      <ul className="list-disc pl-4 grid gap-0.5 text-[13.5px]">{issues.slice(0, 8).map((issue) => <li key={issue}>{issue}</li>)}{issues.length > 8 && <li>…and {issues.length - 8} more</li>}</ul>
    </Callout>}
    {section === 'basics' && <Basics value={value} set={set} disabled={disabled} />}
    {section === 'periods' && <Periods value={value} set={set} disabled={disabled} />}
    {section === 'days' && <Days value={value} set={set} disabled={disabled} />}
    {section === 'exceptions' && <Exceptions value={value} set={set} disabled={disabled} />}
    {section === 'preview' && <Preview value={value} />}
  </div>;
}

function Basics({ value, set, disabled }: { value: Schedule; set: (patch: Partial<Schedule>) => void; disabled?: boolean }) {
  const zones = useMemo(timeZones, []);
  const sameAdvance = JSON.stringify(value.advanceWeekdays) === JSON.stringify(value.schoolWeekdays);
  const singleDay = value.cycleDays.length <= 1;
  return <div className="grid gap-5">
    <Field label="School time zone" hint="All bell times are interpreted in this zone." htmlFor="tz">
      <Select id="tz" value={value.timeZone} disabled={disabled} onChange={(event) => set({ timeZone: event.target.value })}>
        {!zones.includes(value.timeZone) && <option value={value.timeZone}>{value.timeZone}</option>}
        {zones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}
      </Select>
    </Field>
    <div className="grid gap-2">
      <span className="label">School days</span>
      <WeekdayPicker label="School days" value={value.schoolWeekdays} disabled={disabled} onChange={(schoolWeekdays) => set({ schoolWeekdays, ...(sameAdvance && !singleDay ? { advanceWeekdays: schoolWeekdays } : {}) })} />
      <span className="hint">Days with classes. Other days are closed unless an exception adds a special schedule.</span>
    </div>
    {!singleDay && <div className="grid gap-2">
      <span className="label">Rotation advances after these days</span>
      <Toggle label="Same as school days" checked={sameAdvance} disabled={disabled} onChange={(checked) => set({ advanceWeekdays: checked ? value.schoolWeekdays : value.advanceWeekdays.filter((day) => value.schoolWeekdays.includes(day)) })} />
      {!sameAdvance && <WeekdayPicker label="Advance days" value={value.advanceWeekdays} disabled={disabled} onChange={(advanceWeekdays) => set({ advanceWeekdays })} />}
      <span className="hint">Most schools move to the next rotation day after every school day. Weekends and closures pause the cycle unless an exception says otherwise.</span>
    </div>}
    {!singleDay && <div className="panel p-4 grid gap-3">
      <div><strong className="text-sm">Starting point</strong><p className="hint">Pick any known date and which rotation day happened on it. Every other date is calculated from here.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" htmlFor="anchor-date"><Input id="anchor-date" type="date" value={value.anchorDate} disabled={disabled} min="1900-01-01" max="2199-12-31" onChange={(event) => { if (event.target.value) set({ anchorDate: event.target.value }); }} /></Field>
        <Field label="Rotation day on that date" htmlFor="anchor-day">
          <Select id="anchor-day" value={value.anchorCycleDayId} disabled={disabled} onChange={(event) => set({ anchorCycleDayId: event.target.value })}>
            {!value.cycleDays.some((day) => day.id === value.anchorCycleDayId) && <option value={value.anchorCycleDayId}>Choose a day</option>}
            {value.cycleDays.map((day) => <option key={day.id} value={day.id}>{day.label || day.id}</option>)}
          </Select>
        </Field>
      </div>
    </div>}
  </div>;
}

function Periods({ value, set, disabled }: { value: Schedule; set: (patch: Partial<Schedule>) => void; disabled?: boolean }) {
  const update = (index: number, patch: Partial<SchoolPeriod>) => set({ periods: value.periods.map((period, position) => position === index ? { ...period, ...patch } : period) });
  const usage = (id: string) => value.cycleDays.filter((day) => day.slots.some((slot) => slot.periodId === id)).length;
  const remove = (index: number) => {
    const id = value.periods[index].id;
    set({
      periods: value.periods.filter((_, position) => position !== index),
      cycleDays: value.cycleDays.map((day) => ({ ...day, slots: day.slots.filter((slot) => slot.periodId !== id) })),
      exceptions: value.exceptions.map((exception) => 'slots' in exception && exception.slots ? { ...exception, slots: exception.slots.filter((slot) => slot.periodId !== id) } : exception),
    });
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= value.periods.length) return;
    const next = [...value.periods];
    [next[index], next[target]] = [next[target], next[index]];
    set({ periods: next });
  };
  return <div className="grid gap-4">
    <p className="text-sm text-text-2">Periods are the stable names students assign classes to, such as <em>A</em>, <em>Period 3</em> or <em>Lunch</em>. Their times and order are set per rotation day.</p>
    <div className="grid gap-2">
      {value.periods.map((period, index) => <div key={period.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 items-center">
        <Input small aria-label={`Period ${index + 1} name`} placeholder="Period name" maxLength={120} value={period.label} disabled={disabled} onChange={(event) => update(index, { label: event.target.value })} />
        <Select small aria-label={`Period ${index + 1} type`} value={period.kind} disabled={disabled} className="w-[104px]" onChange={(event) => update(index, { kind: event.target.value as SchoolPeriod['kind'] })}>
          <option value="class">Class</option><option value="lunch">Lunch</option><option value="other">Other</option>
        </Select>
        <div className="flex items-center gap-0.5">
          <IconButton size="sm" label={`Move period ${index + 1} up`} icon="arrowUp" disabled={disabled || index === 0} onClick={() => move(index, -1)} />
          <IconButton size="sm" label={`Remove period ${period.label || index + 1}`} icon="trash" disabled={disabled} onClick={() => { if (usage(period.id) === 0 || confirm(`Remove ${period.label || 'this period'} from ${usage(period.id)} rotation day(s)?`)) remove(index); }} />
        </div>
      </div>)}
    </div>
    <div className="flex gap-2 flex-wrap">
      <Button size="sm" icon="plus" disabled={disabled} onClick={() => set({ periods: [...value.periods, { id: slugId(`period-${value.periods.length + 1}`, value.periods.map((period) => period.id)), label: `Period ${value.periods.length + 1}`, kind: 'class' }] })}>Add period</Button>
      {!value.periods.some((period) => period.kind === 'lunch') && <Button size="sm" icon="coffee" disabled={disabled} onClick={() => set({ periods: [...value.periods, { id: slugId('lunch', value.periods.map((period) => period.id)), label: 'Lunch', kind: 'lunch' }] })}>Add lunch</Button>}
    </div>
    <p className="hint">Schools with lunch waves can add several lunch periods, for example “Lunch 1” and “Lunch 2”, and place each one in the rotation days where it applies.</p>
  </div>;
}

function Days({ value, set, disabled }: { value: Schedule; set: (patch: Partial<Schedule>) => void; disabled?: boolean }) {
  const [open, setOpen] = useState<string | null>(value.cycleDays[0]?.id ?? null);
  const updateDay = (id: string, patch: Partial<CycleDay>) => set({ cycleDays: value.cycleDays.map((day) => day.id === id ? { ...day, ...patch } : day) });
  const addDay = () => {
    const id = slugId(`day-${value.cycleDays.length + 1}`, value.cycleDays.map((day) => day.id));
    const source = value.cycleDays[value.cycleDays.length - 1];
    const day: CycleDay = { id, label: `Day ${value.cycleDays.length + 1}`, slots: source ? source.slots.map((slot) => ({ ...slot, id: randomId() })) : [] };
    set({ cycleDays: [...value.cycleDays, day], ...(value.cycleDays.length === 0 ? { anchorCycleDayId: id } : {}) });
    setOpen(id);
  };
  const removeDay = (id: string) => {
    const remaining = value.cycleDays.filter((day) => day.id !== id);
    set({ cycleDays: remaining, anchorCycleDayId: value.anchorCycleDayId === id ? remaining[0]?.id ?? '' : value.anchorCycleDayId, exceptions: value.exceptions.filter((exception) => !(exception.kind === 'reset' && exception.cycleDayId === id)) });
  };
  const copyTimesToAll = (source: CycleDay) => set({
    cycleDays: value.cycleDays.map((day) => day.id === source.id ? day : ({
      ...day,
      slots: source.slots.map((slot, index) => ({ id: day.slots[index]?.id ?? randomId(), periodId: day.slots[index]?.periodId ?? slot.periodId, start: slot.start, end: slot.end })),
    })),
  });
  return <div className="grid gap-4">
    <p className="text-sm text-text-2">{value.cycleDays.length <= 1 ? 'This schedule uses one bell schedule for every school day. Add more days to build a rotation.' : `Each rotation day lists its periods in order with their times. The cycle repeats after ${value.cycleDays[value.cycleDays.length - 1]?.label || 'the last day'}.`}</p>
    <div className="grid gap-2">
      {value.cycleDays.map((day, index) => {
        const expanded = open === day.id;
        return <div key={day.id} className="card overflow-hidden" style={{ boxShadow: 'none' }}>
          <div className="flex items-center gap-2 p-3">
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${day.label || `day ${index + 1}`}`} onClick={() => setOpen(expanded ? null : day.id)}><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} /></button>
            <Input small aria-label={`Day ${index + 1} name`} value={day.label} maxLength={120} disabled={disabled} onChange={(event) => updateDay(day.id, { label: event.target.value })} className="max-w-[220px]" />
            <span className="hint whitespace-nowrap">{day.slots.length} periods{day.slots.length > 0 ? ` · ${formatRange(day.slots[0].start, day.slots[day.slots.length - 1].end)}` : ''}</span>
            <div className="ml-auto flex items-center gap-0.5">
              {value.cycleDays.length > 1 && <IconButton size="sm" label={`Copy ${day.label} times to all days`} icon="copy" disabled={disabled || day.slots.length === 0} onClick={() => { if (confirm(`Apply the times from ${day.label} to every other day, keeping each day's period order?`)) copyTimesToAll(day); }} />}
              <IconButton size="sm" label={`Remove ${day.label || `day ${index + 1}`}`} icon="trash" disabled={disabled || value.cycleDays.length <= 1} onClick={() => { if (confirm(`Remove ${day.label}? Dates will be recalculated across the remaining days.`)) removeDay(day.id); }} />
            </div>
          </div>
          {expanded && <div className="border-t border-border p-3 bg-surface-2/60">
            <SlotsEditor slots={day.slots} periods={value.periods} disabled={disabled} onChange={(slots) => updateDay(day.id, { slots })} emptyText="No periods on this day yet. Add the first one below." />
          </div>}
        </div>;
      })}
    </div>
    <div><Button size="sm" icon="plus" disabled={disabled || value.cycleDays.length >= 366} onClick={addDay}>Add rotation day</Button></div>
  </div>;
}

function summarizeException(exception: Exception, schedule: Schedule): string {
  if (exception.kind === 'closure') return `No school${exception.advanceCycle ? ' · rotation still advances' : ''}`;
  if (exception.kind === 'replacement') return `Special schedule · ${exception.slots.length} periods${exception.advanceCycle ? '' : ' · rotation pauses'}`;
  const day = schedule.cycleDays.find((entry) => entry.id === exception.cycleDayId);
  return `Restart on ${day?.label ?? exception.cycleDayId}${exception.closed ? ' · closed that day' : exception.slots ? ' · special periods' : ''}`;
}

function Exceptions({ value, set, disabled }: { value: Schedule; set: (patch: Partial<Schedule>) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const sorted = [...value.exceptions].sort((left, right) => left.date.localeCompare(right.date));
  const replace = (date: string, next: Exception | null) => set({ exceptions: next ? value.exceptions.map((entry) => entry.date === date ? next : entry) : value.exceptions.filter((entry) => entry.date !== date) });
  const add = () => {
    let date = todayIn(value.timeZone);
    while (value.exceptions.some((entry) => entry.date === date)) date = addDays(date, 1);
    set({ exceptions: [...value.exceptions, { date, kind: 'closure', advanceCycle: false }] });
    setEditing(date);
  };
  return <div className="grid gap-4">
    <p className="text-sm text-text-2">Holidays, early-release days, assemblies and term restarts. Each date can have one exception.</p>
    {sorted.length === 0 && <p className="hint">No exceptions yet.</p>}
    <div className="grid gap-2">
      {sorted.map((exception) => {
        const expanded = editing === exception.date;
        return <div key={exception.date} className="card" style={{ boxShadow: 'none' }}>
          <div className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <strong className="text-sm">{formatDate(exception.date, { weekday: 'short', year: true })}</strong>
              <div className="hint">{summarizeException(exception, value)}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(expanded ? null : exception.date)} aria-expanded={expanded}>{expanded ? 'Done' : 'Edit'}</Button>
            <IconButton size="sm" label={`Remove exception on ${exception.date}`} icon="trash" disabled={disabled} onClick={() => replace(exception.date, null)} />
          </div>
          {expanded && <div className="border-t border-border p-3 grid gap-3 bg-surface-2/60">
            <ExceptionForm exception={exception} schedule={value} disabled={disabled} onChange={(next) => replace(exception.date, next)} />
          </div>}
        </div>;
      })}
    </div>
    <div><Button size="sm" icon="plus" disabled={disabled} onClick={add}>Add exception</Button></div>
  </div>;
}

export function ExceptionForm({ exception, schedule, onChange, disabled }: { exception: Exception; schedule: Schedule; onChange: (next: Exception) => void; disabled?: boolean }) {
  const kinds: Array<{ value: Exception['kind']; label: string }> = [{ value: 'closure', label: 'No school' }, { value: 'replacement', label: 'Special schedule' }, { value: 'reset', label: 'Restart rotation' }];
  const change = (kind: Exception['kind']) => {
    if (kind === exception.kind) return;
    if (kind === 'closure') onChange({ date: exception.date, kind, advanceCycle: false });
    if (kind === 'replacement') onChange({ date: exception.date, kind, advanceCycle: true, slots: [] });
    if (kind === 'reset') onChange({ date: exception.date, kind, advanceCycle: true, cycleDayId: schedule.cycleDays[0]?.id ?? '' });
  };
  const normallyAdvances = schedule.advanceWeekdays.includes(new Date(`${exception.date}T12:00:00Z`).getUTCDay() === 0 ? 7 : new Date(`${exception.date}T12:00:00Z`).getUTCDay());
  return <>
    <div className="grid gap-3 sm:grid-cols-[180px_1fr] items-end">
      <Field label="Date" htmlFor={`exception-date-${exception.date}`}><Input id={`exception-date-${exception.date}`} small type="date" value={exception.date} disabled={disabled} min="1900-01-01" max="2199-12-31" onChange={(event) => { if (event.target.value && !schedule.exceptions.some((entry) => entry.date === event.target.value)) onChange({ ...exception, date: event.target.value }); }} /></Field>
      <Segmented label="Exception type" value={exception.kind} onChange={change} options={kinds} />
    </div>
    {exception.kind === 'reset' && <Field label="Rotation day on this date" htmlFor={`reset-${exception.date}`}>
      <Select id={`reset-${exception.date}`} small value={exception.cycleDayId} disabled={disabled} onChange={(event) => onChange({ ...exception, cycleDayId: event.target.value })}>
        {schedule.cycleDays.map((day) => <option key={day.id} value={day.id}>{day.label}</option>)}
      </Select>
    </Field>}
    {exception.kind === 'reset' && <Toggle label="School is closed on this date" checked={exception.closed === true} disabled={disabled} onChange={(closed) => onChange(closed ? { date: exception.date, kind: 'reset', cycleDayId: exception.cycleDayId, advanceCycle: exception.advanceCycle, closed: true } : { date: exception.date, kind: 'reset', cycleDayId: exception.cycleDayId, advanceCycle: exception.advanceCycle })} />}
    {exception.kind === 'reset' && !exception.closed && <Toggle label="Use special periods on this date" checked={exception.slots !== undefined} disabled={disabled} onChange={(special) => onChange(special ? { ...exception, slots: [] } : { date: exception.date, kind: 'reset', cycleDayId: exception.cycleDayId, advanceCycle: exception.advanceCycle })} />}
    {(exception.kind === 'replacement' || (exception.kind === 'reset' && exception.slots !== undefined)) && <div className="grid gap-1.5"><span className="label">Periods on this date</span><SlotsEditor slots={exception.slots ?? []} periods={schedule.periods} disabled={disabled} onChange={(slots) => onChange({ ...exception, slots })} /></div>}
    {schedule.cycleDays.length > 1 && <Toggle label={exception.kind === 'closure' ? 'The rotation still advances past this date' : 'This date counts as a rotation day'} checked={exception.advanceCycle} disabled={disabled} onChange={(advanceCycle) => onChange({ ...exception, advanceCycle })} />}
    {schedule.cycleDays.length > 1 && exception.advanceCycle !== normallyAdvances && <p className="hint">This differs from a normal {normallyAdvances ? 'advancing' : 'non-advancing'} weekday, so the following dates shift by one rotation day.</p>}
  </>;
}

/* ---------- Preview ---------- */

export function Preview({ value }: { value: Schedule }) {
  const parsed = useMemo(() => scheduleSchema.safeParse(value), [value]);
  const today = useMemo(() => todayIn(value.timeZone), [value.timeZone]);
  const [date, setDate] = useState(today);
  const [weekStart, setWeekStart] = useState(() => weekOf(today)[0]);
  if (!parsed.success) return <Callout tone="neutral" icon="info">Fix the issues above to preview this schedule.</Callout>;
  const schedule = parsed.data;
  const days = Array.from({ length: 14 }, (_, index) => addDays(weekStart, index)).map((entry) => ({ date: entry, day: resolveDay(schedule, entry) }));
  const selected = resolveDay(schedule, date);
  return <div className="grid gap-4">
    <div className="flex items-center justify-between gap-2">
      <IconButton label="Previous two weeks" icon="chevronLeft" onClick={() => setWeekStart(addDays(weekStart, -14))} />
      <strong className="text-sm">{formatDate(weekStart)} – {formatDate(addDays(weekStart, 13), { year: true })}</strong>
      <IconButton label="Next two weeks" icon="chevronRight" onClick={() => setWeekStart(addDays(weekStart, 14))} />
    </div>
    <div className="grid gap-1">
      {[0, 7].map((offset) => <div key={offset} className="week-strip">
        {days.slice(offset, offset + 7).map(({ date: entry, day }) => <button key={entry} type="button" className={`week-day${entry === today ? ' today' : ''}${day.closed ? ' closed' : ''}`} aria-pressed={entry === date} onClick={() => setDate(entry)} aria-label={`${formatDate(entry, { weekday: 'long' })}: ${day.closed ? 'closed' : day.cycleDayLabel}`}>
          <span>{formatDate(entry, { weekday: 'short' }).slice(0, 3)}</span><strong>{Number(entry.slice(8))}</strong><small>{day.closed ? '—' : schedule.cycleDays.length > 1 ? day.cycleDayLabel : `${day.periods.length}p`}</small>
        </button>)}
      </div>)}
    </div>
    <div className="panel p-4 grid gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <strong>{formatDate(date, { weekday: 'long', year: true })}</strong>
        {selected.closed ? <Chip>No school</Chip> : <Chip tone="accent">{selected.cycleDayLabel}</Chip>}
      </div>
      {!selected.closed && selected.periods.length === 0 && <p className="hint">No periods on this day.</p>}
      {selected.periods.length > 0 && <ul className="grid gap-1 text-sm">
        {selected.periods.map((period) => <li key={period.slotId} className="flex justify-between gap-3"><span>{period.label}{period.kind === 'lunch' ? ' · lunch' : ''}</span><span className="tabular text-text-2">{formatRange(period.start, period.end)}</span></li>)}
      </ul>}
      {selected.issues.length > 0 && <p className="hint" style={{ color: 'var(--danger-text)' }}>{selected.issues.length} period(s) could not be placed on this date.</p>}
    </div>
  </div>;
}

/* ---------- Read-only summary ---------- */

export function ScheduleSummary({ schedule }: { schedule: Schedule }): ReactNode {
  const classes = schedule.periods.filter((period) => period.kind === 'class').length;
  const lunches = schedule.periods.filter((period) => period.kind === 'lunch').length;
  return <div className="flex flex-wrap gap-1.5">
    <Chip icon="layers">{schedule.cycleDays.length === 1 ? 'Same every day' : `${schedule.cycleDays.length}-day rotation`}</Chip>
    <Chip icon="book">{classes} class periods</Chip>
    {lunches > 0 && <Chip icon="coffee">{lunches === 1 ? 'Lunch' : `${lunches} lunch waves`}</Chip>}
    {schedule.exceptions.length > 0 && <Chip icon="calendar">{schedule.exceptions.length} exceptions</Chip>}
    <Chip icon="clock">{schedule.timeZone.replaceAll('_', ' ')}</Chip>
  </div>;
}
