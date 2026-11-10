'use client';

import { useEffect, useState } from 'react';
import { errorMessage } from '@/client/api';
import type { NowCardStyle } from '@/lib/now-split';
import { ErrorText, Hint, Segmented } from './primitives';
import { Label } from './ui/label';

/** Beta key for the Now card setting: members get this choice, and the block and the split card it turns on (views/today.tsx). */
export const NOW_SPLIT_BETA = 'now-card-setting';

/** The account's choice. A context saved by the build with the on/off switch has only `nowSplit`. */
export function nowCardStyle(user: { nowCard?: NowCardStyle; nowSplit?: boolean }): NowCardStyle {
  return user.nowCard ?? (user.nowSplit ? 'split' : 'classic');
}

const STYLES: Array<{ value: NowCardStyle; label: string; hint: string }> = [
  { value: 'classic', label: 'Line', hint: 'A line under the countdown names your next class.' },
  { value: 'block', label: 'Block', hint: 'Your next class gets its own block along the bottom of the card.' },
  { value: 'split', label: 'Split', hint: 'The card makes room for your next class as the current one runs out.' },
];

/**
 * Account → Look, for members of the NOW_SPLIT_BETA beta: how Today's Now card shows the next class. The choice
 * belongs to the account, so it follows the member to every device and needs a connection to change.
 */
export function NowCardSetting({ accountId, value, online, onChange }: { accountId: string; value: NowCardStyle; online: boolean; onChange: (style: NowCardStyle) => Promise<void> }) {
  // The member's choice shows at once and stays until the workspace catches up.
  const [choice, setChoice] = useState<NowCardStyle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (choice !== null && choice === value && !busy) setChoice(null); }, [choice, value, busy]);
  useEffect(() => { setChoice(null); setError(''); }, [accountId]);
  const change = async (next: NowCardStyle) => {
    setBusy(true); setError(''); setChoice(next);
    try { await onChange(next); }
    catch (err) { setChoice(null); setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const shown = choice ?? value;
  return <div className="grid gap-1.5 border-t border-foreground/[0.06] pt-4">
    <Label className="text-[13px] font-semibold text-foreground/80">Next class on the Now card</Label>
    <Segmented<NowCardStyle> label="Next class on the Now card" value={shown} disabled={!online || busy} onChange={(next) => void change(next)}
      options={STYLES.map(({ value: style, label }) => ({ value: style, label }))} />
    <Hint>{online ? STYLES.find((style) => style.value === shown)!.hint : 'Connect to the internet to change this.'}</Hint>
    <ErrorText>{error}</ErrorText>
  </div>;
}
