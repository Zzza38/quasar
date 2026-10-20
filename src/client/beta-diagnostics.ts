import { BETA_ERROR_LIMIT, type BetaDiagnostics } from '@/domain/betas';

/**
 * The last few client errors on this page, kept in memory only, for beta reports (src/components/betas.tsx). Nothing
 * is sent anywhere unless a member in a beta reads the report and presses Send.
 */
const errors: string[] = [];
let installed = false;

export function recordBetaError(message: string): void {
  const text = message.trim().slice(0, 500);
  if (!text) return;
  errors.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  if (errors.length > BETA_ERROR_LIMIT) errors.splice(0, errors.length - BETA_ERROR_LIMIT);
}

/** Starts collecting uncaught errors and rejections. Safe to call more than once. */
export function installBetaErrorBuffer(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => recordBetaError(event.message || String(event.error ?? 'Unknown error')));
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    recordBetaError(reason instanceof Error ? reason.message : String(reason));
  });
}

/** What a beta report attaches, read at the moment the report opens. Path only: query strings can carry IDs. */
export function collectBetaDiagnostics(betas: string[]): BetaDiagnostics {
  const root = document.documentElement.dataset;
  const theme = `${root.appearance ?? 'unknown'}${root.appearancePreference ? ` (${root.appearancePreference})` : ''}`;
  return {
    page: window.location.pathname.slice(0, 300),
    theme: theme.slice(0, 40),
    viewport: `${window.innerWidth}×${window.innerHeight} @${Math.round(window.devicePixelRatio * 100) / 100}x`.slice(0, 40),
    browser: navigator.userAgent.slice(0, 400),
    online: navigator.onLine,
    betas: betas.slice(0, 50),
    errors: [...errors],
    at: new Date().toISOString(),
  };
}

/** For tests. */
export function clearBetaErrors(): void {
  errors.length = 0;
}
