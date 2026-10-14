'use client';

import { useSyncExternalStore } from 'react';

let preference: MediaQueryList | undefined;
const media = () => preference ??= window.matchMedia('(prefers-reduced-motion: reduce)');
const subscribe = (listener: () => void) => {
  const query = media();
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};
// Avoid starting motion during hydration before the browser preference is known.
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => media().matches, () => true);
}
