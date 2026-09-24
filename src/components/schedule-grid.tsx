'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { buildTimeAxis } from './time-axis';
import { scheduledPeriodIds } from '@/domain/period-status';
import { cycleDaySchema, type Schedule, type ScheduleSlot, type PersonalSchedule } from '@/domain/schedule';
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
  // The last cleared block, so a stray tap on × can be undone.
  const [cleared, setCleared] = useState<{ dayId: string; slot: ScheduleSlot; keyboard: boolean } | null>(null);
  // Roving tab stop per day column: one focusable time target instead of one per 15 minutes.
  const [targetFocus, setTargetFocus] = useState<Record<string, number>>({});
  const hintId = useId();
  const workspaceRef = useRef<HTMLDivElement>(null);
  // After a keyboard placement the focused target is disabled (nothing is selected), so focus moves to the placed block.
  const focusBlock = useRef<{ dayId: string; start: number; until: number } | null>(null);
  useEffect(() => {
    const want = focusBlock.current;
    if (!want) return;
    if (Date.now() > want.until) { focusBlock.current = null; return; }
    const block = workspaceRef.current?.querySelector<HTMLElement>(`[data-day="${CSS.escape(want.dayId)}"][data-start="${want.start}"]`);
    if (block) { focusBlock.current = null; block.focus(); }
  });
  const slots = value.cycleDays.flatMap(day => day.slots);
  const scheduled = scheduledPeriodIds(value);
  const startMinute = Math.floor(Math.min(8 * 60, ...slots.filter(slot => slot.start).map(slot => minutes(slot.start))) / 60) * 60;
  const endMinute = Math.min(1439, Math.ceil(Math.max(16 * 60, ...slots.filter(slot => slot.end).map(slot => minutes(slot.end))) / 60) * 60);
  const axis = buildTimeAxis(startMinute, endMinute, slots.flatMap(slot => [minutes(slot.start), minutes(slot.end)]).filter(Number.isFinite));
  const height = axis.height;
  const weekLength = Math.max(1, value.schoolWeekdays.length);
  const weeks = Array.from({ length: Math.ceil(value.cycleDays.length / weekLength) }, (_, index) => value.cycleDays.slice(index * weekLength, (index + 1) * weekLength));
  const clsFor = (id: string) => personal?.classes.find(cls => cls.id === personal.assignments[id]);
  const commit = (source: PeriodPlacement, dayId: string, start: number, end: number): boolean => {
    if (disabled) return false;
    // Unassigned school blocks are guides, not conflicts with a personal adjustment.
    const editable = personalClassesOnly ? { ...value, cycleDays: value.cycleDays.map(day => day.id !== dayId ? day : { ...day, slots: day.slots.filter(slot => {
      const period = value.periods.find(entry => entry.id === slot.periodId);
      return slot.id === source.slotId && day.id === source.dayId || period?.kind !== 'class' || clsFor(slot.periodId) || minutes(slot.end) <= start || minutes(slot.start) >= end;
    }) }) } : value;
    const next = placeTimedPeriod(editable, source, dayId, { start: clockTime(start), end: clockTime(end) }, randomId());
    if (typeof next === 'string') { setMessage(next); return false; }
    onChange(next); setSelected(null); setCleared(null); setMessage(`Saved ${formatRange(clockTime(start), clockTime(end))} in this draft.`);
    return true;
  };
  const sourceDuration = (source: PeriodPlacement | null) => {
    const slot = value.cycleDays.find(day => day.id === source?.dayId)?.slots.find(slot => slot.id === source?.slotId);
    return slot ? minutes(slot.end) - minutes(slot.start) : 45;
  };
  const targetAt = (dayId: string, start: number, source: PeriodPlacement | null) => personalClassesOnly && source && clsFor(source.periodId)
    ? value.cycleDays.find(day => day.id === dayId)?.slots.find(slot => minutes(slot.start) <= start && start < minutes(slot.end) && value.periods.find(period => period.id === slot.periodId)?.kind === 'class' && (!source.dayId || (!clsFor(slot.periodId) && (source.dayId !== dayId || source.slotId !== slot.id)))) : undefined;
  /** Returns the start minute of the placed block, or undefined when nothing was placed. */
  const placeAt = (source: PeriodPlacement, dayId: string, start: number): number | undefined => {
    const target = targetAt(dayId, start, source);
    const cls = clsFor(source.periodId);
    if (target && source.dayId) return commit(source, dayId, minutes(target.start), minutes(target.end)) ? minutes(target.start) : undefined;
    if (target && cls && onAssign) { void onAssign(target.periodId, cls.id); setSelected(null); setHover(null); setCleared(null); return minutes(target.start); }
    return commit(source, dayId, start, Math.min(endMinute, start + sourceDuration(source))) ? start : undefined;
  };
  /** Keyboard clicks report detail 0; pointer taps keep focus where it is, so the hover card does not pop open. */
  const followWithFocus = (detail: number, dayId: string, start: number | undefined) => {
    if (detail === 0 && start !== undefined) focusBlock.current = { dayId, start, until: Date.now() + 3000 };
  };
  const targetCount = Math.ceil((endMinute - startMinute) / 15);
  const defaultTarget = (dayId: string) => {
    const slot = selected?.dayId === dayId ? value.cycleDays.find(day => day.id === dayId)?.slots.find(entry => entry.id === selected.slotId) : undefined;
    return slot ? Math.max(0, Math.min(targetCount - 1, Math.floor((minutes(slot.start) - startMinute) / 15))) : 0;
  };
  const activeTarget: Record<string, number> = Object.fromEntries(value.cycleDays.map(day => [day.id, Math.min(targetCount - 1, targetFocus[day.id] ?? defaultTarget(day.id))]));
  const undoClear = () => {
    if (!cleared) return;
    const day = value.cycleDays.find(entry => entry.id === cleared.dayId);
    const restored = day && { ...day, slots: [...day.slots, cleared.slot].sort((a, b) => a.start.localeCompare(b.start)) };
    if (!restored || !value.periods.some(period => period.id === cleared.slot.periodId) || !cycleDaySchema.safeParse(restored).success) { setCleared(null); setMessage('That time is taken now, so the block was not restored.'); return; }
    onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === restored.id ? restored : entry) });
    setCleared(null); setMessage(`Restored ${formatRange(cleared.slot.start, cleared.slot.end)}.`);
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
  return <div ref={workspaceRef} className="timetable-workspace">
    <aside className="timetable-palette gap-2 rounded-2xl bg-muted/70 p-3 ring-1 ring-inset ring-foreground/[0.04]">
      <strong className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Classes & periods</strong>
      <div className="timetable-palette-items" aria-label="Available periods">
        {value.periods.filter(period => !personalClassesOnly || period.kind !== 'class' || clsFor(period.id)).filter((period, index, all) => !personalClassesOnly || !clsFor(period.id) || all.findIndex(entry => clsFor(entry.id)?.id === clsFor(period.id)?.id) === index).map(period => {
          const cls = clsFor(period.id);
          const label = cls ? (personalClassesOnly ? cls.name : `${cls.name} · ${period.label}`) : period.label;
          const color = classColor(cls?.id ?? period.id, period.kind, cls?.color);
          const isScheduled = personalClassesOnly && cls ? value.periods.some(entry => personal?.assignments[entry.id] === cls.id && scheduled.has(entry.id)) : scheduled.has(period.id);
          const active = selected?.periodId === period.id && !selected.dayId;
          return <ShadButton key={period.id} type="button" variant="outline" size="sm" className={cn('cursor-grab font-semibold text-foreground shadow-card active:cursor-grabbing', active && 'ring-2 ring-ring/60')} draggable={!disabled} disabled={disabled} aria-label={`Place ${label}`} aria-pressed={active}
            style={{ borderColor: 'transparent', borderLeftColor: color.dot, background: `color-mix(in srgb, ${color.dot} 14%, var(--card))` }} onDragStart={event => beginDrag(event, { periodId: period.id })} onDragEnd={() => setHover(null)} onClick={() => { setSelected({ periodId: period.id }); setMessage(`${label} selected. Tap a time in a day column.`); }}><span>{label}{!isScheduled && <span className="block text-xs font-normal opacity-75">{personalClassesOnly && cls ? 'Not placed yet' : 'No times set'}</span>}</span></ShadButton>;
        })}
        {selected && <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setHover(null); }}>Cancel selection</Button>}
      </div>
    </aside>
    <div className="timetable-content">
      <div className={message || cleared ? 'flex flex-wrap items-center gap-x-2' : 'contents'}>
        <p role="status" className={message ? 'text-xs text-muted-foreground' : 'sr-only'}>{message}</p>
        {/* Keyed per clear so a keyboard clear, which removes the focused ×, lands focus on Undo. */}
        {cleared && <Button key={cleared.slot.id} size="sm" variant="ghost" autoFocus={cleared.keyboard} disabled={disabled} onClick={undoClear}>Undo</Button>}
      </div>
      <span id={hintId} className="sr-only">Use the arrow keys to choose a time, then press Enter.</span>
      {weeks.map((days, weekIndex) => <section key={days[0].id} className="grid gap-2 min-w-0" aria-label={`Rotation week ${weekIndex + 1}`}>
        <h3 className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Week {weekIndex + 1}</h3>
        <div className="time-canvas-scroll">
          <div className="time-canvas" style={{ '--days': days.length } as CSSProperties}>
            <div className="time-canvas-heading text-xs text-muted-foreground">Time</div>
            {days.map((day, index) => <div key={day.id} className="time-canvas-heading">
              <DayNameInput name={`Day ${weekIndex * weekLength + index + 1} name`} label={day.label} disabled={disabled} onCommit={label => { setCleared(null); onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === day.id ? { ...entry, label } : entry) }); }} />
              <div className="flex items-center justify-between"><Button size="sm" variant="ghost" onClick={() => onEditDay(day.id)}>Edit times<span className="sr-only"> for {day.label}</span></Button><IconButton size="sm" icon="trash" label={`Remove ${day.label}`} disabled={disabled || value.cycleDays.length <= 1} onClick={() => onRemoveDay(day.id)} /></div>
            </div>)}
            <div className="time-axis" style={{ height }}>{Array.from({ length: Math.ceil((endMinute - startMinute) / 60) }, (_, index) => <span key={index} style={{ top: axis.y(startMinute + index * 60) }}>{formatTime(clockTime(startMinute + index * 60))}</span>)}</div>
            {days.map(day => <div key={day.id} className="time-day" role="group" aria-label={`${day.label} time canvas`} style={{ height }}
              onDragOver={event => { if (disabled || !event.dataTransfer.types.includes(dragType)) return; event.preventDefault(); const duration = sourceDuration(selected); const start = timeAt(event.clientY, event.currentTarget.getBoundingClientRect().top, duration); const target = targetAt(day.id, start, selected); setHover({ dayId: day.id, start: target ? minutes(target.start) : start, end: target ? minutes(target.end) : start + duration }); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setHover(null); }}
              onDrop={event => { event.preventDefault(); setHover(null); if (disabled) return; try { const source = JSON.parse(event.dataTransfer.getData(dragType)); if (typeof source?.periodId !== 'string') return; const duration = sourceDuration(source); const start = timeAt(event.clientY, event.currentTarget.getBoundingClientRect().top, duration); placeAt(source, day.id, start); } catch { /* Ignore unrelated drags. */ } }}>
              <div className="time-targets" role="group" aria-label={`${day.label} times`} aria-describedby={hintId}>{Array.from({ length: targetCount }, (_, index) => {
                const start = startMinute + index * 15;
                return <button key={start} type="button" disabled={disabled || !selected} tabIndex={index === activeTarget[day.id] ? 0 : -1} aria-label={`Place in ${day.label} at ${formatTime(clockTime(start))}`} style={{ height: axis.y(Math.min(endMinute, start + 15)) - axis.y(start) }}
                  onFocus={() => setTargetFocus(current => current[day.id] === index ? current : { ...current, [day.id]: index })}
                  onKeyDown={event => {
                    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? targetCount - 1 : null;
                    if (next === null) return;
                    event.preventDefault();
                    (event.currentTarget.parentElement?.children[Math.max(0, Math.min(targetCount - 1, next))] as HTMLElement | undefined)?.focus();
                  }}
                  onClick={event => { if (selected) followWithFocus(event.detail, day.id, placeAt(selected, day.id, start)); }} />;
              })}</div>
              {day.slots.filter(slot => slot.start && slot.end).map(slot => {
                const period = value.periods.find(entry => entry.id === slot.periodId);
                const cls = clsFor(slot.periodId);
                const isGuide = personalClassesOnly && period?.kind === 'class' && !cls;
                const color = classColor(cls?.id ?? period?.id, period?.kind, cls?.color);
                const active = resizing?.dayId === day.id && resizing.slot.id === slot.id ? resizing : null;
                const start = active?.start ?? minutes(slot.start); const end = active?.end ?? minutes(slot.end);
                const blockHeight = axis.y(end) - axis.y(start);
                const compact = blockHeight < 48;
                // Whole title lines that fit above the time label: 14px of padding, a 17px time row, 14.5px per line.
                const titleLines = Math.max(1, Math.min(4, Math.floor((blockHeight - 31) / 14.5)));
                return <div key={slot.id} className={`time-block${isGuide ? ' time-school-guide' : ''}${compact ? ' time-block-compact' : titleLines === 1 ? ' time-block-short' : ''}`} style={{ top: axis.y(start), height: blockHeight, '--title-lines': titleLines, borderColor: color.dot, background: isGuide ? 'var(--muted)' : `color-mix(in srgb, ${color.dot} 22%, var(--card))` } as CSSProperties}>
                  <button type="button" title={`${cls?.name ?? period?.label ?? slot.periodId} · ${formatRange(clockTime(start), clockTime(end))}`} className="time-block-body" data-day={day.id} data-start={minutes(slot.start)} draggable={!disabled} disabled={disabled} aria-label={`${day.label}, ${formatRange(slot.start, slot.end)}: ${cls?.name ?? period?.label ?? slot.periodId}`}
                    onDragStart={event => beginDrag(event, { periodId: slot.periodId, dayId: day.id, slotId: slot.id })} onDragEnd={() => setHover(null)} onClick={event => { if (selected && onAssign) { followWithFocus(event.detail, day.id, placeAt(selected, day.id, minutes(slot.start))); return; } if (isGuide) { setMessage('Select a class first, then tap this school block.'); return; } setSelected({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }); setMessage('Select another time to move this block.'); }}>
                    <strong>{cls?.name ?? period?.label ?? slot.periodId}</strong>{isGuide && <span>School block · drop class here</span>}
                    {/* The axis already says AM or PM; the full range stays in the tooltip, the hover card and the label. */}
                    <span>{formatRange(clockTime(start), clockTime(end)).replace(/\s?[AP]M/g, '')}</span>
                  </button>
                  <div className="time-block-detail" aria-hidden="true"><strong>{cls?.name ?? period?.label ?? slot.periodId}</strong><span>{formatRange(clockTime(start), clockTime(end))}</span></div>
                  <button type="button" className="time-block-clear" aria-label={`Clear ${day.label} ${formatRange(slot.start, slot.end)}`} disabled={disabled} onClick={event => { onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === day.id ? { ...entry, slots: entry.slots.filter(item => item.id !== slot.id) } : entry) }); if (selected?.slotId === slot.id) setSelected(null); setCleared({ dayId: day.id, slot, keyboard: event.detail === 0 }); setMessage(`Cleared ${cls?.name ?? period?.label ?? slot.periodId} from ${day.label}.`); }}>×</button>
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

/** Saves the day name on blur or Enter rather than per keystroke, so typing never races a save. */
function DayNameInput({ name, label, disabled, onCommit }: { name: string; label: string; disabled?: boolean; onCommit: (label: string) => void }) {
  const [text, setText] = useState(label);
  const [shown, setShown] = useState(label);
  if (shown !== label) { setShown(label); setText(label); }
  const commit = () => {
    if (!text.trim()) { setText(label); return; }
    if (text !== label) onCommit(text);
  };
  return <Input small aria-label={name} value={text} maxLength={120} disabled={disabled} enterKeyHint="done"
    onChange={event => setText(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />;
}
