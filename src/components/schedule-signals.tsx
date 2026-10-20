'use client';

import { SCHEDULE_FOLLOWING_BETA } from '@/domain/betas';
import { useBeta } from './betas';

import { useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { formatTime } from '@/lib/format';
import type { AppState } from './app-state';
import type { ProposalSeed } from './proposals';
import { Button, Callout, Hint, Section } from './primitives';

type Signals = RouterOutput['scheduleSignals']['list'];

export function ScheduleSignalsSection({ state, onPropose }: { state: AppState; onPropose: (seed: ProposalSeed) => void }) {
  const following = useBeta(SCHEDULE_FOLLOWING_BETA);
  const [loaded, setLoaded] = useState<{ accountId: string; schoolId: string; value: Signals } | null>(null);
  const [error, setError] = useState('');
  const accountId = state.context.user.id;
  const schoolId = state.context.school.id;
  const version = state.context.school.version;
  const grade = state.personal.grade;
  const recurringChanges = JSON.stringify(state.personal.cycleDayOverrides);
  const privateCopy = !!state.personal.customSchedule;
  useEffect(() => {
    let active = true;
    setLoaded(null); setError('');
    if (!following || !state.online) return;
    const refresh = () => api.scheduleSignals.list.query().then(value => {
      if (active) { setLoaded({ accountId, schoolId, value }); setError(''); }
    }, err => { if (active) { setLoaded(null); setError(errorMessage(err)); } });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [accountId, schoolId, version, grade, recurringChanges, privateCopy, state.online, following]);
  const board = loaded?.accountId === accountId && loaded.schoolId === schoolId && loaded.value.baseVersion === version && loaded.value.grade === grade ? loaded.value : null;
  if (!following || !state.online || (!error && !board?.signals.length)) return null;
  return <Section title="Schedule suggestions" icon="users" description="Anonymous timing patterns from classmates in your grade. A suggestion needs at least three matching classmates.">
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    {board && <>
      <ul className="grid gap-3">{board.signals.map(signal => <li key={JSON.stringify([signal.cycleDayId, signal.slotId, signal.start, signal.end])} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 p-3">
        <div><p className="text-sm font-semibold">{signal.count} classmates moved this block. Propose it?</p><Hint>{signal.cycleDayLabel} · {signal.periodLabel} · {formatTime(signal.start)} to {formatTime(signal.end)}</Hint></div>
        <Button size="sm" disabled={!board.canPropose} onClick={() => onPropose({ schedule: signal.draft, summary: signal.summary, baseVersion: board.baseVersion })}>Review proposal</Button>
      </li>)}</ul>
      <Hint>{board.canPropose ? 'Review the draft before submitting. The usual member voting requirements still apply.' : 'Verified members can propose changes once the shared schedule is member locked.'}</Hint>
    </>}
  </Section>;
}
