export { cn } from "cn"

/**
 * Scrolls the element with this id into view, instantly when the user prefers reduced motion.
 * With `focus`, moves keyboard focus there too (adding tabIndex -1 if needed), unless it is hidden.
 */
export function scrollToId(id: string, focus = false): void {
  if (typeof document === 'undefined') return;
  const element = document.getElementById(id);
  if (!element) return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  if (!focus || !element.getClientRects().length) return;
  if (!element.hasAttribute('tabindex')) element.tabIndex = -1;
  element.focus({ preventScroll: true });
}
