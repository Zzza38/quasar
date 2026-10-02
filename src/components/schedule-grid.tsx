'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { buildTimeAxis } from './time-axis';
import { scheduledPeriodIds } from '@/domain/period-status';
import { cycleDaySchema, displayPeriodLabel, UNASSIGNED_BLOCK_LABEL, type Schedule, type ScheduleSlot, type PersonalSchedule } from '@/domain/schedule';
import { classColor, formatRange, formatTime, randomId } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button, IconButton, Input, Modal, Spacer } from './primitives';
import { Button as ShadButton } from './ui/button';
import { usePointerDrag, verticalScroller, type DragPoint } from './pointer-drag';
import { classFill, clockTime, minutes, placeTimedPeriod, PLACEMENT_BLOCKED, type PeriodPlacement } from './schedule-placement';

const snap = (value: number) => Math.round(value / 5) * 5;
type Resize = { dayId: string; slot: ScheduleSlot; edge: 'start' | 'end'; y: number; start: number; end: number };
/** A class or block being dragged. `grab` is how far below a block's top it was picked up, so the block does not jump to the pointer. */
type Carry = { source: PeriodPlacement; label: string; color: string; grab: number; touch?: boolean };
/**
 * What dropping or tapping at a spot would do. With `slotId` the class goes into that block (`changes` are the
 * assignments to save); otherwise the block lands on free time. `problem` says why nothing would happen.
 */
type Landing = { dayId: string; start: number; end: number; slotId?: string; changes?: Record<string, string | null>; label?: string; done?: string; problem?: string };

/** The part of the viewport between the app's top bar and tab bar, which cover the page's edges on phones and tablets. */
function pageBounds() {
  const bar = document.querySelector('.app-topbar')?.getBoundingClientRect();
  const dock = document.querySelector('nav.tabbar')?.getBoundingClientRect();
  return { top: bar?.height ? bar.bottom : 0, bottom: dock?.height ? dock.top : window.innerHeight };
}

export function ScheduleGrid({ value, onChange, disabled, personal, personalClassesOnly, onAssign, onEditDay, onRemoveDay }: {
  /** Sets the class of each listed period, or clears it with null, in one save. */
  onAssign?: (changes: Record<string, string | null>) => Promise<void>; personalClassesOnly?: boolean; personal?: PersonalSchedule; value: Schedule; disabled?: boolean;
  /**
   * Called once per edit. Returning false means the edit was not saved yet (the caller is asking the student
   * first, in place, and saves it itself once they agree), so the grid shows the timetable as it was: a renamed
   * day gets its old name back and no "Saved" or "Cleared" message appears.
   */
  onChange: (value: Schedule) => boolean | void;
  onEditDay: (id: string) => void; onRemoveDay: (id: string) => void;
}) {
  const [selected, setSelected] = useState<PeriodPlacement | null>(null);
  // `message` is the result of the last action. Selecting does not touch it: the selection has its own bar (`prompt`),
  // out of flow, so picking something up never shifts the timetable under the next tap.
  const [message, setMessage] = useState('');
  const [prompt, setPrompt] = useState('');
  // The result again, shown in that bar for a few seconds when the message row itself is scrolled out of view.
  const [flash, setFlash] = useState('');
  useEffect(() => { if (!flash) return; const timer = setTimeout(() => setFlash(''), 6000); return () => clearTimeout(timer); }, [flash]);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Landing | null>(null);
  const [carry, setCarry] = useState<Carry | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<DragPoint>({ x: 0, y: 0 });
  // A finger cannot hover: after a tap :hover sticks, so the detail card only follows a mouse or a pen.
  const [hoverCards, setHoverCards] = useState(true);
  const [resizing, setResizing] = useState<Resize | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  // The last cleared block, so a stray tap on × can be undone.
  const [cleared, setCleared] = useState<{ dayId: string; slot: ScheduleSlot; keyboard: boolean } | null>(null);
  // The assignments the last placement or class removal replaced, so it can be undone too. Undo is offered only
  // while the message that reported that change is the one showing.
  const [replaced, setReplaced] = useState<{ changes: Record<string, string | null>; message: string } | null>(null);
  const [removing, setRemoving] = useState<{ dayId: string; dayLabel: string; slot: ScheduleSlot; name: string; keyboard: boolean } | null>(null);
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
  const periodOf = (id: string) => value.periods.find(period => period.id === id);
  const slotOf = (source: PeriodPlacement | null) => value.cycleDays.find(day => day.id === source?.dayId)?.slots.find(slot => slot.id === source?.slotId);
  const isGuide = (slot: ScheduleSlot) => !!personalClassesOnly && periodOf(slot.periodId)?.kind === 'class' && !clsFor(slot.periodId);
  /** The timetable with `source` at a time, or why it cannot go there. No block is removed to make room. */
  const timed = (source: PeriodPlacement, dayId: string, start: number, end: number): Schedule | string => {
    const next = placeTimedPeriod(value, source, dayId, { start: clockTime(start), end: clockTime(end) }, randomId());
    if (next !== PLACEMENT_BLOCKED) return next;
    const empty = value.cycleDays.find(day => day.id === dayId)?.slots.some(slot => !(source.dayId === dayId && source.slotId === slot.id) && minutes(slot.start) < end && minutes(slot.end) > start && isGuide(slot));
    return empty ? 'That time overlaps an empty block. Put a class in that block, or remove the block with × first.' : next;
  };
  /** The part of the viewport where the timetable can be seen: inside its scroll area and clear of the app's bars. */
  const visibleBand = () => {
    const scroller = workspaceRef.current && verticalScroller(workspaceRef.current);
    if (!scroller || scroller === (document.scrollingElement ?? document.documentElement)) return pageBounds();
    const rect = scroller.getBoundingClientRect();
    return { top: rect.top + scroller.clientTop, bottom: rect.top + scroller.clientTop + scroller.clientHeight };
  };
  /** Reports the result of an action, and repeats it in the pinned bar when the message row is scrolled out of view. */
  const say = (text: string) => {
    setMessage(text);
    const row = contentRef.current?.getBoundingClientRect();
    setFlash(text && row && row.top < visibleBand().top - 8 ? text : '');
  };
  const commit = (source: PeriodPlacement, dayId: string, start: number, end: number): boolean => {
    if (disabled) return false;
    const next = timed(source, dayId, start, end);
    if (typeof next === 'string') { say(next); return false; }
    const saved = onChange(next) !== false;
    // The Classes page saves each change straight to the personal timetable; the school editors keep a draft until Save.
    setSelected(null); setCleared(null); setReplaced(null); say(saved ? `Saved ${formatRange(clockTime(start), clockTime(end))}${personalClassesOnly ? '' : ' in this draft'}.` : '');
    return saved;
  };
  const sourceDuration = (source: PeriodPlacement | null) => {
    const slot = slotOf(source);
    return slot ? minutes(slot.end) - minutes(slot.start) : 45;
  };
  /** How a result message names a block: its period, or its time for a block the student made. */
  const blockName = (slot: ScheduleSlot) => {
    const label = displayPeriodLabel(periodOf(slot.periodId), false);
    return label === UNASSIGNED_BLOCK_LABEL ? `the ${formatRange(slot.start, slot.end)} block` : label;
  };
  /** Where `source` would land: `at` is the minute it points at, `start` the start of a placement on free time. */
  const landing = (source: PeriodPlacement, dayId: string, at: number, start: number): Landing => {
    const end = Math.min(endMinute, start + sourceDuration(source));
    // Only the student's own timetable puts classes into blocks; a dangling assignment counts as no class.
    const held = onAssign && personal ? Object.fromEntries(Object.entries(personal.assignments).filter(([id]) => clsFor(id))) : undefined;
    const fill = held && classFill(value, held, source, dayId, at, start, end);
    if (!fill) { const next = timed(source, dayId, start, end); return typeof next === 'string' ? { dayId, start, end, label: `Not here · ${formatRange(clockTime(start), clockTime(end))}`, problem: next } : { dayId, start, end }; }
    const cls = clsFor(source.periodId)!; const other = clsFor(fill.slot.periodId);
    const spot = { dayId, start: minutes(fill.slot.start), end: minutes(fill.slot.end), slotId: fill.slot.id };
    if (!fill.changes) return { ...spot, label: 'Already here', problem: `${cls.name} is already in that block.` };
    if (!source.dayId) return { ...spot, changes: fill.changes, label: other ? `Replace ${other.name}` : undefined, done: other ? `${cls.name} replaced ${other.name} in ${blockName(fill.slot)}.` : `Placed ${cls.name} in ${blockName(fill.slot)}.` };
    return { ...spot, changes: fill.changes, label: other ? `Swap with ${other.name}` : undefined, done: other ? `Swapped ${cls.name} and ${other.name}.` : `Moved ${cls.name} to ${blockName(fill.slot)}. Its ${blocksOf(source.periodId) > 1 ? `${blocksOf(source.periodId)} old blocks stay` : 'old block stays'} empty.` };
  };
  /** Returns the start minute of the placed block, or undefined when nothing was placed. */
  const place = (source: PeriodPlacement, spot: Landing): number | undefined => {
    if (disabled) return undefined;
    if (!spot.slotId) return commit(source, spot.dayId, spot.start, spot.end) ? spot.start : undefined;
    if (!spot.changes || !onAssign) { say(spot.problem ?? ''); return undefined; }
    setReplaced({ changes: Object.fromEntries(Object.keys(spot.changes).map(id => [id, clsFor(id)?.id ?? null])), message: spot.done ?? '' });
    void onAssign(spot.changes);
    setSelected(null); setCleared(null); say(spot.done ?? '');
    return spot.start;
  };
  const placeAt = (source: PeriodPlacement, dayId: string, start: number) => place(source, landing(source, dayId, start, start));
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
    if (!restored || !value.periods.some(period => period.id === cleared.slot.periodId) || !cycleDaySchema.safeParse(restored).success) { setCleared(null); say('That time is taken now, so the block was not restored.'); return; }
    const saved = onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === restored.id ? restored : entry) }) !== false;
    setCleared(null); say(saved ? `Restored ${formatRange(cleared.slot.start, cleared.slot.end)}.` : '');
  };
  const clearBlock = () => {
    if (!removing || disabled) return;
    const { dayId, slot, name, keyboard } = removing;
    const next = { ...value, cycleDays: value.cycleDays.map(entry => entry.id === dayId ? { ...entry, slots: entry.slots.filter(item => item.id !== slot.id) } : entry) };
    if (onChange(next) === false) return;
    if (selected?.slotId === slot.id) setSelected(null);
    setCleared({ dayId, slot, keyboard }); setReplaced(null);
    say(`Cleared ${name} from ${value.cycleDays.find(day => day.id === dayId)?.label ?? 'the timetable'}.`);
    setRemoving(null);
  };
  /** How many blocks share a period: a class is assigned to the period, so it fills or leaves all of them. */
  const blocksOf = (periodId: string) => value.cycleDays.reduce((count, day) => count + day.slots.filter(slot => slot.periodId === periodId).length, 0);
  const clearClass = () => {
    const cls = removing && clsFor(removing.slot.periodId);
    if (!removing || !cls || disabled || !onAssign) return;
    const blocks = blocksOf(removing.slot.periodId);
    void onAssign({ [removing.slot.periodId]: null });
    setSelected(null);
    setCleared(null);
    const done = blocks > 1 ? `Removed ${removing.name} from its ${blocks} blocks. The time blocks remain.` : `Removed ${removing.name} from ${removing.dayLabel}. The time block remains.`;
    setReplaced({ changes: { [removing.slot.periodId]: cls.id }, message: done });
    say(done);
    setRemoving(null);
  };
  const undoAssign = () => {
    if (!replaced || !onAssign || disabled) return;
    // A class or period removed since then is left as it is now.
    const changes = Object.fromEntries(Object.entries(replaced.changes).filter(([periodId, classId]) => periodOf(periodId) && (classId === null || personal?.classes.some(cls => cls.id === classId))));
    if (Object.keys(changes).length) void onAssign(changes);
    setReplaced(null); say('Undone.');
  };
  /** Lets go of the selection. From the keyboard, focus returns to what was selected: the bar's button is about to unmount. */
  const cancelSelection = (detail = 1) => {
    if (detail === 0) workspaceRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus();
    setSelected(null); setHover(null); setPrompt('');
  };
  const select = (source: PeriodPlacement, hint: string) => { setSelected(source); setPrompt(hint); setFlash(''); };
  const timeAt = (y: number, top: number, duration: number) => Math.max(startMinute, Math.min(endMinute - duration, snap(axis.time(y - top))));
  /** The day column under a point, as the landing for `item` there. */
  const landingAt = (item: Carry, { x, y }: DragPoint): Landing | null => {
    // Behind a dialog's footer or the app's bars there is still timetable, but nothing the pointer can be aiming at.
    const band = visibleBand();
    if (y < band.top || y > band.bottom) return null;
    for (const column of workspaceRef.current?.querySelectorAll<HTMLElement>('[data-column]') ?? []) {
      const rect = column.getBoundingClientRect();
      // A column scrolled out of its week's sideways scroll area is not under the pointer.
      const clip = column.closest('.time-canvas-scroll')?.getBoundingClientRect() ?? rect;
      if (x < Math.max(rect.left, clip.left) || x >= Math.min(rect.right, clip.right) || y < rect.top || y > rect.bottom) continue;
      const at = Math.max(startMinute, Math.min(endMinute - 1, Math.floor(axis.time(y - rect.top))));
      return landing(item.source, column.dataset.column!, at, timeAt(y - item.grab, rect.top, sourceDuration(item.source)));
    }
    return null;
  };
  /** A finger hides what is under it, so its ghost floats above (below when there is no room); a mouse or pen keeps it beside the tip. It stays on screen. */
  const moveGhost = () => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    const { x, y } = pointer.current;
    const above = y - ghost.offsetHeight - 28;
    const top = carry?.touch ? (above < 4 ? y + 40 : above) : y + 16;
    const left = Math.max(4, Math.min(window.innerWidth - ghost.offsetWidth - 4, x + (carry?.touch ? -28 : 14)));
    ghost.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(Math.min(window.innerHeight - ghost.offsetHeight - 4, top))}px, 0)`;
  };
  useLayoutEffect(moveGhost);
  const lift = usePointerDrag<Carry>(workspaceRef, {
    // Nothing here changes the layout (no message, no selection): the canvas must not shift under the pointer.
    start: (item, point, touch) => { pointer.current = point; setCarry({ ...item, touch }); setFlash(''); },
    move: (item, point) => {
      pointer.current = point; moveGhost();
      const next = disabled ? null : landingAt(item, point);
      setHover(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    },
    drop: (item, point) => {
      setCarry(null); setHover(null);
      const spot = landingAt(item, point);
      // Put back where it was: nothing to save, and no message to replace the one showing.
      const own = slotOf(item.source);
      if (spot && !spot.slotId && own && spot.dayId === item.source.dayId && spot.start === minutes(own.start) && spot.end === minutes(own.end)) return;
      if (spot) place(item.source, spot);
    },
    cancel: () => { setCarry(null); setHover(null); },
  }, { scrollX: '.time-canvas-scroll', pageBounds });
  // What is being placed, by drag or by tap, and whether it is a class that goes into blocks.
  const placing = carry?.source ?? selected;
  const placingClass = onAssign && placing ? clsFor(placing.periodId) : undefined;
  const hoverDay = hover && value.cycleDays.find(day => day.id === hover.dayId);
  const undoable = !!replaced && !cleared && replaced.message === message;
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
  return <><div ref={workspaceRef} className="timetable-workspace" data-hover-cards={hoverCards ? '' : undefined} data-placing={placingClass ? 'class' : undefined} onPointerOver={event => setHoverCards(event.pointerType !== 'touch')}>
    <aside className="timetable-palette gap-2 rounded-2xl bg-muted/70 p-3 ring-1 ring-inset ring-foreground/[0.04]">
      <strong className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Classes & periods</strong>
      <div className="timetable-palette-items" role="group" aria-label="Available periods">
        {value.periods.filter(period => !personalClassesOnly || period.kind !== 'class' || clsFor(period.id)).filter((period, index, all) => !personalClassesOnly || !clsFor(period.id) || all.findIndex(entry => clsFor(entry.id)?.id === clsFor(period.id)?.id) === index).map(period => {
          const cls = clsFor(period.id);
          const label = cls ? (personalClassesOnly ? cls.name : `${cls.name} · ${period.label}`) : period.label;
          const color = classColor(cls?.id ?? period.id, period.kind, cls?.color);
          const isScheduled = personalClassesOnly && cls ? value.periods.some(entry => personal?.assignments[entry.id] === cls.id && scheduled.has(entry.id)) : scheduled.has(period.id);
          const active = selected?.periodId === period.id && !selected.dayId;
          const lifted = !!carry && !carry.source.dayId && carry.source.periodId === period.id;
          return <ShadButton key={period.id} type="button" variant="outline" size="sm" className={cn('cursor-grab font-semibold text-foreground shadow-card active:cursor-grabbing', active && 'ring-2 ring-ring/60', lifted && 'opacity-50')} disabled={disabled} aria-label={`Place ${label}`} aria-pressed={active}
            style={{ borderColor: 'transparent', background: `color-mix(in srgb, ${color.dot} 22%, var(--card))` }} onPointerDown={event => { if (!disabled) lift(event, { source: { periodId: period.id }, label, color: color.dot, grab: 0 }); }}
            onClick={event => {
              if (active) { cancelSelection(); return; }
              // Tap works in either order: with an empty block selected, tapping a class puts it in that block.
              const block = slotOf(selected);
              if (selected?.dayId && block && cls && onAssign && isGuide(block)) { followWithFocus(event.detail, selected.dayId, placeAt({ periodId: period.id }, selected.dayId, minutes(block.start))); return; }
              select({ periodId: period.id }, cls && onAssign ? `${label} selected. Tap a block to put it there, or tap an empty time.` : `${label} selected. Tap a time in a day column.`);
            }}><span>{label}{!isScheduled && <span className="block text-xs font-normal opacity-75">{personalClassesOnly && cls ? 'Not placed yet' : 'No times set'}</span>}</span></ShadButton>;
        })}
      </div>
    </aside>
    <div ref={contentRef} className="timetable-content">
      {/* The selection bar: it takes no room in the flow and stays in view, so the way out is at hand anywhere on a long timetable. */}
      <div className="timetable-pin">{(selected || flash) && <div className="timetable-pin-bar">
        {selected ? <p role="status">{prompt}</p> : <p aria-hidden="true">{flash}</p>}
        {selected ? <Button size="sm" variant="ghost" onClick={event => cancelSelection(event.detail)}>Cancel selection</Button>
          : undoable && <Button size="sm" variant="ghost" tabIndex={-1} disabled={disabled} onClick={undoAssign}>Undo</Button>}
      </div>}</div>
      <div className={cn('timetable-status', message || cleared ? 'flex flex-wrap items-center gap-x-2' : 'contents')}>
        <p role="status" className={message ? 'text-xs text-muted-foreground' : 'sr-only'}>{message}</p>
        {/* Keyed per clear so a keyboard clear, which removes the focused ×, lands focus on Undo. */}
        {cleared && <Button key={cleared.slot.id} size="sm" variant="ghost" autoFocus={cleared.keyboard} disabled={disabled} onClick={undoClear}>Undo</Button>}
        {undoable && <Button size="sm" variant="ghost" disabled={disabled} onClick={undoAssign}>Undo</Button>}
      </div>
      <span id={hintId} className="sr-only">Use the arrow keys to choose a time, then press Enter.</span>
      {weeks.map((days, weekIndex) => <section key={days[0].id} className="grid gap-2 min-w-0" aria-label={`Rotation week ${weekIndex + 1}`}>
        <h3 className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Week {weekIndex + 1}</h3>
        <div className="time-canvas-scroll">
          <div className="time-canvas" style={{ '--days': days.length } as CSSProperties}>
            <div className="time-canvas-heading text-xs text-muted-foreground">Time</div>
            {days.map((day, index) => <div key={day.id} className="time-canvas-heading">
              <DayNameInput name={`Day ${weekIndex * weekLength + index + 1} name`} label={day.label} disabled={disabled} onCommit={label => { setCleared(null); return onChange({ ...value, cycleDays: value.cycleDays.map(entry => entry.id === day.id ? { ...entry, label } : entry) }); }} />
              <div className="flex items-center justify-between"><Button size="sm" variant="ghost" onClick={() => onEditDay(day.id)}>Edit times<span className="sr-only"> for {day.label}</span></Button><IconButton size="sm" icon="trash" label={`Remove ${day.label}`} disabled={disabled || value.cycleDays.length <= 1} onClick={() => onRemoveDay(day.id)} /></div>
            </div>)}
            <div className="time-axis" style={{ height }}>{Array.from({ length: Math.ceil((endMinute - startMinute) / 60) }, (_, index) => <span key={index} style={{ top: axis.y(startMinute + index * 60) }}>{formatTime(clockTime(startMinute + index * 60))}</span>)}</div>
            {days.map(day => <div key={day.id} className="time-day" data-column={day.id} role="group" aria-label={`${day.label} time canvas`} style={{ height }}>
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
                const period = periodOf(slot.periodId);
                const cls = clsFor(slot.periodId);
                const guide = isGuide(slot);
                // A slot can outlive its period (a school removed it under a student's day override); never show the raw ID.
                const name = cls?.name ?? displayPeriodLabel(period, !personalClassesOnly);
                const color = classColor(cls?.id ?? period?.id, period?.kind, cls?.color);
                const active = resizing?.dayId === day.id && resizing.slot.id === slot.id ? resizing : null;
                const start = active?.start ?? minutes(slot.start); const end = active?.end ?? minutes(slot.end);
                const blockHeight = axis.y(end) - axis.y(start);
                const compact = blockHeight < 48;
                // Whole title lines that fit above the time label: 14px of padding, a 17px time row, 14.5px per line.
                const titleLines = Math.max(1, Math.min(4, Math.floor((blockHeight - 31) / 14.5)));
                const own = selected?.slotId === slot.id && selected.dayId === day.id;
                const lifted = carry?.source.slotId === slot.id && carry.source.dayId === day.id;
                return <div key={slot.id} className={`time-block${guide ? ' time-school-guide' : ''}${compact ? ' time-block-compact' : titleLines === 1 ? ' time-block-short' : ''}${own ? ' time-block-open' : ''}${lifted ? ' time-drag-source' : ''}`} style={{ top: axis.y(start), height: blockHeight, '--title-lines': titleLines, '--block-color': color.dot, background: guide ? undefined : `color-mix(in srgb, ${color.dot} 22%, var(--card))` } as CSSProperties}>
                  <button type="button" title={`${name} · ${formatRange(clockTime(start), clockTime(end))}`} className="time-block-body" data-day={day.id} data-start={minutes(slot.start)} disabled={disabled} aria-pressed={own} aria-label={`${day.label}, ${formatRange(slot.start, slot.end)}: ${name}`}
                    onPointerDown={event => { if (!disabled) lift(event, { source: { periodId: slot.periodId, dayId: day.id, slotId: slot.id }, label: name, color: color.dot, grab: event.clientY - event.currentTarget.getBoundingClientRect().top }); }}
                    onClick={event => {
                      if (own) { cancelSelection(); return; }
                      if (selected && placingClass) { followWithFocus(event.detail, day.id, placeAt(selected, day.id, minutes(slot.start))); return; }
                      select({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }, guide ? 'Empty block selected. Tap a class to put it here, or tap an empty time to move the block.' : cls && onAssign ? `${name} selected. Tap another block to move the class there, or tap an empty time to move this block.` : 'Select another time to move this block.');
                    }}>
                    <strong>{name}</strong>{guide && <span>{placingClass ? (carry ? 'Drop here' : 'Tap to place here') : name === UNASSIGNED_BLOCK_LABEL ? 'Drop a class here' : 'Unassigned block · drop class here'}</span>}
                    {/* The axis already says AM or PM; the full range stays in the tooltip, the hover card and the label. */}
                    <span>{formatRange(clockTime(start), clockTime(end)).replace(/\s?[AP]M/g, '')}</span>
                  </button>
                  <div className="time-block-detail" aria-hidden="true"><strong>{name}</strong><span>{formatRange(clockTime(start), clockTime(end))}</span></div>
                  <button type="button" className="time-block-clear" aria-label={`${cls && onAssign ? 'Remove class from' : 'Remove time block from'} ${day.label} ${formatRange(slot.start, slot.end)}`} disabled={disabled} onClick={event => setRemoving({ dayId: day.id, dayLabel: day.label, slot, name, keyboard: event.detail === 0 })}>×</button>
                  {(['start', 'end'] as const).map(edge => <button key={edge} type="button" className={`time-resize time-resize-${edge}`} disabled={disabled} aria-label={`Resize ${day.label} ${period ? displayPeriodLabel(period, cls?.name ?? !personalClassesOnly) : name} ${edge}`} title={`Drag to change ${edge}; arrow keys adjust by 5 minutes`}
                    onPointerDown={event => beginResize(event, day.id, slot, edge)} onPointerMove={moveResize}
                    onPointerUp={event => { const current = resizeRef.current; if (!current) return; event.stopPropagation(); if (current.start !== minutes(current.slot.start) || current.end !== minutes(current.slot.end)) commit({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }, day.id, current.start, current.end); resizeRef.current = null; setResizing(null); }}
                    onPointerCancel={() => { resizeRef.current = null; setResizing(null); }} onClick={event => event.stopPropagation()}
                    onKeyDown={event => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const delta = event.key === 'ArrowUp' ? -5 : 5; commit({ periodId: slot.periodId, dayId: day.id, slotId: slot.id }, day.id, minutes(slot.start) + (edge === 'start' ? delta : 0), minutes(slot.end) + (edge === 'end' ? delta : 0)); }} />)}
                </div>;
              })}
              {hover?.dayId === day.id && <div className="time-drop-preview" data-invalid={hover.problem ? '' : undefined} style={{ top: axis.y(hover.start), height: axis.y(hover.end) - axis.y(hover.start) }}>{hover.label ?? formatRange(clockTime(hover.start), clockTime(hover.end))}</div>}
            </div>)}
          </div>
        </div>
      </section>)}
    </div>
  </div>
  {/* In a portal: a dialog around the timetable is transformed, which would offset and clip a fixed child. */}
  {carry && createPortal(<div ref={ghostRef} className="time-drag-ghost" aria-hidden="true" data-invalid={hover?.problem ? '' : undefined} style={{ background: `color-mix(in srgb, ${carry.color} 22%, var(--card))` }}>
    <strong>{carry.label}</strong>{hover && hoverDay && <span>{hoverDay.label} · {hover.label ?? formatRange(clockTime(hover.start), clockTime(hover.end))}</span>}
  </div>, document.body)}
  <Modal open={!!removing} onClose={() => setRemoving(null)} title={removing && clsFor(removing.slot.periodId) && onAssign ? `Remove ${removing.name} from this block?` : `Remove ${removing?.name ?? 'time block'}?`}
    footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button><Spacer /><Button variant="danger" disabled={disabled} onClick={removing && clsFor(removing.slot.periodId) && onAssign ? clearClass : clearBlock}>{removing && clsFor(removing.slot.periodId) && onAssign ? 'Remove class' : 'Remove time block'}</Button></>}>
    <p className="text-sm text-muted-foreground">{removing && `${removing.dayLabel}, ${formatRange(removing.slot.start, removing.slot.end)}`}. {removing && clsFor(removing.slot.periodId) && onAssign ? `${blocksOf(removing.slot.periodId) > 1 ? `${removing.name} is in ${blocksOf(removing.slot.periodId)} blocks of this period and leaves all of them. ` : ''}The class stays saved, and the time block stays on your timetable. Use × again to remove an empty block.` : 'This removes the time block from the timetable.'}</p>
  </Modal></>;
}

/** Saves the day name on blur or Enter rather than per keystroke, so typing never races a save. */
function DayNameInput({ name, label, disabled, onCommit }: { name: string; label: string; disabled?: boolean; onCommit: (label: string) => boolean | void }) {
  const [text, setText] = useState(label);
  const [shown, setShown] = useState(label);
  if (shown !== label) { setShown(label); setText(label); }
  const commit = () => {
    if (!text.trim()) { setText(label); return; }
    if (text !== label && onCommit(text) === false) setText(label);
  };
  return <Input small aria-label={name} value={text} maxLength={120} disabled={disabled} enterKeyHint="done"
    onChange={event => setText(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />;
}
