import { describe, expect, it } from 'vitest';
import { scanProgress, withScanProgress } from './scan-progress';

const ID = '7b0f9c52-3c1e-4f4e-9d6a-1f2e3d4c5b6a';

describe('scan progress', () => {
  it('shows a running scan to its own account only, and forgets it when the scan ends', async () => {
    let seen: ReturnType<typeof scanProgress> = null, other: ReturnType<typeof scanProgress> = null;
    const result = await withScanProgress('alice', ID, async report => {
      report?.({ stage: 'reading', round: 0, closeUps: [] });
      seen = scanProgress('alice', ID);
      other = scanProgress('bob', ID);
      return 'done';
    });
    expect(result).toBe('done');
    expect(seen).toEqual({ stage: 'reading', round: 0, closeUps: [] });
    expect(other).toBeNull();
    expect(scanProgress('alice', ID)).toBeNull();
  });

  it('forgets a failed scan too, and runs without a reporter when the browser sent no ID', async () => {
    await expect(withScanProgress('alice', ID, async report => { report?.({ stage: 'checking', round: 0, closeUps: [] }); throw new Error('upstream'); })).rejects.toThrow('upstream');
    expect(scanProgress('alice', ID)).toBeNull();
    await withScanProgress('alice', undefined, async report => { expect(report).toBeUndefined(); });
  });
});
