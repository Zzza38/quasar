'use client';

import { useEffect } from 'react';
import { STRIDE, Field, type ShyEngineRequest, type ShyEngineResponse } from '@/lib/shy-engine';
import { ShyNeighborhood } from '@/lib/shy-neighbors';
import { keepInBounds, particleRepulsion, stepShyPhysics, SHY_REPULSION_RANGE, type Point, type SpaceRect } from '@/lib/shy-motion';

type Visual = HTMLElement | SVGSVGElement;
type Particle = { id: number; element: Visual; home: SpaceRect; bounds: SpaceRect; x: number; y: number; velocity: Point; translate: string; transition: string; display: string; visible: boolean; painted: string; renderedX: number; renderedY: number; lastStep: number; anchored: boolean; owner: Particle | null };
type TextRun = { original: string; wrapper: HTMLSpanElement };
const CONTROLS = 'button, [role="button"]';
const MEDIA = 'img, svg, video, canvas, [role="img"]';
const LAYERS = '[role="dialog"], [role="alertdialog"], [data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], [data-slot="select-content"]';
const TEXT_EXCLUDED = 'script, style, noscript, textarea, input, [contenteditable], [role="textbox"], .sr-only, [data-shy-text], .broken-hearts';

function isUiPiece(element: HTMLElement): boolean {
  if (element.closest('.broken-hearts, .sr-only, script, style, noscript, [data-shy-text], svg') || element.matches('main, header, footer, nav, aside, section, form, [role="dialog"], [role="alertdialog"], [data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], .rgb-mode-overlay')) return false;
  const style = getComputedStyle(element);
  if (style.display === 'contents' || style.position === 'fixed' && element.getAttribute('data-state') !== null && !element.matches(CONTROLS)) return false;
  // Layout-only wrappers have no separate visible piece to move.
  if (element.matches('div, span') && element.children.length) {
    return style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none' || style.boxShadow !== 'none' ||
      ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0);
  }
  return true;
}

function activeLayer(): Element | null {
  const layers = [...document.querySelectorAll(LAYERS)].filter(element => {
    const rect = element.getBoundingClientRect();
    return !element.closest('[inert]') && element.getAttribute('data-state') !== 'closed' && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  });
  layers.sort((a, b) => (Number.parseInt(getComputedStyle(a).zIndex) || 0) - (Number.parseInt(getComputedStyle(b).zIndex) || 0) ||
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return layers.at(-1) ?? null;
}

function movementBounds(pageHeight: number): SpaceRect {
  return { x: 8, y: 8 - window.scrollY, width: Math.max(0, document.documentElement.clientWidth - 16), height: Math.max(0, pageHeight - 16) };
}

const rectOf = (particle: Particle): SpaceRect => ({ ...particle.home, x: particle.home.x + particle.x, y: particle.home.y + particle.y });

export function ShyParticles() {
  useEffect(() => {
    const textRuns = new Map<Text, TextRun>();
    const particles = new Map<Visual, Particle>();
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let serial = 0, frame = 0, lastFrame = 0;
    let lastOffscreen = 0;
    let ordered: Particle[] = [];
    let worker: Worker | null = null;
    let workerReady = false, inFlight = false, workerNeedsStep = true;
    let generation = 0, submittedAt = 0;
    let inputVersion = 0, submittedVersion = 0;
    let submitted: Particle[] = [];
    let indices = new Map<Particle, number>();
    let recycled: Float64Array | null = null;
    const stats = { pending: false, backend: 'starting', workerMs: 0, steps: 0 };
    const debugWindow = window as Window & { __shyWorkerStats?: typeof stats };
    debugWindow.__shyWorkerStats = stats;
    let dirty = true;
    let measuredScrollY = window.scrollY;
    let layer: Element | null = null;
    let pointer: Point | null = null;
    let disposed = false;
    let pageHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    let pageSizeDirty = false;
    const originalPageHeight = document.documentElement.style.getPropertyValue('--shy-page-height');
    document.documentElement.style.setProperty('--shy-page-height', `${pageHeight}px`);
    document.documentElement.setAttribute('data-shy-mode', 'true');

    const restore = (particle: Particle) => {
      particle.element.style.translate = particle.translate;
      particle.element.style.transitionProperty = particle.transition;
      particle.element.style.display = particle.display;
      if (!particle.element.hasAttribute('data-shy-glyph')) particle.element.removeAttribute('data-shy-particle');
    };
    const paint = (particle: Particle) => {
      const x = Math.round(particle.x * 2) / 2, y = Math.round(particle.y * 2) / 2;
      const translate = `${x - (particle.owner?.renderedX ?? 0)}px ${y - (particle.owner?.renderedY ?? 0)}px`;
      particle.renderedX = x; particle.renderedY = y;
      if (translate === particle.painted) return false;
      particle.element.style.translate = translate; particle.painted = translate;
      return true;
    };
    const flushPaint = () => { for (const particle of ordered) paint(particle); };
    const renderChanged = (changed: Set<Particle>) => {
      const rendered = new Set<Particle>();
      for (const particle of ordered) {
        const rect = rectOf(particle);
        if ((changed.has(particle) && rect.y + rect.height > -32 && rect.y < window.innerHeight + 32) || particle.owner && rendered.has(particle.owner)) {
          if (paint(particle)) rendered.add(particle);
        }
      }
    };
    const observe = () => {
      mutations.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-hidden', 'inert', 'data-state', 'class'] });
      mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['data-backwards', 'data-appearance'] });
    };

    const splitText = () => {
      mutations.disconnect();
      // Keep React's original Text node in place. Its next update remains visible
      // to this observer, and React can still remove it without a removeChild error.
      for (const [node, run] of textRuns) {
        if (!node.isConnected || !run.wrapper.isConnected || node.data) {
          if (node.isConnected && !node.data) node.data = run.original;
          run.wrapper.remove();
          textRuns.delete(node);
        }
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && node.parentElement && !node.parentElement.closest(TEXT_EXCLUDED) && !node.parentElement.closest('svg, img, video, canvas')) nodes.push(node as Text);
      }
      for (const node of nodes) {
        const wrapper = document.createElement('span');
        wrapper.dataset.shyText = '';
        const original = node.data;
        // Expose the moving text as one named visual, preserving control names
        // instead of announcing every inline-block letter separately.
        wrapper.setAttribute('role', 'img');
        wrapper.setAttribute('aria-label', original);
        for (const word of original.split(/(\s+)/)) {
          if (!word) continue;
          if (/^\s+$/.test(word)) { wrapper.append(document.createTextNode(word)); continue; }
          const group = document.createElement('span');
          group.style.whiteSpace = 'nowrap';
          for (const { segment } of segmenter.segment(word)) {
            const glyph = document.createElement('span');
            glyph.dataset.shyGlyph = '';
            glyph.setAttribute('aria-hidden', 'true');
            glyph.dataset.shyParticle = 'letter';
            glyph.style.display = 'inline-block';
            glyph.textContent = segment;
            group.append(glyph);
          }
          wrapper.append(group);
        }
        node.after(wrapper);
        node.data = '';
        textRuns.set(node, { original, wrapper });
      }
      observe();
    };

    const measure = () => {
      flushPaint();
      if (pageSizeDirty) {
        // Measure natural layout, never transformed overflow. Otherwise moving
        // pieces would gradually expand their own movement area.
        document.documentElement.setAttribute('data-shy-measuring', 'true');
        pageHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
        document.documentElement.removeAttribute('data-shy-measuring');
        document.documentElement.style.setProperty('--shy-page-height', `${pageHeight}px`);
        pageSizeDirty = false;
      }
      splitText();
      const mediaCandidates = [...document.querySelectorAll<Visual>(MEDIA)].filter(element =>
        !element.closest('.broken-hearts, .sr-only, script, style, [data-shy-text]') && !element.querySelector('[data-shy-glyph]'));
      const candidateSet = new Set<Element>(mediaCandidates);
      const media = mediaCandidates.filter(element => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) if (candidateSet.has(parent)) return false;
        return true;
      });
      const pieces = [...document.body.querySelectorAll<HTMLElement>('*')].filter(isUiPiece);
      const elements = [...new Set<Visual>([...pieces, ...document.querySelectorAll<HTMLElement>('[data-shy-glyph]'), ...media])];
      // Parents must be registered before their children so compensation works
      // through any number of independently moving UI pieces.
      elements.sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      const originalDisplays = new Map<Visual, string>();
      for (const element of elements) if (!particles.has(element) && getComputedStyle(element).display === 'inline' && !element.matches(MEDIA)) {
        originalDisplays.set(element, element.style.display);
        element.style.display = 'inline-block';
      }
      const present = new Set<Visual>(elements);
      for (const [element, particle] of particles) if (!present.has(element)) { restore(particle); particles.delete(element); }
      layer = activeLayer();
      const anchors = new Map<Element, boolean>();
      const anchored = (element: Element | null): boolean => {
        if (!element || element === document.body) return false;
        const cached = anchors.get(element);
        if (cached !== undefined) return cached;
        const position = getComputedStyle(element).position;
        const value = position === 'fixed' || position === 'sticky' || anchored(element.parentElement);
        anchors.set(element, value);
        return value;
      };
      const boundsByParent = new Map<Element, SpaceRect>();
      for (const element of elements) {
        let particle = particles.get(element);
        let owner: Particle | null = null;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const candidate = particles.get(ancestor as Visual);
          if (candidate && present.has(ancestor as Visual)) { owner = candidate; break; }
        }
        const rect = element.getBoundingClientRect();
        const parent = element.parentElement!;
        let bounds = boundsByParent.get(parent);
        if (!bounds) { bounds = movementBounds(pageHeight); boundsByParent.set(parent, bounds); }
        if (!particle) {
          particle = { id: serial++, element, home: { x: rect.x - (owner?.x ?? 0), y: rect.y - (owner?.y ?? 0), width: rect.width, height: rect.height }, bounds,
            x: owner?.x ?? 0, y: owner?.y ?? 0, velocity: { x: 0, y: 0 }, translate: element.style.translate, transition: element.style.transitionProperty, display: originalDisplays.get(element) ?? element.style.display, visible: true, painted: '', renderedX: owner?.renderedX ?? 0, renderedY: owner?.renderedY ?? 0, lastStep: 0, anchored: anchored(element), owner };
          element.style.transitionProperty = 'background-color, color, border-color, box-shadow, opacity';
          particles.set(element, particle);
          element.dataset.shyParticle = element.hasAttribute('data-shy-glyph') ? 'letter' : element.matches(CONTROLS) ? 'button' : 'visual';
        } else {
          particle.home = { x: rect.x - particle.x, y: rect.y - particle.y, width: rect.width, height: rect.height };
          particle.bounds = bounds;
        }
        particle.owner = owner;
        particle.anchored = anchored(element);
        const style = getComputedStyle(element);
        particle.visible = style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && !element.closest('[inert]') && (!layer || layer.contains(element));
      }
      measuredScrollY = window.scrollY;
      ordered = elements.map(element => particles.get(element)!);
      indices = new Map(ordered.map((particle, index) => [particle, index]));
      dirty = false;
    };

    const independent = (a: Particle, b: Particle) => {
      for (let parent = a.owner; parent; parent = parent.owner) if (parent === b) return false;
      for (let parent = b.owner; parent; parent = parent.owner) if (parent === a) return false;
      return true;
    };

    const run = (timestamp: number) => {
      frame = 0;
      // Keep animation work bounded even on high-refresh displays.
      if (!dirty && lastFrame && timestamp >= lastFrame && timestamp - lastFrame < 1000 / 30 - 1.5) {
        frame = requestAnimationFrame(run);
        return;
      }
      if (dirty) measure();
      const seconds = Math.min(lastFrame && timestamp > lastFrame ? (timestamp - lastFrame) / 1000 : 1 / 60, 1 / 30);
      lastFrame = timestamp;
      const offscreenDue = timestamp - lastOffscreen >= 1000 / 15 - 0.5;
      if (offscreenDue) lastOffscreen = timestamp;
      // A dialog's opening zoom changes every child rectangle. Wait for it to
      // settle; animationend refreshes the geometry before particles move.
      if (layer?.getAnimations().some(animation => animation.playState === 'running')) {
        for (const particle of particles.values()) particle.velocity = { x: 0, y: 0 };
        lastFrame = 0;
        return;
      }
      const visible = [...particles.values()].filter(particle => {
        const { element } = particle;
        const rect = rectOf(particle);
        const allowed = particle.visible && element.isConnected &&
          rect.width > 0 && rect.height > 0 && rect.x + rect.width > 0 && rect.y + rect.height > particle.bounds.y && rect.x < window.innerWidth && rect.y < particle.bounds.y + particle.bounds.height &&
          (rect.y + rect.height > 0 && rect.y < window.innerHeight || particle.x !== 0 || particle.y !== 0 || Math.hypot(particle.velocity.x, particle.velocity.y) >= 0.5);
        if (!allowed) { particle.velocity = { x: 0, y: 0 }; particle.lastStep = 0; }
        return allowed && (offscreenDue || rect.y + rect.height > -96 && rect.y < window.innerHeight + 96);
      });
      if (workerReady && worker) {
        if (inFlight) return;
        if (!workerNeedsStep) { lastFrame = 0; return; }
        const selected = new Set(visible);
        const data = recycled?.length === ordered.length * STRIDE ? recycled : new Float64Array(ordered.length * STRIDE);
        recycled = null;
        for (let index = 0; index < ordered.length; index++) {
          const particle = ordered[index], offset = index * STRIDE;
          data[offset + Field.ID] = particle.id;
          data[offset + Field.PARENT] = particle.owner ? indices.get(particle.owner) ?? -1 : -1;
          data[offset + Field.HOME_X] = particle.home.x; data[offset + Field.HOME_Y] = particle.home.y;
          data[offset + Field.WIDTH] = particle.home.width; data[offset + Field.HEIGHT] = particle.home.height;
          data[offset + Field.X] = particle.x; data[offset + Field.Y] = particle.y;
          data[offset + Field.VX] = particle.velocity.x; data[offset + Field.VY] = particle.velocity.y;
          data[offset + Field.BOUND_X] = particle.bounds.x; data[offset + Field.BOUND_Y] = particle.bounds.y;
          data[offset + Field.BOUND_WIDTH] = particle.bounds.width; data[offset + Field.BOUND_HEIGHT] = particle.bounds.height;
          data[offset + Field.SECONDS] = particle.lastStep && timestamp > particle.lastStep ? Math.min((timestamp - particle.lastStep) / 1000, 1 / 15) : seconds;
          data[offset + Field.ACTIVE] = selected.has(particle) && particle.home.width <= particle.bounds.width && particle.home.height <= particle.bounds.height ? 1 : 0;
        }
        submitted = ordered; submittedAt = timestamp; submittedVersion = inputVersion;
        inFlight = true; stats.pending = true;
        const request: ShyEngineRequest = { generation, pointer, data };
        worker.postMessage(request, [data.buffer as ArrayBuffer]);
        return;
      }
      const rectangles = new Map(visible.map(particle => [particle, rectOf(particle)]));
      const neighborhood = new ShyNeighborhood(visible, particle => rectangles.get(particle)!);
      const awake = new Set(visible.filter(particle => pointer || Math.hypot(particle.velocity.x, particle.velocity.y) >= 0.5));
      const forces = new Map<Particle, Point>();
      for (const particle of awake) for (const other of neighborhood.nearby(particle, SHY_REPULSION_RANGE)) {
        if (awake.has(other) && other.id < particle.id || !independent(particle, other)) continue;
        const force = particleRepulsion(rectangles.get(particle)!, rectangles.get(other)!);
        const a = forces.get(particle) ?? { x: 0, y: 0 }, b = forces.get(other) ?? { x: 0, y: 0 };
        a.x += force.x; a.y += force.y; b.x -= force.x; b.y -= force.y;
        forces.set(particle, a); forces.set(other, b);
      }
      let moving = false;
      const movedParents = new Set<Particle>();
      for (const particle of visible) {
        const force = forces.get(particle) ?? { x: 0, y: 0 };
        if (!awake.has(particle) && !force.x && !force.y) continue;
        let rect = rectOf(particle);
        const bounds = particle.bounds;
        // Naturally offscreen pieces stay in their document positions until
        // scrolling reveals them. Active pieces can cross container boundaries.
        const correction = keepInBounds(rect, bounds);
        if (rect.width > bounds.width || rect.height > bounds.height) { particle.velocity = { x: 0, y: 0 }; continue; }
        if (correction.x || correction.y) {
          particle.x += correction.x; particle.y += correction.y;
          rect = rectOf(particle);
          movedParents.add(particle);
        }
        let remaining = particle.lastStep ? Math.min((timestamp - particle.lastStep) / 1000, 1 / 15) : seconds;
        particle.lastStep = timestamp;
        while (remaining > 0.000001) {
          const dt = Math.min(remaining, 1 / 30);
          const next = stepShyPhysics(rect, particle.velocity, pointer, bounds, dt, [], force, 0.05);
          particle.velocity = next.velocity;
          particle.x += next.move.x; particle.y += next.move.y;
          if (next.move.x || next.move.y) movedParents.add(particle);
          if (Math.abs(next.move.x) + Math.abs(next.move.y) > 0.0000001 || Math.hypot(particle.velocity.x, particle.velocity.y) >= 0.5) moving = true;
          rect = rectOf(particle);
          remaining -= dt;
        }
      }
      // Child particles use world coordinates. Counter their parent's motion
      // so a letter moves once, rather than inheriting a second translation.
      renderChanged(movedParents);
      // Keep slower offscreen integration alive between its scheduled ticks.
      if (!moving && !offscreenDue) moving = ordered.some(particle => particle.visible && Math.hypot(particle.velocity.x, particle.velocity.y) >= 0.5);
      if (moving) frame = requestAnimationFrame(run);
      else lastFrame = 0;
    };
    const wake = () => { if (!disposed && !frame) frame = requestAnimationFrame(run); };
    const refresh = () => { generation++; workerNeedsStep = true; dirty = true; wake(); };
    const onPointer = (event: PointerEvent) => { if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return; pointer = { x: event.clientX, y: event.clientY }; inputVersion++; workerNeedsStep = true; wake(); };
    const leave = () => { pointer = null; inputVersion++; workerNeedsStep = true; wake(); };
    const blur = () => { generation++; workerNeedsStep = false; pointer = null; cancelAnimationFrame(frame); frame = 0; lastFrame = 0; for (const particle of particles.values()) particle.velocity = { x: 0, y: 0 }; };
    const onResize = () => {
      pageSizeDirty = true;
      for (const particle of particles.values()) {
        particle.x = 0; particle.y = 0; particle.velocity = { x: 0, y: 0 };
        particle.element.style.translate = particle.translate;
        particle.painted = '';
        particle.renderedX = 0; particle.renderedY = 0; particle.lastStep = 0;
      }
      refresh();
    };
    const onScroll = () => {
      const delta = window.scrollY - measuredScrollY;
      if (delta) {
        generation++; workerNeedsStep = true;
        flushPaint();
        for (const particle of particles.values()) {
          if (particle.anchored) {
            const rect = particle.element.getBoundingClientRect();
            particle.home.x = rect.x - particle.x;
            particle.home.y = rect.y - particle.y;
          } else particle.home.y -= delta;
          particle.bounds.y = 8 - window.scrollY;
        }
        measuredScrollY = window.scrollY;
      }
      // Nested scrollports and sticky/fixed pieces still need fresh geometry.
      if (!delta) refresh();
      else wake();
    };
    const visibility = () => { if (document.hidden) blur(); else refresh(); };
    const transition = (event: TransitionEvent) => { if (/transform|translate|scale|width|height|font/.test(event.propertyName)) refresh(); };
    const mutations = new MutationObserver(records => {
      // Live clocks use tabular digits with unchanged geometry. Updating their
      // glyphs in place avoids remeasuring every UI piece once per second.
      const clocks = records.filter(record => {
        if (record.type !== 'characterData') return false;
        const node = record.target as Text;
        const run = textRuns.get(node);
        return run && /^\d+:\d{2}$/.test(run.original) && /^\d+:\d{2}$/.test(node.data) && node.data.length === run.original.length &&
          run.wrapper.querySelectorAll('[data-shy-glyph]').length === node.data.length && getComputedStyle(run.wrapper).fontVariantNumeric.includes('tabular-nums');
      });
      if (clocks.length) {
        mutations.disconnect();
        for (const record of clocks) {
          const node = record.target as Text;
          const run = textRuns.get(node)!;
          const value = node.data;
          const glyphs = [...run.wrapper.querySelectorAll('[data-shy-glyph]')];
          if (glyphs.length === value.length) {
            for (let index = 0; index < glyphs.length; index++) if (glyphs[index].textContent !== value[index]) glyphs[index].textContent = value[index];
            run.original = value;
            run.wrapper.setAttribute('aria-label', value);
            node.data = '';
          }
        }
        observe();
        if (clocks.length === records.length) return;
      }
      if (records.some(record => record.type === 'childList' || record.type === 'characterData')) pageSizeDirty = true;
      if (records.some(record => record.target === document.documentElement && record.attributeName === 'data-backwards')) onResize();
      else refresh();
    });
    const resize = new ResizeObserver(refresh);
    try {
      const created = new Worker(new URL('../lib/shy-engine.worker.ts', import.meta.url));
      worker = created;
      created.onmessage = (event: MessageEvent<ShyEngineResponse | { ready: true; backend: 'wasm' | 'js' }>) => {
        if (disposed) return;
        if ('ready' in event.data) {
          workerReady = true; workerNeedsStep = true;
          stats.backend = event.data.backend;
          document.documentElement.setAttribute('data-shy-engine', event.data.backend);
          wake();
          return;
        }
        const result = event.data;
        inFlight = false; stats.pending = false;
        recycled = result.data;
        stats.backend = result.backend; stats.workerMs = result.durationMs; stats.steps++;
        document.documentElement.setAttribute('data-shy-engine', result.backend);
        if (result.generation === generation) {
          const changed = new Set<Particle>();
          let moving = false;
          for (let index = 0; index < submitted.length; index++) {
            const particle = submitted[index], offset = index * STRIDE;
            const x = result.data[offset + Field.X], y = result.data[offset + Field.Y];
            if (Math.abs(x - particle.x) + Math.abs(y - particle.y) > 0.0000001) { changed.add(particle); moving = true; }
            particle.x = x; particle.y = y;
            particle.velocity.x = result.data[offset + Field.VX]; particle.velocity.y = result.data[offset + Field.VY];
            if (result.data[offset + Field.ACTIVE]) particle.lastStep = submittedAt;
            if (Math.hypot(particle.velocity.x, particle.velocity.y) >= 0.5) moving = true;
          }
          renderChanged(changed);
          workerNeedsStep = moving || submittedVersion !== inputVersion;
        }
        if (workerNeedsStep && !document.hidden) wake();
        else lastFrame = 0;
      };
      created.onerror = () => {
        created.terminate(); worker = null; workerReady = false; inFlight = false;
        stats.pending = false; stats.backend = 'main-js';
        workerNeedsStep = true;
        document.documentElement.setAttribute('data-shy-engine', 'main-js');
        wake();
      };
    } catch {
      stats.backend = 'main-js';
      document.documentElement.setAttribute('data-shy-engine', 'main-js');
    }
    resize.observe(document.body);
    observe();
    refresh();
    document.fonts.ready.then(refresh);
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    window.addEventListener('blur', blur);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('animationend', refresh, true);
    window.addEventListener('animationcancel', refresh, true);
    window.addEventListener('transitionend', transition, true);
    window.addEventListener('transitioncancel', transition, true);
    return () => {
      disposed = true;
      worker?.terminate();
      delete debugWindow.__shyWorkerStats;
      document.documentElement.removeAttribute('data-shy-engine');
      cancelAnimationFrame(frame);
      mutations.disconnect(); resize.disconnect();
      document.documentElement.removeAttribute('data-shy-mode');
      document.documentElement.removeAttribute('data-shy-measuring');
      if (originalPageHeight) document.documentElement.style.setProperty('--shy-page-height', originalPageHeight);
      else document.documentElement.style.removeProperty('--shy-page-height');
      window.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', leave);
      window.removeEventListener('blur', blur);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('animationend', refresh, true);
      window.removeEventListener('animationcancel', refresh, true);
      window.removeEventListener('transitionend', transition, true);
      window.removeEventListener('transitioncancel', transition, true);
      for (const particle of particles.values()) restore(particle);
      for (const [node, text] of textRuns) { if (node.isConnected && !node.data) node.data = text.original; text.wrapper.remove(); }
    };
  }, []);
  return null;
}
