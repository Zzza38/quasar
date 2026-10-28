/**
 * What a running timetable scan is doing, so the browser can show more than a spinner while the model reads. The scan
 * mutation reports into this in-process map under an ID the browser picked, and the browser polls scan.progress for it.
 * Polling (not a streamed response) keeps it working through response compression and the Cloudflare tunnel.
 */
export type ScanCloseUp = { photo: number; left: number; top: number; width: number; height: number; enhance?: boolean; rotate?: number };
/**
 * `reading`: the model is reading the photos (round 0) or its close-ups (round 1 and later). `zooming`: the server is
 * cutting the close-ups the model asked for. `checking`: the answer is being matched to the school's periods and directory.
 */
export type ScanProgress = { stage: 'reading' | 'zooming' | 'checking'; round: number; closeUps: ScanCloseUp[] };
export type ScanReporter = (progress: ScanProgress) => void;

/** A scan gives up after 110 s; anything older than this was left behind by a crashed request. */
const STALE_MS = 5 * 60_000;
const globals = globalThis as typeof globalThis & { quasarScanProgress?: Map<string, { progress: ScanProgress; at: number }> };
const running = globals.quasarScanProgress ??= new Map();
const key = (accountId: string, progressId: string) => `${accountId}:${progressId}`;

/** Runs a scan with its progress readable by the same account under `progressId`, and forgets it when the scan ends. */
export async function withScanProgress<T>(accountId: string, progressId: string | undefined, run: (report?: ScanReporter) => Promise<T>): Promise<T> {
  if (!progressId) return run();
  const id = key(accountId, progressId);
  const now = Date.now();
  for (const [other, entry] of running) if (now - entry.at > STALE_MS) running.delete(other);
  try {
    return await run(progress => { running.set(id, { progress, at: Date.now() }); });
  } finally { running.delete(id); }
}

/** The account's own scan only: another account asking for the same ID gets null. */
export function scanProgress(accountId: string, progressId: string): ScanProgress | null {
  return running.get(key(accountId, progressId))?.progress ?? null;
}
