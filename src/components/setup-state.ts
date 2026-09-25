/**
 * Per-device memory of where a student is in setup. It only decides which nudges to show;
 * the schedule and classes themselves live in the synced workspace.
 */

const key = (name: string, userId: string) => `quasar.setup.${name}.${userId}`;

function read(name: string, userId: string): boolean {
  try { return localStorage.getItem(key(name, userId)) === '1'; } catch { return false; }
}

function write(name: string, userId: string, on: boolean): void {
  try { on ? localStorage.setItem(key(name, userId), '1') : localStorage.removeItem(key(name, userId)); } catch { /* private mode */ }
}

/** Set when a student joins a school, so the "add your classes" step follows immediately. */
export const classesStep = {
  pending: (userId: string) => read('classes', userId),
  begin: (userId: string) => write('classes', userId, true),
  finish: (userId: string) => write('classes', userId, false),
};

/** Set when the classes step ends, so the homework calendar step follows it. */
export const feedStep = {
  pending: (userId: string) => read('feed', userId),
  begin: (userId: string) => write('feed', userId, true),
  finish: (userId: string) => write('feed', userId, false),
};

/** Manual ticks and the dismissal of the Today setup checklist. */
export const checklist = {
  dismissed: (userId: string) => read('checklist-dismissed', userId),
  dismiss: (userId: string) => write('checklist-dismissed', userId, true),
  ticked: (item: string, userId: string) => read(`tick-${item}`, userId),
  tick: (item: string, userId: string, on = true) => write(`tick-${item}`, userId, on),
};

/** Forgets every setup flag of this account on this device (for sign-out), so none reveals who used it. */
export function clearSetupState(userId: string): void {
  try {
    const suffix = `.${userId}`;
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const name = localStorage.key(index);
      if (name?.startsWith('quasar.setup.') && name.endsWith(suffix)) keys.push(name);
    }
    for (const name of keys) localStorage.removeItem(name);
  } catch { /* private mode */ }
}

/** True when the page runs as an installed app rather than in a browser tab. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

/** Whether the "add to home screen" advice should be the iOS one. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
