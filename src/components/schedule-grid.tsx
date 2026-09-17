'use client';

import { useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { buildTimeAxis } from './time-axis';
import { scheduledPeriodIds } from '@/domain/period-status';
import type { Schedule, ScheduleSlot, PersonalSchedule } from '@/domain/schedule';
import { classColor, formatRange, formatTime, randomId } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button, IconButton, Input } from './primitives';
import { Button as ShadButton } from './ui/button';
import { clockTime, minutes, placeTimedPeriod, type PeriodPlacement } from './schedule-placement';

const dragType = 'application/x-quasar-period';
const snap = (value: number) => Math.round(value / 5) * 5;
type Resize = { dayId: string; slot: ScheduleSlot; edge: 'start' | 'end'; y: number; start: number; end: number };

export function ScheduleGrid({ value, onChange, disabled, personal, personalClassesOnly, onAssign, onEditDay, onRemoveDay }: {
  onAssign?: (periodId: string, classId: string) => Promise<void>; personalClassesOnly?: boolean; personal?: PersonalSchedule; value: Schedule; onChange: (value: Schedule) => void; disabled?: boolean;
  onEditDay: (id: string) => void; onRemoveDay: (id: string) => void;
}) {
  const [selected, setSelected] = useState<PeriodPlacement | null>(null);
  const [message, setMessage] = useState('');
  const [hover, setHover] = useState<{ dayId: string; start: number; end: number } | null>(null);
  const [resizing, setResizing] = useState<Resize | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const slots = value.cycleDays.flatMap(day => day.slots);
  const scheduled = scheduledPeriodIds(value);
  const startMinute = Math.floor(Math.min(8 * 60, ...slots.filter(slot => slot.start).map(slot => minutes(slot.start))) / 60) * 60;
  const endMinute = Math.min(1439, Math.ceil(Math.max(16 * 60, ...slots.filter(slot => slot.end).map(slot => minutes(slot.end))) / 60) * 60);
  const axis = buildTimeAxis(startMinute, endMinute, slots.flatMap(slot => [minutes(slot.start), minutes(slot.end)]).filter(Number.isFinite));
  const height = axis.height;
  const weekLength = Math.max(1, value.schoolWeekdays.length);
  const weeks = Array.from({ length: Math.ceil(value.cycleDays.length / weekLength) }, (_, index) => value.cycleDays.slice(index * weekLength, (index + 1) * weekLength));
  const clsFor = (id: string) => personal?.classes.find(cls => cls.id === personal.assignments[id]);
  const commit = (source: PeriodPlacement, dayId: string, start: number, end: number) => {
    if (disabled) return;
    // Unassigned school blocks are guides, not conflicts with a personal adjustment.
    const editable = personalClassesOnly ? { ...value, cycleDays: value.cycleDays.map(day => day.id !== dayId ? day : { ...day, slots: day.slots.filter(slot => {
      const period = value.periods.find(entry => entry.id === slot.periodId);
      return slot.id === source.slotId && day.id === source.dayId || period?.kind !== 'class' || clsFor(slot.periodId) || minutes(slot.end) <= start || minutes(slot.start) >= end;
    }) }) } : value;
    const next = placeTimedPeriod(editable, source, dayId, { start: clockTime(start), end: clockTime(end) }, randomId());
    if (typeof next === 'string') { setMessage(next); return; }
    onChange(next); setSelected(null); setMessage(`Saved ${formatRange(clockTime(start), clockTime(end))} in this draft.`);
  };
  const sourceDuration = (source: PeriodPlacement | null) => {
    const slot = value.cycleDays.find(day => day.id === source?.dayId)?.slots.find(slot => slot.id === source?.slotId);
    return slot ? minutes(slot.end) - minutes(slot.start) : 45;
  };
  const targetAt = (dayId: string, start: number, source: PeriodPlacement | null) => personalClassesOnly && source && clsFor(source.periodId)
    ? value.cycleDays.find(day => day.id === dayId)?.slots.find(slot => minutes(slot.start) <= start && start < minutes(slot.end) && value.periods.find(period => period.id === slot.periodId)?.kind === 'class' && (!source.dayId || (!clsFor(slot.periodId) && (source.dayId !== dayId || source.slotId !== slot.id)))) : undefined;
  const placeAt = (source: PeriodPlacement, dayId: string, start: number) => {
    const target = targetAt(dayId, start, source);
    const cls = clsFor(source.periodId);
    if (target && source.dayId) { commit(source, dayId, minutes(target.start), minutes(target.end)); return; }
    if (target && cls && onAssign) { void onAssign(target.periodId, cls.id); setSelected(null); setHover(null); return; }
    commit(source, dayId, start, Math.min(endMinute, start + sourceDuration(source)));
  };
  const timeAt = (y: number, top: number, duration: number) => Math.max(startMinute, Math.min(endMinute - duration, snap(axis.time(y - top))));
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
    const originalTime = minutes(current.slot[current.edge]);
    const delta = snap(axis.time(axis.y(originalTime) + event.clientY - current.y)) - originalTime;
    const start = current.edge === 'start' ? Math.max(startMinute, Math.min(minutes(current.slot.end) - 5, minutes(current.slot.start) + delta)) : current.start;
    const end = current.edge === 'end' ? Math.min(endMinute, Math.max(minutes(current.slot.start) + 5, minutes(current.slot.end) + delta)) : current.end;
    resizeRef.current = { ...current, start, end }; setResizing(resizeRef.current);
  };
  return <div className="timetable-workspace">
    <aside className="timetable-palette grid gap-2 rounded-lg bg-muted p-3">
      <strong className="text-sm">Classes & periods</strong>
      <div className="timetable-palette-items" aria-label="Available periods">
        {value.periods.filter(period => !personalClassesOnly || period.kind !== 'class' || clsFor(period.id)).filter((period, index, all) => !personalClassesOnly || !clsFor(period.id) || all.findIndex(entry => clsFor(entry.id)?.id === clsFor(period.id)?.id) === index).map(period => {
          const cls = clsFor(period.id);
          const label = cls ? (personalClassesOnly ? cls.name : `${cls.name} · ${period.label}`) : period.label;
          const color = classColor(cls?.id ?? period.id, period.kind, cls?.color);
          const isScheduled = personalClassesOnly && cls ? value.periods.some(entry => personal?.assignments[entry.id] === cls.id && scheduled.has(entry.id)) : scheduled.has(period.id);
          const active = selected?.periodId === period.id && !selected.dayId;
          return <ShadButton key={period.id} type="button" variant="outline" size="sm" className={cn('cursor-grab text-foreground shadow-none', active && 'ring-2 ring-ring/60')} draggable={!disabled} disabled={disabled} aria-label={`Place ${label}`} aria-pressed={active}
            style={{ borderColor: color.dot, background: color.soft }} onDragStart={event => beginDrag(event, { periodId: period.id })} onDragEnd={() => setHover(null)} onClick={() => { setSelected({ periodId: period.id }); setMessage(`${label} selected. Tap a time in a day column.`); }}><span>{label}{!isScheduled && <span className="block text-xs font-normal opacity-75">Unscheduled</span>}</span></ShadButton>;
        })}
        {selected && <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setHover(null); }}>Cancel selection</Button>}
      </div>
    </aside>
    <div className="timetable-content">
      <p role="status" className={message ? 'text-xs text-muted-foreground' : 'sr-only'}>{message}</p>
      {weeks.map((days, weekIndex) => <section key={days[0].id} className="grid gap-2 min-w-0" aria-label={`Rotation week ${weekIndex + 1}`}>
        <h3 className="text-sm font-semibold">Week {weekIndex + 1}</h3>
        <div className="time-canvas-scroll">
          <div className="time-canvas" style={{ '--days': days.length } as CSSProperties}>
            <div className="time-canvas-heading text-xs text-muted-foreground">Time</div>
            {days.map((day, index) => <div key={day.id} className="time-canvas-heading">
              <Input small aria-label={`Day ${weekIndex * weekLength + index + 1} name`} value={day.label} maxLength={120} disabled={disabled} onChange={event => onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === day.id ? { ...entry, label: event.target.value } : entry) })} />
              <div className="flex items-center justify-between"><Button size="sm" variant="ghost" onClick={() => onEditDay(day.id)}>Edit times<span className="sr-only"> for {day.label}</span></Button><IconButton size="sm" icon="trash" label={`Remove ${day.label}`} disabled={disabled || value.cycleDays.length <= 1} onClick={() => onRemoveDay(day.id)} /></div>
            </div>)}
            <div className="time-axis" style={{ height }}>{Array.from({ length: Math.ceil((endMinute - startMinute) / 60) }, (_, index) => <span key={index} style={{ top: axis.y(startMinute + index * 60) }}>{formatTime(clockTime(startMinute + index * 60))}</span>)}</div>
            {days.map(day => <div key={day.id} className="time-day" role="group" aria-label={`${day.label} time canvas`} style={{ height }}
              onDragOver={event => { if (disabled || !event.dataTransfer.types.includes(dragType)) return; event.preventDefault(); const duration = sourceDuration(selected); const start = timeAt(event.clientY, event.currentTarget.getBoundingClientRect().top, duration); const target = targetAt(day.id, start, selected); setHover({ dayId: day.id, start: target ? minutes(target.start) : start, end: target ? minutes(target.end) : start + duration }); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setHover(null); }}
              onDrop={event => { event.preventDefault(); setHover(null); if (disabled) return; try { const source = JSON.parse(event.dataTransfer.getData(dragType)); if (typeof source?.periodId !== 'string') return; const duration = sourceDuration(source); const start = timeAt(event.clientY, event.currentTarget.getBoundingClientRect().top, duration); placeAt(source, day.id, start); } catch { /* Ignore unrelated drags. */ } }}>
              <div className="time-targets">{Array.from({ length: Math.ceil((endMinute - startMinute) / 15) }, (_, index) => {
                const start = startMinute + index * 15;
                return <button key={start} type="button" disabled={disabled || !selected} aria-label={`Place in ${day.label} at ${formatTime(clockTime(start))}`} style={{ height: axis.y(Math.min(endMinute, start + 15)) - axis.y(start) }} onClick={() => { if (selected) placeAt(selected, day.id, start); }} />;
              })}</div>
              {day.slots.filter(slot => slot.start && slot.end).map(slot => {
                const period = value.periods.find(entry => entry.id === slot.periodId);
                const cls = clsFor(slot.periodId);
                const isGuide = personalClassesOnly && period?.kind === 'class' && !cls;
                const color = classColor(cls?.id ?? period?.id, period?.kind, cls?.color);
                const active = resizing?.dayId === day.id && resizing.slot.id === slot.id ? resizing : null;
                const start = active?.start ?? minutes(slot.start); const end = active?.end ?? minutes(slot.end);
                const compact = axis.y(end) - axis.y(start) < 48;
                return <div key={slot.id} className={`time-block${isGuide ? ' time-school-guide' : ''}${compact ? ' time-block-compact' : ''}`} style={{ top: axis.y(start), height: axis.y(end) - axis.y(start), borderColor: color.dot, background: isGuide ? 'var(--muted)' : `color-mix(in srgb, ${color.dot} 22%, var(--card))` }}>
                  <button type="button" title={`${cls?.name ?? period?.label ?? slot.periodId} · ${formatRange(clockTime(start), clockTime(end))}`} className="time-block-body" draggable={!disabled} disabled={disabled} aria-label={`${day.label}, ${formatRange(slot.start, slot.end)}: ${cls?.name ?? period?.label ?? slot.periodId}`}
                    onDragStart={event => beginDrag(event, { periodId: slot.periodId, dayId: day.id, slotId: slot.id })} onDragEnd={() => setHover(null)} onClick={() => { if (selected && onAssign) { placeAt(selected, day.id, minutes(slot.start)); return; } if (isGuide) { setMessage('Select a class first, then tap this school block.'); return; } setSelected({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }); setMessage('Select another time to move this block.'); }}>
                    <strong>{cls?.name ?? period?.label ?? slot.periodId}</strong>{isGuide && <span>School block · drop class here</span>}<span>{formatRange(clockTime(start), clockTime(end))}</span>
                  </button>
                  <div className="time-block-detail" aria-hidden="true"><strong>{cls?.name ?? period?.label ?? slot.periodId}</strong><span>{formatRange(clockTime(start), clockTime(end))}</span></div>
                  <button type="button" className="time-block-clear" aria-label={`Clear ${day.label} ${formatRange(slot.start, slot.end)}`} disabled={disabled} onClick={() => onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: entry.slots.filter(item => item.id !== slot.id) } : entry) })}>×</button>
                  {(['start', 'end'] as const).map(edge => <button key={edge} type="button" className={`time-resize time-resize-${edge}`} disabled={disabled} aria-label={`Resize ${day.label} ${period?.label ?? slot.periodId} ${edge}`} title={`Drag to change ${edge}; arrow keys adjust by 5 minutes`}
                    onPointerDown={event => beginResize(event, day.id, slot, edge)} onPointerMove={moveResize}
                    onPointerUp={event => { const current = resizeRef.current; if (!current) return; event.stopPropagation(); commit({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }, day.id, current.start, current.end); resizeRef.current = null; setResizing(null); }}
                    onPointerCancel={() => { resizeRef.current = null; setResizing(null); }} onClick={event => event.stopPropagation()}
                    onKeyDown={event => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const delta = event.key === 'ArrowUp' ? -5 : 5; commit({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }, day.id, minutes(slot.start) + (edge === 'start' ? delta : 0), minutes(slot.end) + (edge === 'end' ? delta : 0)); }} />)}
                </div>;
              })}
              {hover?.dayId === day.id && <div className="time-drop-preview" style={{ top: axis.y(hover.start), height: axis.y(hover.end) - axis.y(hover.start) }}>{formatRange(clockTime(hover.start), clockTime(hover.end))}</div>}
            </div>)}
          </div>
        </div>
      </section>)}
    </div>
  </div>;
}
