'use client';

import { useEffect } from 'react';

const SECRET = 'savanah';

export function BrokenHearts() {
  useEffect(() => {
    let entered = '';
    const bursts = new Set<HTMLElement>();
    const reset = () => { entered = ''; };
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
      if (bursts.size >= 3) removeBurst(bursts.values().next().value!);
      const burst = document.createElement('div');
      burst.className = 'broken-hearts pointer-events-none fixed inset-0 z-[10001] overflow-hidden select-none';
      burst.setAttribute('aria-hidden', 'true');
      document.body.append(burst);
      bursts.add(burst);
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animations: Animation[] = [];
      for (let index = 0; index < 36; index++) {
        const heart = document.createElement('span');
        heart.textContent = '💔';
        heart.className = 'absolute';
        heart.style.left = `${5 + Math.random() * 90}%`;
        heart.style.top = `${10 + Math.random() * 80}%`;
        heart.style.fontSize = `${24 + Math.random() * 32}px`;
        burst.append(heart);
        const drift = (Math.random() - 0.5) * 180;
        const rise = 80 + Math.random() * 180;
        const turn = (Math.random() - 0.5) * 80;
        animations.push(heart.animate([
          { opacity: 0, transform: reducedMotion ? 'none' : 'translate(-50%, -50%) scale(0.65)' },
          { opacity: 1, offset: 0.15 },
          { opacity: 0, transform: reducedMotion ? 'none' : `translate(calc(-50% + ${drift}px), calc(-50% - ${rise}px)) rotate(${turn}deg) scale(1.15)` },
        ], { duration: 1800 + Math.random() * 1200, easing: 'ease-out', fill: 'both' }));
      }
      void Promise.all(animations.map(animation => animation.finished)).then(() => removeBurst(burst), () => removeBurst(burst));
    };

    function removeBurst(burst: HTMLElement) {
      bursts.delete(burst);
      burst.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
      burst.remove();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', reset);
    window.addEventListener('focusin', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', reset);
      window.removeEventListener('focusin', reset);
      bursts.forEach(removeBurst);
    };
  }, []);

  return null;
}
