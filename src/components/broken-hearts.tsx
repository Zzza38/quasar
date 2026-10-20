'use client';

import { useEffect } from 'react';
import { particleRepulsion, stepShyPhysics, type Point, type SpaceRect } from '@/lib/shy-motion';

const SECRET = 'savanah';
type Heart = { element: HTMLElement; rect: SpaceRect; velocity: Point };

export function BrokenHearts() {
  useEffect(() => {
    let entered = '';
    const bursts = new Map<HTMLElement, Heart[]>();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let pointer: Point | null = null;
    let frame = 0;
    let previousTime = 0;
    const reset = () => { entered = ''; };
    const onPointerMove = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
    const clearPointer = () => { pointer = null; };
    const onPointerOut = (event: PointerEvent) => { if (!event.relatedTarget) clearPointer(); };
    const startMotion = () => {
      if (!frame && bursts.size && !motion.matches) {
        previousTime = performance.now();
        frame = requestAnimationFrame(moveHearts);
      }
    };
    const onMotionChange = () => {
      if (motion.matches) { cancelAnimationFrame(frame); frame = 0; }
      else startMotion();
    };

    function moveHearts(time: number) {
      frame = 0;
      const seconds = Math.min((time - previousTime) / 1000, 1 / 30);
      previousTime = time;
      const bounds = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      for (const hearts of bursts.values()) {
        const forces = hearts.map(() => ({ x: 0, y: 0 }));
        for (let a = 0; a < hearts.length; a++) for (let b = a + 1; b < hearts.length; b++) {
          const force = particleRepulsion(hearts[a].rect, hearts[b].rect);
          forces[a].x += force.x; forces[a].y += force.y;
          forces[b].x -= force.x; forces[b].y -= force.y;
        }
        hearts.forEach((heart, index) => {
          // Keep cruising between cursor pushes instead of settling like the page's UI pieces.
          const speed = Math.hypot(heart.velocity.x, heart.velocity.y);
          if (speed < 90) {
            const angle = speed ? Math.atan2(heart.velocity.y, heart.velocity.x) : Math.random() * Math.PI * 2;
            heart.velocity = { x: Math.cos(angle) * 90, y: Math.sin(angle) * 90 };
          }
          const force = { x: forces[index].x + heart.velocity.x * 4.8, y: forces[index].y + heart.velocity.y * 4.8 };
          const next = stepShyPhysics(heart.rect, heart.velocity, pointer, bounds, seconds, [], force);
          heart.rect.x += next.move.x; heart.rect.y += next.move.y;
          heart.velocity = next.velocity;
          heart.element.style.transform = `translate(${heart.rect.x}px, ${heart.rect.y}px)`;
        });
      }
      if (bursts.size && !motion.matches) frame = requestAnimationFrame(moveHearts);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], [role="combobox"]')))) {
        reset();
        return;
      }

      entered = (entered + event.key.toLowerCase()).slice(-SECRET.length);
      if (entered !== SECRET) return;
      reset();

      // Bound simultaneous effects when the secret is entered repeatedly.
      if (bursts.size >= 3) removeBurst(bursts.keys().next().value!);
      const burst = document.createElement('div');
      burst.className = 'broken-hearts pointer-events-none fixed inset-0 z-[10001] overflow-hidden select-none';
      burst.setAttribute('aria-hidden', 'true');
      document.body.append(burst);
      const hearts: Heart[] = [];
      bursts.set(burst, hearts);
      const animations: Animation[] = [];
      for (let index = 0; index < 80; index++) {
        const heart = document.createElement('span');
        heart.textContent = '💔';
        heart.className = 'absolute left-0 top-0 grid place-items-center leading-none';
        const size = 30 + Math.random() * 34;
        heart.style.width = `${size}px`;
        heart.style.height = `${size}px`;
        heart.style.fontSize = `${size * 0.8}px`;
        const rect = { x: Math.random() * Math.max(0, window.innerWidth - size), y: Math.random() * Math.max(0, window.innerHeight - size), width: size, height: size };
        heart.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
        const angle = Math.random() * Math.PI * 2;
        const speed = 100 + Math.random() * 120;
        hearts.push({ element: heart, rect, velocity: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed } });
        burst.append(heart);
        animations.push(heart.animate([
          { opacity: 0 },
          { opacity: 1, offset: 0.05 },
          { opacity: 1, offset: 0.65 },
          { opacity: 0 },
        ], { duration: 7000 + Math.random() * 2000, easing: 'linear', fill: 'both' }));
      }
      startMotion();
      void Promise.all(animations.map(animation => animation.finished)).then(() => removeBurst(burst), () => removeBurst(burst));
    };

    function removeBurst(burst: HTMLElement) {
      bursts.delete(burst);
      burst.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
      burst.remove();
      if (!bursts.size) { cancelAnimationFrame(frame); frame = 0; }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', reset);
    window.addEventListener('focusin', reset);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerout', onPointerOut);
    window.addEventListener('blur', clearPointer);
    motion.addEventListener('change', onMotionChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', reset);
      window.removeEventListener('focusin', reset);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('blur', clearPointer);
      motion.removeEventListener('change', onMotionChange);
      for (const burst of bursts.keys()) removeBurst(burst);
    };
  }, []);

  return null;
}
