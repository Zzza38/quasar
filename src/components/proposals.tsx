'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { GRADES, applyScheduleToGrades, gradeLabel, scheduleForGrade, scheduleSchema, type Grade, type Schedule } from '@/domain/schedule';
import { formatDate, pluralize } from '@/lib/format';
import type { AppState } from './app-state';
import { Icon } from './icon';
import { describeIssues, ScheduleEditor, ScheduleSummary } from './schedule-editor';
import { Button, Callout, Chip, Field, Hint, Modal, Panel, Section, Segmented, Spacer, Textarea } from './primitives';
import { Label } from './ui/label';

type Board = RouterOutput['proposals']['list'];
type Proposal = Board['proposals'][number];

const STATUS: Record<Proposal['status'], { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'outline' }> = {
  open: { label: 'Voting open', tone: 'accent' },
  passed: { label: 'Passed and published', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'outline' },
  superseded: { label: 'Superseded by a newer revision', tone: 'outline' },
  'awaiting-support': { label: 'Passed · waiting for support', tone: 'warning' },
  declined: { label: 'Declined by support', tone: 'danger' },
};

/** Voting on shared-schedule changes for schools whose editing is locked. */
export function ProposalsSection({ state }: { state: AppState }) {
  const { context, online } = state;
  const accountId = context.user.id;
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const refresh = useCallback(async () => {
    if (!online) return;
    try { setBoard(await api.proposals.list.query()); } catch (err) { setError(errorMessage(err)); }
  }, [online]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); setError('');
    try { await action(); await refresh(); await state.refresh(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const verified = context.community?.verification.status === 'verified';
  const open = (board?.proposals ?? []).filter(entry => entry.status === 'open' || entry.status === 'awaiting-support');
  const closed = (board?.proposals ?? []).filter(entry => entry.status !== 'open' && entry.status !== 'awaiting-support');

  return <Section id="proposals-title" title="Proposed changes" icon="users"
    description={board ? `Verified members vote on changes. A proposal passes with ${board.threshold} votes for and more for than against (${pluralize(board.verifiedMembers, 'verified member')}).` : 'Verified members vote on changes to the shared schedule.'}
    action={board?.canPropose ? <Button size="sm" icon="plus" disabled={!online || pending} onClick={() => setComposing(true)}>Propose a change</Button> : undefined}>
    {!online && <Hint>Connect to see and vote on proposals.</Hint>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {board && !verified && <Callout tone="info" icon="checkCircle" actions={<Button size="sm" onClick={() => state.navigate('people')}>Verify my school</Button>}>Verify your school membership to propose changes and vote.</Callout>}
    {board && open.length === 0 && <Hint>No open proposals. {board.canPropose ? 'Spotted something wrong in the shared schedule? Propose a fix, or send a correction to support.' : ''}</Hint>}
    {open.length > 0 && <ul className="grid gap-3">{open.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} mine={proposal.proposerId === accountId} canVote={!!board?.canVote} pending={pending || !online} school={state.schedule} grade={state.personal.grade}
      onVote={vote => run(() => api.proposals.vote.mutate({ accountId, proposalId: proposal.id, vote }))}
      onWithdraw={() => run(() => api.proposals.withdraw.mutate({ accountId, proposalId: proposal.id }))} />)}</ul>}
    {closed.length > 0 && <div className="grid gap-2">
      <button type="button" className="inline-flex w-fit items-center gap-1 text-left text-sm font-semibold text-primary hover:underline" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Hide' : 'Show'} {pluralize(closed.length, 'closed proposal')}<Icon name="chevronDown" size={14} className={showClosed ? 'rotate-180 transition-transform' : 'transition-transform'} /></button>
      {showClosed && <ul className="grid gap-2">{closed.map(proposal => <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2 text-sm"><span className="min-w-0 flex-1"><strong className="font-semibold">{proposal.summary}</strong><Hint>{proposal.proposerName} · {formatDate(proposal.createdAt.slice(0, 10), { year: true })} · {proposal.votesFor} for, {proposal.votesAgainst} against</Hint></span><Chip tone={STATUS[proposal.status].tone}>{STATUS[proposal.status].label}</Chip></li>)}</ul>}
    </div>}
    {composing && <ComposeProposal state={state} onClose={() => setComposing(false)} onSaved={async () => { setComposing(false); await refresh(); }} />}
  </Section>;
}

function ProposalCard({ proposal, mine, canVote, pending, school, grade, onVote, onWithdraw }: { proposal: Proposal; mine: boolean; canVote: boolean; pending: boolean; school: Schedule; grade?: Grade; onVote: (vote: 'for' | 'against') => Promise<void>; onWithdraw: () => Promise<void> }) {
  const [preview, setPreview] = useState(false);
  const status = STATUS[proposal.status];
  const progress = Math.min(100, Math.round((proposal.votesFor / proposal.threshold) * 100));
  return <li className="grid gap-3 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1 basis-[240px]"><strong className="text-sm font-bold">{proposal.summary}</strong><Hint>Proposed by {mine ? 'you' : proposal.proposerName} · {formatDate(proposal.createdAt.slice(0, 10))} · based on revision {proposal.baseVersion}</Hint></div>
      <Chip tone={status.tone}>{status.label}</Chip>
    </div>
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-xs font-semibold tabular-nums"><span>{proposal.votesFor} for · {proposal.votesAgainst} against</span><span className="text-muted-foreground">{proposal.threshold} needed</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-foreground/[0.06]" role="progressbar" aria-valuemin={0} aria-valuemax={proposal.threshold} aria-valuenow={proposal.votesFor} aria-label="Votes for"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
    </div>
    {proposal.status === 'awaiting-support' && <Callout tone="warning" icon="lock">This schedule is locked by support. The vote passed, so support now decides whether to publish it.</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      {proposal.status === 'open' && canVote && <>
        <Button size="sm" variant={proposal.myVote === 'for' ? 'primary' : 'secondary'} icon="check" disabled={pending} aria-pressed={proposal.myVote === 'for'} onClick={() => void onVote('for')}>For</Button>
        <Button size="sm" variant={proposal.myVote === 'against' ? 'danger' : 'secondary'} icon="x" disabled={pending} aria-pressed={proposal.myVote === 'against'} onClick={() => void onVote('against')}>Against</Button>
      </>}
      {proposal.status === 'open' && mine && <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (confirm('Withdraw this proposal? Votes already cast are discarded.')) void onWithdraw(); }}>Withdraw</Button>}
      <Spacer />
      <Button size="sm" variant="ghost" iconRight="chevronDown" aria-expanded={preview} onClick={() => setPreview(!preview)}>{preview ? 'Hide proposed schedule' : 'See proposed schedule'}</Button>
    </div>
    {preview && <div className="grid gap-3 lg:grid-cols-2">
      <Panel className="grid gap-2"><Hint className="font-bold uppercase tracking-wide">Current{grade ? ` · ${gradeLabel(grade)}` : ''}</Hint><ScheduleSummary schedule={school} /></Panel>
      <Panel className="grid gap-2 ring-2 ring-primary/30"><Hint className="font-bold uppercase tracking-wide">Proposed</Hint><ScheduleSummary schedule={scheduleForGrade(proposal.schedule, grade)} /></Panel>
    </div>}
  </li>;
}

function ComposeProposal({ state, onClose, onSaved }: { state: AppState; onClose: () => void; onSaved: () => Promise<void> }) {
  const { context, personal } = state;
  const school = context.school;
  const [grade, setGrade] = useState<Grade>(personal.grade ?? '9');
  const [draft, setDraft] = useState<Schedule>(() => structuredClone(scheduleForGrade(school.schedule, personal.grade ?? '9')));
  const [summary, setSummary] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const issues = describeIssues(draft);
  const unchanged = JSON.stringify(draft) === JSON.stringify(scheduleForGrade(school.schedule, grade));
  return <Modal open onClose={onClose} wide fullWidth title="Propose a schedule change" description="Verified members of your school vote on your proposal. If it passes, the shared schedule updates for everyone; personal classes and adjustments are never changed."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={issues.length > 0 || unchanged || summary.trim().length < 10} onClick={async () => {
      setPending(true); setError('');
      try {
        await api.proposals.create.mutate({ accountId: context.user.id, schoolId: school.id, baseVersion: school.version, schedule: scheduleSchema.parse(applyScheduleToGrades(school.schedule, draft, [grade])), summary: summary.trim() });
        await onSaved();
      } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>Open the vote</Button></>}>
    <div className="grid gap-4 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04] lg:grid-cols-2">
      <Field label="What changes and why?" htmlFor="proposal-summary" hint="At least 10 characters. Everyone sees this next to the vote."><Textarea id="proposal-summary" rows={3} minLength={10} maxLength={1000} value={summary} onChange={event => setSummary(event.target.value)} placeholder="Example: Day 3 lunch moved to 11:20–11:50 in the new bell schedule (see the district PDF)." /></Field>
      <div className="grid gap-2">
        <Label className="text-[13px] font-semibold text-foreground/80">Grade schedule to change</Label>
        <Segmented<Grade> label="Grade schedule to change" value={grade} disabled={pending} options={GRADES.map(entry => ({ value: entry, label: gradeLabel(entry) }))} onChange={entry => { setGrade(entry); setDraft(structuredClone(scheduleForGrade(school.schedule, entry))); }} />
        <Hint>A proposal changes one grade’s schedule at a time. It is built on revision {school.version}.</Hint>
      </div>
    </div>
    <ScheduleEditor key={grade} value={draft} onChange={setDraft} disabled={pending} />
    {unchanged && <Hint>Make a change to the schedule above to open a vote.</Hint>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
