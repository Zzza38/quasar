'use client';

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export type DragPoint = { x: number; y: number };

export type PointerDragHandlers<T> = {
  /** A press became a drag. `touch` is true for a finger, which drags after a press and hold and covers what is under it. */
  start: (item: T, point: DragPoint, touch: boolean) => void;
  /** The pointer moved, or the content scrolled under a pointer held at an edge. */
  move: (item: T, point: DragPoint) => void;
  drop: (item: T, point: DragPoint) => void;
  /** The drag ended without a drop: Escape, a browser gesture took the pointer, or it was held and never moved. */
  cancel: (item: T) => void;
};

/** A mouse or a pen drags once it has moved this far; a shorter move is still a click. */
const MOVE_SLOP = 5;
/** A finger drags after holding still this long, so a swipe that starts on a draggable still scrolls the page. */
const HOLD_MS = 200;
const HOLD_SLOP = 8;
/** A finger or pen that travelled less than this after picking something up was tapping, not dragging. */
const TAP_SLOP = 10;
/** How long the pointer rests near an edge before scrolling starts, so a quick drop near an edge lands where it was aimed. */
const EDGE_DWELL_MS = 250;
/** An edge the drag started beside scrolls only once the pointer has moved this far towards it, or has left its zone. */
const EDGE_ARM = 16;
/** Distance from an edge where scrolling starts, and the speed in px per second at the edge itself. */
const VERTICAL = { zone: 96, speed: 1100 };
const SIDEWAYS = { zone: 48, speed: 600 };

type Axis = 'x' | 'y';
type Press<T> = {
  item: T; id: number; finger: boolean; pen: boolean; source: HTMLElement; origin: DragPoint; point: DragPoint; active: boolean; moved: boolean;
  /** Where the drag became active, and whether a touchmove was cancelled (after which iOS sends no click of its own). */
  lifted: DragPoint; prevented: boolean; hold: number; frame: number; tick: number;
  /** Per axis: which way the pointer's edge scrolls, since when, the fraction of a pixel not scrolled yet, and which directions may scroll. */
  edge: Record<Axis, { direction: number; since: number; residue: number; back: boolean; forth: boolean }>;
};

const pageScroller = () => document.scrollingElement ?? document.documentElement;

/**
 * The nearest ancestor that scrolls vertically, else the page. Inside a fixed layer (a dialog) that does not scroll
 * there is nothing to scroll: the page behind it must stay where it is.
 */
export function verticalScroller(element: Element): Element | null {
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll|overlay/.test(style.overflowY)) return node;
    if (style.position === 'fixed') return null;
  }
  return pageScroller();
}

/** Scroll speed in px per second for a pointer at `position` in a scroll area from `start` to `end`: zero away from its edges, negative near `start`. */
export function edgeSpeed(position: number, start: number, end: number, { zone, speed } = VERTICAL): number {
  const depth = Math.min(zone, (end - start) / 3);
  if (depth <= 0) return 0;
  const into = position < start + depth ? (position - start - depth) / depth : position > end - depth ? (position - end + depth) / depth : 0;
  const ratio = Math.max(-1, Math.min(1, into));
  return Math.sign(ratio) * Math.abs(ratio) ** 1.5 * speed;
}

/**
 * Drag with pointer events instead of HTML5 drag and drop. On an iPad that needs a long press to lift, refuses the
 * drop whenever the element under the finger has just changed (WebKit decides from dragenter), and never scrolls
 * the page. Here a mouse or a pen drags as soon as it moves and a finger after a short hold. A drag held near the
 * top or bottom of the scroll area around `root` scrolls it, and `scrollX` selects areas in `root` that scroll sideways.
 * `pageBounds` gives the part of the viewport not covered by fixed bars, used when the page itself scrolls.
 * Returns the pointerdown handler for a draggable; a press that never becomes a drag still clicks.
 */
export function usePointerDrag<T>(root: RefObject<HTMLElement | null>, handlers: PointerDragHandlers<T>, options?: { scrollX?: string; pageBounds?: () => { top: number; bottom: number } }) {
  const live = useRef({ handlers, options });
  useLayoutEffect(() => { live.current = { handlers, options }; });
  const press = useRef<Press<T> | null>(null);
  /** When the last drag was dropped, so the touchend that belongs to it does not also tap. */
  const dropped = useRef(-1);
  const [control] = useState(() => {
    /** Scrolls one axis by what its edge asks for this frame. Returns whether anything moved. */
    const advance = (state: Press<T>, axis: Axis, speed: number, now: number, seconds: number, scroller: Element): boolean => {
      const edge = state.edge[axis];
      const direction = Math.sign(speed);
      // A drag often starts beside an edge (the palette sits at the top): that edge stays quiet until the pointer has left it or pushed towards it.
      // Only the page's own top and bottom are start-side edges; a sideways area is entered from outside.
      const travel = state.point[axis] - state.origin[axis];
      const armed = direction < 0 ? edge.back : edge.forth;
      edge.back ||= axis === 'x' || direction >= 0 || travel <= -EDGE_ARM;
      edge.forth ||= axis === 'x' || direction <= 0 || travel >= EDGE_ARM;
      if (direction !== edge.direction) Object.assign(edge, { direction, since: now, residue: 0 });
      // The rest before scrolling starts counts from the moment the edge arms.
      else if (direction && !armed && (direction < 0 ? edge.back : edge.forth)) edge.since = now;
      if (!direction || !(direction < 0 ? edge.back : edge.forth) || now - edge.since < EDGE_DWELL_MS) return false;
      // Whole pixels only: some browsers drop fractional scroll offsets, so the remainder carries over.
      const distance = speed * seconds + edge.residue;
      const step = Math.trunc(distance);
      edge.residue = distance - step;
      if (!step) return false;
      const before = axis === 'y' ? scroller.scrollTop : scroller.scrollLeft;
      scroller.scrollBy({ [axis === 'y' ? 'top' : 'left']: step, behavior: 'instant' });
      return (axis === 'y' ? scroller.scrollTop : scroller.scrollLeft) !== before;
    };
    const scrollStep = (state: Press<T>, now: number, seconds: number): boolean => {
      const element = root.current;
      // A press held near an edge does not scroll until it has moved: the finger may only be picking the block up.
      if (!element || !state.moved) return false;
      const { x, y } = state.point;
      const view = window.visualViewport;
      const screen = { top: view?.offsetTop ?? 0, left: view?.offsetLeft ?? 0, bottom: (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight), right: (view?.offsetLeft ?? 0) + (view?.width ?? window.innerWidth) };
      let scrolled = false;
      const scroller = verticalScroller(element);
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const bounds = scroller === pageScroller() ? live.current.options?.pageBounds?.() ?? screen : { top: rect.top + scroller.clientTop, bottom: rect.top + scroller.clientTop + scroller.clientHeight };
        const top = Math.max(screen.top, bounds.top);
        const bottom = Math.min(screen.bottom, bounds.bottom);
        const own = element.getBoundingClientRect();
        let speed = edgeSpeed(y, top, bottom);
        // Stop once the root's own edge is in view: there is nothing further in that direction to drop on.
        if (speed < 0 ? own.top >= top + 24 : own.bottom <= bottom - 24) speed = 0;
        scrolled = advance(state, 'y', speed, now, seconds, scroller);
      }
      const selector = live.current.options?.scrollX;
      const sideways = selector ? [...element.querySelectorAll<HTMLElement>(selector)].find((entry) => {
        const box = entry.getBoundingClientRect();
        return entry.scrollWidth > entry.clientWidth + 1 && y >= box.top && y <= box.bottom;
      }) : undefined;
      if (sideways) {
        const box = sideways.getBoundingClientRect();
        if (advance(state, 'x', edgeSpeed(x, Math.max(screen.left, box.left), Math.min(screen.right, box.right), SIDEWAYS), now, seconds, sideways)) scrolled = true;
      } else state.edge.x.direction = 0;
      return scrolled;
    };
    const frame = (now: number) => {
      const state = press.current;
      if (!state?.active) return;
      const seconds = Math.min(0.05, Math.max(0, now - state.tick) / 1000);
      state.tick = now;
      if (scrollStep(state, now, seconds)) live.current.handlers.move(state.item, state.point);
      state.frame = requestAnimationFrame(frame);
    };
    const activate = (state: Press<T>) => {
      if (press.current !== state || state.active) return;
      window.clearTimeout(state.hold);
      state.active = true;
      state.lifted = state.point;
      document.documentElement.setAttribute('data-pointer-dragging', '');
      live.current.handlers.start(state.item, state.point, state.finger);
      state.tick = performance.now();
      state.frame = requestAnimationFrame(frame);
    };
    const release = () => {
      const state = press.current;
      if (!state) return null;
      press.current = null;
      window.clearTimeout(state.hold);
      cancelAnimationFrame(state.frame);
      document.documentElement.removeAttribute('data-pointer-dragging');
      try { state.source.releasePointerCapture(state.id); } catch { /* It was never captured, or is already released. */ }
      state.source.removeEventListener('touchmove', touchMove);
      state.source.removeEventListener('touchend', touchEnd);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', abort, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('contextmenu', menu, true);
      window.removeEventListener('dragstart', menu, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', abort);
      document.removeEventListener('visibilitychange', abort);
      return state;
    };
    const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    /**
     * The click that ends a drag belongs to the drag: without this it would select whatever the press started on.
     * A touch click can arrive a moment after the release, so the guard stays until the next press.
     */
    const guardClick = () => {
      const clear = () => { dropped.current = -1; window.clearTimeout(timer); window.removeEventListener('click', swallow, true); window.removeEventListener('pointerdown', clear, true); };
      const timer = window.setTimeout(clear, 400);
      window.addEventListener('click', swallow, true);
      window.addEventListener('pointerdown', clear, true);
    };
    const abort = (event?: Event) => {
      if (event instanceof PointerEvent && event.pointerId !== press.current?.id) return;
      const state = release();
      if (!state?.active) return;
      live.current.handlers.cancel(state.item);
      if (event?.type === 'pointercancel') return;
      // Escape ended the drag with the button still down: the release that follows must not click either.
      const lifted = (later: PointerEvent) => {
        if (later.type === 'pointerup' && later.pointerId !== state.id) return;
        window.removeEventListener('pointerup', lifted, true);
        window.removeEventListener('pointerdown', lifted, true);
        if (later.type === 'pointerup') guardClick();
      };
      window.addEventListener('pointerup', lifted, true);
      window.addEventListener('pointerdown', lifted, true);
    };
    const move = (event: PointerEvent) => {
      const state = press.current;
      if (!state || event.pointerId !== state.id) return;
      state.point = { x: event.clientX, y: event.clientY };
      const distance = Math.hypot(state.point.x - state.origin.x, state.point.y - state.origin.y);
      if (!state.active) {
        // A finger that moves before the hold is scrolling; a mouse whose button was released elsewhere is not dragging.
        if (state.finger ? distance > HOLD_SLOP : event.buttons === 0) { abort(); return; }
        if (state.finger || distance < MOVE_SLOP) return;
        activate(state);
      }
      // A mouse that has started dragging is dragging. A finger or pen tip slides a little on any tap, so for
      // them the drag only counts once it has gone somewhere.
      if (Math.hypot(state.point.x - state.lifted.x, state.point.y - state.lifted.y) >= (state.finger || state.pen ? TAP_SLOP : 0)) state.moved = true;
      live.current.handlers.move(state.item, state.point);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== press.current?.id) return;
      const state = release()!;
      if (state.active && state.moved) {
        dropped.current = event.timeStamp;
        guardClick();
        live.current.handlers.drop(state.item, { x: event.clientX, y: event.clientY });
        return;
      }
      if (state.active) live.current.handlers.cancel(state.item);
      // Picked up but never taken anywhere: that was a tap. After a held press or a cancelled touchmove iOS sends
      // no click, so the tap is delivered here (detail 1, as a pointer click reports) and a native one is swallowed.
      if (!state.active && !state.prevented) return;
      if (!state.finger && !state.pen) return;
      state.source.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1 }));
      dropped.current = event.timeStamp;
      guardClick();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !press.current?.active) return;
      // Captured on the window, ahead of a dialog's own Escape handling, so Escape ends the drag and nothing else.
      swallow(event);
      abort();
    };
    /** A long press opens the context menu on Android, and a held press can start a native drag; the press is a drag here. */
    const menu = (event: Event) => { if (press.current && (press.current.active || press.current.finger)) event.preventDefault(); };
    // Not passive: without preventDefault the page pans away under a held drag. Once the browser has started panning
    // the event can no longer be cancelled, and the drag is over.
    // A pen is cancelled from its first move, before it is a drag: iOS decides on the first touchmove whether the
    // page may pan, and a pen crosses the drag threshold too fast to catch it later. A finger is left to scroll.
    const touchMove = (event: TouchEvent) => {
      const state = press.current;
      if (!state || !(state.active || state.pen)) return;
      if (event.cancelable) { event.preventDefault(); state.prevented = true; } else abort();
    };
    // Once only: the next touch is a new gesture, however soon it comes.
    const touchEnd = (event: TouchEvent) => { if (event.cancelable && Math.abs(event.timeStamp - dropped.current) < 100) event.preventDefault(); dropped.current = -1; };
    /** The wheel can scroll during a mouse drag, which moves the content under a pointer that did not move. */
    const scroll = () => { const state = press.current; if (state?.active) live.current.handlers.move(state.item, state.point); };
    const begin = (event: ReactPointerEvent<HTMLElement>, item: T) => {
      if (press.current || !event.isPrimary || event.button !== 0) return;
      const point = { x: event.clientX, y: event.clientY };
      // An Apple Pencil pans the page like a finger, but it is aimed like a mouse: it drags as soon as it moves.
      const finger = event.pointerType === 'touch';
      const pen = event.pointerType === 'pen';
      const source = event.currentTarget;
      const edge = () => ({ direction: 0, since: 0, residue: 0, back: false, forth: false });
      const state: Press<T> = { item, id: event.pointerId, finger, pen, source, origin: point, point, lifted: point, prevented: false, active: false, moved: false, hold: 0, frame: 0, tick: 0, edge: { x: edge(), y: edge() } };
      press.current = state;
      // Captured so every move reaches this press, whatever is under the pointer (a disabled control swallows pointer events).
      try { source.setPointerCapture(event.pointerId); } catch { /* The pointer is already gone. */ }
      // Touch events keep going to the element the touch started on, even after it has left the document.
      source.addEventListener('touchmove', touchMove, { passive: false });
      source.addEventListener('touchend', touchEnd, { passive: false });
      if (finger) state.hold = window.setTimeout(() => activate(state), HOLD_MS);
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', abort, true);
      window.addEventListener('keydown', key, true);
      window.addEventListener('contextmenu', menu, true);
      window.addEventListener('dragstart', menu, true);
      window.addEventListener('scroll', scroll, true);
      window.addEventListener('blur', abort);
      document.addEventListener('visibilitychange', abort);
    };
    return { begin, abort: () => abort(), touchMove, touchEnd };
  });
  useEffect(() => {
    // Registered before any gesture: iOS ignores preventDefault from a touchmove listener that is first added
    // mid-gesture (and React's own touch listeners are passive).
    window.addEventListener('touchmove', control.touchMove, { passive: false });
    window.addEventListener('touchend', control.touchEnd, { passive: false });
    return () => { window.removeEventListener('touchmove', control.touchMove); window.removeEventListener('touchend', control.touchEnd); control.abort(); };
  }, [control]);
  return control.begin;
}
