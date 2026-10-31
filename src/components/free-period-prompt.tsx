'use client';

import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { markFreePeriod, suggestedFreePeriodIds } from '@/domain/period-status';
import { cycleDaysWithPeriod, displayPeriodLabel, effectiveSchedule, UNASSIGNED_BLOCK_LABEL } from '@/domain/schedule';
import type { AppState } from './app-state';
import { Button, Callout, Modal, Spacer } from './primitives';

/** Blocks the student said are not free periods, kept on this device only. */
const declinedKey = (accountId: string) => `quasar-free-period-declined:${accountId}`;

function readDeclined(accountId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(declinedKey(accountId)) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** "Day 3, Day 6 and Day 10". */
const listDays = (days: string[]) => days.length < 2 ? days.join('') : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;

/**
 * Asks about each class block that is most likely a free period (suggestedFreePeriodIds), one at a time. Yes marks it
 * free (markFreePeriod) without the schedule lock prompt, since the student just answered; No is remembered on this
 * device; closing the dialog asks again on the next visit. Hidden while `paused`.
 */
export function FreePeriodPrompt({ state, paused }: { state: AppState; paused?: boolean }) {
  const accountId = state.context.user.id;
  // Read after hydration; null until then, so the server render never shows the dialog.
  const [declined, setDeclined] = useState<string[] | null>(null);
  useEffect(() => { setDeclined(readDeclined(accountId)); }, [accountId]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const { schedule, personal } = state;
  const periodId = useMemo(() => {
    if (!state.personalValid || !declined) return null;
    return [...suggestedFreePeriodIds(schedule, personal)].find((id) => !declined.includes(id) && !skipped.includes(id)) ?? null;
  }, [state.personalValid, declined, skipped, schedule, personal]);
  if (!periodId) return null;

  const effective = effectiveSchedule(schedule, personal);
  const label = displayPeriodLabel(effective.periods.find((period) => period.id === periodId), false);
  const name = label === UNASSIGNED_BLOCK_LABEL ? 'this empty block' : label;
  const days = effective.cycleDays.length > 1 ? cycleDaysWithPeriod(effective, personal, periodId) : [];
  const decline = () => {
    const next = [...(declined ?? []), periodId];
    try { localStorage.setItem(declinedKey(accountId), JSON.stringify(next)); } catch { /* private mode: it asks again next time */ }
    setDeclined(next); setError('');
  };
  const accept = async () => {
    if (pending) return;
    setPending(true); setError('');
    try { await state.saveConfirmed(markFreePeriod(personal, periodId)); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };

  return <Modal open={!paused} busy={pending} onClose={() => { setSkipped((list) => [...list, periodId]); setError(''); }}
    title={`Is ${name} a free period?`}
    description={days.length ? `It has no class on ${listDays(days)}.` : 'It has no class in it.'}
    footer={<><Button variant="ghost" disabled={pending} onClick={decline}>No, I have a class</Button><Spacer /><Button variant="primary" busy={pending} onClick={() => void accept()}>Yes, it’s free</Button></>}>
    <p className="text-sm text-muted-foreground">Say yes and it shows as a free period instead of an empty block. You can change it any time by tapping the period on Today.</p>
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </Modal>;
}
