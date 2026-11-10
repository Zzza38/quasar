'use client';

import { useEffect, useState } from 'react';
import { errorMessage } from '@/client/api';
import { ErrorText, Toggle } from './primitives';

/**
 * Account → Look: the switch that shares Today's Now card with the next class (NowSplitCard in views/today.tsx). The
 * choice belongs to the account, so it follows the member to every device and needs a connection to change.
 */
export function NowCardSetting({ accountId, enabled, online, onChange }: { accountId: string; enabled: boolean; online: boolean; onChange: (enabled: boolean) => Promise<void> }) {
  // The member's choice shows at once and stays until the workspace catches up.
  const [choice, setChoice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (choice !== null && choice === enabled && !busy) setChoice(null); }, [choice, enabled, busy]);
  useEffect(() => { setChoice(null); setError(''); }, [accountId]);
  const change = async (next: boolean) => {
    setBusy(true); setError(''); setChoice(next);
    try { await onChange(next); }
    catch (err) { setChoice(null); setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <div className="grid gap-2 border-t border-foreground/[0.06] pt-4">
    <Toggle label="Next class on the Now card" checked={choice ?? enabled} disabled={!online || busy} onChange={(next) => void change(next)}
      description={online ? 'Today’s card makes room for your next class as the current one runs out.' : 'Connect to the internet to change this.'} />
    <ErrorText>{error}</ErrorText>
  </div>;
}
