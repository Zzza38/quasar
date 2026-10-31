import { z } from 'zod';

/** Former beta key, retained for retirement regression tests. Schedule following is available to everyone. */
export const SCHEDULE_FOLLOWING_BETA = 'schedule-following';

/**
 * Betas (src/server/betas.ts, README "Running a beta"). A beta key names the code path in the app: useBeta('key') and
 * <Beta id="key"> turn on only for members who joined that beta with its code.
 */
export const BETA_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const betaKeySchema = z.string().min(2).max(40).regex(BETA_KEY_PATTERN, 'Use lowercase letters, numbers and dashes for the key, like month-grid.');
/** Codes are typed by hand, so case, spaces and dashes don't matter: "Month Grid-26" and "monthgrid26" are the same code. */
export function normalizeBetaCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, '');
}
export const betaCodeSchema = z.string().max(64).refine(code => normalizeBetaCode(code).length >= 4, 'Codes have at least 4 letters or numbers.');

/** How many recent client errors a beta report carries (src/client/beta-diagnostics.ts). */
export const BETA_ERROR_LIMIT = 5;
/** What a beta report attaches. The member sees all of it before sending. */
export const betaDiagnosticsSchema = z.object({
  page: z.string().max(300),
  theme: z.string().max(40),
  viewport: z.string().max(40),
  browser: z.string().max(400),
  online: z.boolean(),
  betas: z.array(betaKeySchema).max(50),
  errors: z.array(z.string().max(500)).max(BETA_ERROR_LIMIT),
  at: z.string().max(40),
});
export type BetaDiagnostics = z.infer<typeof betaDiagnosticsSchema>;
/** The diagnostics as stored with the request: the client's, plus the build the server was running when it arrived. */
export type StoredBetaDiagnostics = BetaDiagnostics & { build: string };

/** The support request kind for feedback about a beta. */
export const betaRequestKind = (key: string) => `beta:${key}` as const;
