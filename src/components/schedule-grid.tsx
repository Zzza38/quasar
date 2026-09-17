'use client';

import { useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import type { Schedule, ScheduleSlot, PersonalSchedule } from '@/domain/schedule';
import { classColor, formatRange, formatTime, randomId } from '@/lib/format';
import { Button, IconButton, Input } from './ui';
import { clockTime, minutes, placeTimedPeriod, type PeriodPlacement } from './schedule-placement';

const dragType = 'application/x-quasar-period';
const scale = 1.3;
const snap = (value: number) => Math.round(value / 5) * 5;
type Resize = { dayId: string; slot: ScheduleSlot; edge: 'start' | 'end'; y: number; start: number; end: number };

export function ScheduleGrid({ value, onChange, disabled, personal, personalClassesOnly, onEditDay, onRemoveDay }: {
  personalClassesOnly?: boolean; personal?: PersonalSchedule; value: Schedule; onChange: (value: Schedule) => void; disabled?: boolean;
  onEditDay: (id: string) => void; onRemoveDay: (id: string) => void;
}) {
  const [selected, setSelected] = useState<PeriodPlacement | null>(null);
  const [message, setMessage] = useState('');
  const [hover, setHover] = useState<{ dayId: string; start: number; end: number } | null>(null);
  const [resizing, setResizing] = useState<Resize | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const slots = value.cycleDays.flatMap(day => day.slots);
  const startMinute = Math.floor(Math.min(8 * 60, ...slots.filter(slot => slot.start).map(slot => minutes(slot.start))) / 60) * 60;
  const endMinute = Math.min(1439, Math.ceil(Math.max(16 * 60, ...slots.filter(slot => slot.end).map(slot => minutes(slot.end))) / 60) * 60);
  const height = (endMinute - startMinute) * scale;
  const weekLength = Math.max(1, value.schoolWeekdays.length);
  const weeks = Array.from({ length: Math.ceil(value.cycleDays.length / weekLength) }, (_, index) => value.cycleDays.slice(index * weekLength, (index + 1) * weekLength));
  const clsFor = (id: string) => personal?.classes.find(cls => cls.id === personal.assignments[id]);
  const commit = (source: PeriodPlacement, dayId: string, start: number, end: number) => {
    if (disabled) return;
    const next = placeTimedPeriod(value, source, dayId, { start: clockTime(start), end: clockTime(end) }, randomId());
    if (typeof next === 'string') { setMessage(next); return; }
    onChange(next); setSelected(null); setMessage(`Saved ${formatRange(clockTime(start), clockTime(end))} in this draft.`);
  };
  const sourceDuration = (source: PeriodPlacement | null) => {
    const slot = value.cycleDays.find(day => day.id === source?.dayId)?.slots.find(slot => slot.id === source?.slotId);
    return slot ? minutes(slot.end) - minutes(slot.start) : 45;
  };
  const timeAt = (y: number, top: number, duration: number) => Math.max(startMinute, Math.min(endMinute - duration, snap(startMinute + (y - top) / scale)));
  const beginDrag = (event: DragEvent, source: PeriodPlacement) => {
    event.dataTransfer.setData(dragType, JSON.stringify(source));
    event.dataTransfer.effectAllowed = source.dayId ? 'move' : 'copy';
    setSelected(source);
  };
  const beginResize = (event: PointerEvent<HTMLButtonElement>, dayId: string, slot: ScheduleSlot, edge: 'start' | 'end') => {
    if (disabled) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const state = { dayId, slot, edge, y: event.clientY, start: minutes(slot.start), end: minutes(slot.end) };
    resizeRef.current = state; setResizing(state);
  };
  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
    const current = resizeRef.current;
    if (!current) return;
    const delta = snap((event.clientY - current.y) / scale);
    const start = current.edge === 'start' ? Math.max(startMinute, Math.min(minutes(current.slot.end) - 5, minutes(current.slot.start) + delta)) : current.start;
    const end = current.edge === 'end' ? Math.min(endMinute, Math.max(minutes(current.slot.start) + 5, minutes(current.slot.end) + delta)) : current.end;
    resizeRef.current = { ...current, start, end }; setResizing(resizeRef.current);
  };
  return <div className="timetable-workspace">
    <aside className="timetable-palette panel p-3 grid gap-2">
      <strong className="text-sm">Classes & periods</strong>
      <p className="hint">Drop at a start time. Drag a block to move it. Drag its top or bottom edge to resize in 5-minute steps.</p>
      <div className="timetable-palette-items" aria-label="Available periods">
        {value.periods.filter(period => !personalClassesOnly || period.kind !== 'class' || clsFor(period.id)).filter((period, index, all) => !personalClassesOnly || !clsFor(period.id) || all.findIndex(entry => clsFor(entry.id)?.id === clsFor(period.id)?.id) === index).map(period => {
          const cls = clsFor(period.id);
          const label = cls ? (personalClassesOnly ? cls.name : `${cls.name} · ${period.label}`) : period.label;
          const color = classColor(cls?.id ?? period.id, period.kind, cls?.color);
          return <button key={period.id} type="button" className="btn btn-sm" draggable={!disabled} disabled={disabled} aria-label={`Place ${label}`} aria-pressed={selected?.periodId === period.id && !selected.dayId}
            style={{ borderColor: color.dot, background: color.soft }} onDragStart={event => beginDrag(event, { periodId: period.id })} onDragEnd={() => setHover(null)} onClick={() => { setSelected({ periodId: period.id }); setMessage(`${label} selected. Tap a time in a day column.`); }}>{label}</button>;
        })}
        {selected && <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setHover(null); }}>Cancel selection</Button>}
      </div>
    </aside>
    <div className="timetable-content">
      <p role="status" className="hint">{message || 'No fixed period rows. Blocks use their actual start and end times. Select a class and tap a time, or drag it into a day.'}</p>
      {weeks.map((days, weekIndex) => <section key={days[0].id} className="grid gap-2 min-w-0" aria-label={`Rotation week ${weekIndex + 1}`}>
        <h3 className="text-sm font-semibold">Week {weekIndex + 1}</h3>
        <div className="time-canvas-scroll">
          <div className="time-canvas" style={{ '--days': days.length } as CSSProperties}>
            <div className="time-canvas-heading hint">Time</div>
            {days.map((day, index) => <div key={day.id} className="time-canvas-heading">
              <Input small aria-label={`Day ${weekIndex * weekLength + index + 1} name`} value={day.label} maxLength={120} disabled={disabled} onChange={event => onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === day.id ? { ...entry, label: event.target.value } : entry) })} />
              <div className="flex items-center justify-between"><Button size="sm" variant="ghost" onClick={() => onEditDay(day.id)}>Edit times<span className="sr-only"> for {day.label}</span></Button><IconButton size="sm" icon="trash" label={`Remove ${day.label}`} disabled={disabled || value.cycleDays.length <= 1} onClick={() => onRemoveDay(day.id)} /></div>
            </div>)}
            <div className="time-axis" style={{ height }}>{Array.from({ length: Math.ceil((endMinute - startMinute) / 60) }, (_, index) => <span key={index} style={{ top: index * 60 * scale }}>{formatTime(clockTime(startMinute + index * 60))}</span>)}</div>
            {days.map(day => <div key={day.id} className="time-day" role="group" aria-label={`${day.label} time canvas`} style={{ height, backgroundSize: `100% ${30 * scale}px` }}
              onDragOver={event => { if (disabled || !event.dataTransfer.types.includes(dragType)) return; event.preventDefault(); const duration = sourceDuration(selected); const start = timeAt(event.clientY, event.currentTarget.getBoundingClientRect().top, duration); setHover({ dayId: day.id, start, end: start + duration }); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setHover(null); }}
              onDrop={event => { event.preventDefault(); setHover(null); if (disabled) return; try { const source = JSON.parse(event.dataTransfer.getData(dragType)); if (typeof source?.periodId !== 'string') return; const duration = sourceDuration(source); const start = timeAt(event.clientY, event.currentTarget.getBoundingClientRect().top, duration); commit(source, day.id, start, start + duration); } catch { /* Ignore unrelated drags. */ } }}>
              <div className="time-targets">{Array.from({ length: Math.ceil((endMinute - startMinute) / 15) }, (_, index) => {
                const start = startMinute + index * 15;
                return <button key={start} type="button" disabled={disabled || !selected} aria-label={`Place in ${day.label} at ${formatTime(clockTime(start))}`} style={{ height: 15 * scale }} onClick={() => { if (selected) commit(selected, day.id, start, Math.min(endMinute, start + sourceDuration(selected))); }} />;
              })}</div>
              {day.slots.filter(slot => slot.start && slot.end).map(slot => {
                const period = value.periods.find(entry => entry.id === slot.periodId);
                const cls = clsFor(slot.periodId);
                const color = classColor(cls?.id ?? period?.id, period?.kind, cls?.color);
                const active = resizing?.dayId === day.id && resizing.slot.id === slot.id ? resizing : null;
                const start = active?.start ?? minutes(slot.start); const end = active?.end ?? minutes(slot.end);
                return <div key={slot.id} className="time-block" style={{ top: (start - startMinute) * scale, height: Math.max(6, (end - start) * scale), borderColor: color.dot, background: `color-mix(in srgb, ${color.dot} 22%, var(--surface))` }}>
                  <button type="button" className="time-block-body" draggable={!disabled} disabled={disabled} aria-label={`${day.label}, ${formatRange(slot.start, slot.end)}: ${cls?.name ?? period?.label ?? slot.periodId}`}
                    onDragStart={event => beginDrag(event, { periodId: slot.periodId, dayId: day.id, slotId: slot.id })} onDragEnd={() => setHover(null)} onClick={() => { setSelected({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }); setMessage('Select another time to move this block.'); }}>
                    <strong>{cls?.name ?? period?.label ?? slot.periodId}</strong><span>{formatRange(clockTime(start), clockTime(end))}</span>
                  </button>
                  <button type="button" className="time-block-clear" aria-label={`Clear ${day.label} ${formatRange(slot.start, slot.end)}`} disabled={disabled} onClick={() => onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: entry.slots.filter(item => item.id !== slot.id) } : entry) })}>×</button>
                  {(['start', 'end'] as const).map(edge => <button key={edge} type="button" className={`time-resize time-resize-${edge}`} disabled={disabled} aria-label={`Resize ${day.label} ${period?.label ?? slot.periodId} ${edge}`} title={`Drag to change ${edge}; arrow keys adjust by 5 minutes`}
                    onPointerDown={event => beginResize(event, day.id, slot, edge)} onPointerMove={moveResize}
                    onPointerUp={event => { const current = resizeRef.current; if (!current) return; event.stopPropagation(); commit({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }, day.id, current.start, current.end); resizeRef.current = null; setResizing(null); }}
                    onPointerCancel={() => { resizeRef.current = null; setResizing(null); }} onClick={event => event.stopPropagation()}
                    onKeyDown={event => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const delta = event.key === 'ArrowUp' ? -5 : 5; commit({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }, day.id, minutes(slot.start) + (edge === 'start' ? delta : 0), minutes(slot.end) + (edge === 'end' ? delta : 0)); }} />)}
                </div>;
              })}
              {hover?.dayId === day.id && <div className="time-drop-preview" style={{ top: (hover.start - startMinute) * scale, height: (hover.end - hover.start) * scale }}>{formatRange(clockTime(hover.start), clockTime(hover.end))}</div>}
            </div>)}
          </div>
        </div>
      </section>)}
    </div>
  </div>;
}
