'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/client/reduced-motion';

let enabled = false;
const listeners = new Set<() => void>();
export function setAttentionMode(value: boolean) {
  enabled = value;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Counts and directions belong to these explicitly placed document slots.
const TILES: Record<string, { count: number; direction: 'rows' | 'columns' }> = {
  sidebar: { count: 3, direction: 'rows' },
  'left-gutter': { count: 4, direction: 'rows' },
  'right-gutter': { count: 4, direction: 'rows' },
  'page-header': { count: 2, direction: 'columns' },
  'today-tasks': { count: 2, direction: 'rows' },
  'school-directory': { count: 2, direction: 'rows' },
  'account-look': { count: 2, direction: 'columns' },
};
const GAP = 8;
const MIN_HEIGHT = 32;
const playbackListeners = new Set<() => void>();
let dialogRoot: Element | null = null;
let dialogObserver: MutationObserver | null = null;
function watchPlayback(listener: () => void) {
  const update = () => {
    dialogRoot = [...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1) ?? null;
    for (const playback of playbackListeners) playback();
  };
  playbackListeners.add(listener);
  if (!dialogObserver) {
    dialogRoot = [...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1) ?? null;
    dialogObserver = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element && (node.matches('[role="dialog"]') || node.querySelector('[role="dialog"]'))))) update();
    });
    dialogObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
  }
  return () => {
    playbackListeners.delete(listener);
    if (!playbackListeners.size) { dialogObserver?.disconnect(); dialogObserver = null; dialogRoot = null; }
  };
}

function AttentionVideo({ zone }: { zone: string }) {
  const reducedMotion = useReducedMotion();
  const reduced = useRef(reducedMotion);
  reduced.current = reducedMotion;
  const ref = useRef<HTMLVideoElement>(null);
  const visible = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const playback = (element: HTMLVideoElement) => {
    if (visible.current && !document.hidden && (!dialogRoot || dialogRoot.contains(element))) {
      setLoaded(true);
      if (reduced.current) element.pause();
      else void element.play().catch(() => {});
    }
    else element.pause();
  };

  useEffect(() => {
    if (ref.current) playback(ref.current);
  }, [reducedMotion]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const intersection = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting;
      playback(element);
    });
    const visibility = () => playback(element);
    const unwatch = watchPlayback(visibility);
    intersection.observe(element);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      visible.current = false;
      intersection.disconnect();
      unwatch();
      document.removeEventListener('visibilitychange', visibility);
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, []);

  return <video ref={element => { ref.current = element; if (element) { element.muted = true; element.defaultMuted = true; } }}
    data-attention-slot={zone} src={loaded ? '/mods/attention-span.mp4' : undefined} muted loop playsInline preload="metadata" disablePictureInPicture
    className="pointer-events-none block h-full min-h-0 w-full min-w-0 rounded-lg object-cover"
    onLoadedMetadata={event => {
      const element = event.currentTarget;
      if (Number.isFinite(element.duration) && element.duration > 0) element.currentTime = Math.random() * Math.max(0, element.duration - 1);
      playback(element);
    }} onCanPlay={event => playback(event.currentTarget)} />;
}

/** These are normal flex/grid children. Size containment prevents media from
 * creating a new row or enlarging the document's existing blank space. */
export function AttentionGap({ zone, className, as: Tag = 'div', minWidth = 96, top = 0, copies }: {
  zone: string; className?: string; as?: 'div' | 'li'; minWidth?: number; top?: number; copies?: number;
}) {
  const active = useSyncExternalStore(subscribe, () => enabled, () => false);
  const host = useRef<HTMLDivElement & HTMLLIElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const tiles = TILES[zone] ?? { count: 1, direction: 'columns' as const };
  const desired = copies ?? tiles.count;
  const availableHeight = Math.max(0, size.height - top);
  const fits = size.width >= minWidth && availableHeight >= MIN_HEIGHT;
  const count = fits ? (tiles.direction === 'rows'
    ? availableHeight >= desired * MIN_HEIGHT + (desired - 1) * GAP
    : size.width >= desired * minWidth + (desired - 1) * GAP) ? desired : 1 : 0;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);

  return <Tag ref={host} data-attention-gap={zone} aria-hidden="true" className={cn('min-h-0 min-w-0 self-stretch overflow-hidden', className)} style={{ contain: 'size' }}>
    {active && count > 0 && <div data-attention-tiles={zone} data-attention-gap={zone} className="grid min-h-0 min-w-0 overflow-hidden"
      style={{ width: size.width, height: availableHeight, marginTop: top, gap: GAP,
        gridTemplateColumns: tiles.direction === 'columns' ? `repeat(${count}, minmax(0, 1fr))` : 'minmax(0, 1fr)',
        gridTemplateRows: tiles.direction === 'rows' ? `repeat(${count}, minmax(0, 1fr))` : 'minmax(0, 1fr)' }}>
      {Array.from({ length: count }, (_, index) => <AttentionVideo key={index} zone={zone} />)}
    </div>}
  </Tag>;
}

/** Fill the unused final-row columns, including the wide two-column gap. */
export function AttentionClassCells({ count }: { count: number }) {
  return <>
    {count % 2 !== 0 && <AttentionGap as="li" zone="classes-grid" copies={1} className="hidden sm:block lg:hidden" />}
    {count % 3 === 1 && <AttentionGap as="li" zone="classes-grid" copies={2} className="hidden lg:block lg:col-span-2" />}
    {count % 3 === 2 && <AttentionGap as="li" zone="classes-grid" copies={1} className="hidden lg:block" />}
  </>;
}
