'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { GRADES, applyScheduleToGrades, gradeLabel, scheduleForGrade, scheduleSchema, type Grade, type Schedule } from '@/domain/schedule';
import { formatDate, instantParts, pluralize } from '@/lib/format';
import type { AppState } from './app-state';
import { Icon } from './icon';
import { ChangeList, describeScheduleChanges } from './conflicts';
import { describeIssues, ScheduleEditor } from './schedule-editor';
import { Button, Callout, Chip, Field, Hint, Modal, Panel, Section, Segmented, Spacer, Textarea } from './primitives';
import { Label } from './ui/label';

type Board = RouterOutput['proposals']['list'];
type Proposal = Board['proposals'][number];

/** What the board's error Callout shows, and whether a failed action or a failed reload put it there. */
export type BoardError = { text: string; from: 'action' | 'load' } | null;
export type BoardErrorEvent = { type: 'action-start' } | { type: 'action-failed'; text: string } | { type: 'loaded' } | { type: 'load-failed'; text: string };

/**
 * Why a vote or withdraw failed outlives the reloads that follow it, including the one a new schedule revision
 * triggers (usually the very revision that closed the proposal); only the student's next action clears it. A
 * failed reload shows until a reload succeeds, but never hides an action's failure.
 */
export function nextBoardError(current: BoardError, event: BoardErrorEvent): BoardError {
  switch (event.type) {
    case 'action-start': return null;
    case 'action-failed': return { text: event.text, from: 'action' };
    case 'loaded': return current?.from === 'load' ? null : current;
    case 'load-failed': return current?.from === 'action' ? current : { text: event.text, from: 'load' };
  }
}

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
  const [error, setError] = useState<BoardError>(null);
  const report = (event: BoardErrorEvent) => setError(current => nextBoardError(current, event));
  const [pending, setPending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const version = context.school.version;
  /** Reloads the board, keeping any action's failure on screen (see nextBoardError). */
  const refresh = useCallback(async () => {
    if (!online) return;
    try { setBoard(await api.proposals.list.query()); setError(current => nextBoardError(current, { type: 'loaded' })); } catch (err) { const text = errorMessage(err); setError(current => nextBoardError(current, { type: 'load-failed', text })); }
  }, [online]);
  // A new schedule revision closes or supersedes proposals, so the board reloads with it.
  useEffect(() => { void refresh(); }, [refresh, version]);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); report({ type: 'action-start' });
    // A failed vote or withdraw usually means the proposal closed elsewhere, so the board reloads either way.
    try { await action(); await refresh(); await state.refresh(); } catch (err) { report({ type: 'action-failed', text: errorMessage(err) }); await refresh(); } finally { setPending(false); }
  };
  const verified = context.community?.verification.status === 'verified';
  const open = (board?.proposals ?? []).filter(entry => entry.status === 'open' || entry.status === 'awaiting-support');
  const closed = (board?.proposals ?? []).filter(entry => entry.status !== 'open' && entry.status !== 'awaiting-support');

  return <Section id="proposals-title" title="Proposed changes" icon="users"
    description={board ? `Verified members vote on changes. A change passes with at least ${pluralize(board.threshold, 'vote')} for, as long as more members vote for it than against. ${pluralize(board.verifiedMembers, 'verified member')} can vote.` : 'Verified members vote on changes to the shared schedule.'}
    action={board?.canPropose ? <Button size="sm" icon="plus" disabled={!online || pending} onClick={() => setComposing(true)}>Propose a change</Button> : undefined}>
    {!online && <Hint>Connect to see and vote on proposals.</Hint>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error.text}</Callout>}
    {board && !verified && <Callout tone="info" icon="checkCircle" actions={<Button size="sm" onClick={() => state.navigate('people')}>Verify my school</Button>}>Verify your school membership to propose changes and vote.</Callout>}
    {board && open.length === 0 && <Hint>No open proposals. {board.canPropose ? 'Spotted something wrong in the shared schedule? Propose a fix, or send a correction to support.' : ''}</Hint>}
    {open.length > 0 && <ul className="grid gap-3">{open.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} timeZone={state.timeZone} mine={proposal.proposerId === accountId} canVote={!!board?.canVote} pending={pending} online={online} current={context.school.schedule} currentVersion={context.school.version} grade={state.personal.grade}
      onVote={vote => run(() => api.proposals.vote.mutate({ accountId, proposalId: proposal.id, vote }))}
      onWithdraw={() => run(() => api.proposals.withdraw.mutate({ accountId, proposalId: proposal.id }))} />)}</ul>}
    {closed.length > 0 && <div className="grid gap-2">
      <button type="button" className="inline-flex w-fit items-center gap-1 text-left text-sm font-semibold text-primary hover:underline" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Hide' : 'Show'} {pluralize(closed.length, 'closed proposal')}<Icon name="chevronDown" size={14} className={showClosed ? 'rotate-180 transition-transform' : 'transition-transform'} /></button>
      {showClosed && <ul className="grid gap-2">{closed.map(proposal => <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2 text-sm"><span className="min-w-0 flex-1"><strong className="font-semibold">{proposal.summary}</strong><Hint>{proposal.proposerName} · {formatDate(instantParts(proposal.createdAt, state.timeZone).date, { year: true })} · {proposal.votesFor} for, {proposal.votesAgainst} against</Hint></span><Chip tone={STATUS[proposal.status].tone}>{STATUS[proposal.status].label}</Chip></li>)}</ul>}
    </div>}
    {composing && <ComposeProposal state={state} onClose={() => setComposing(false)} onSaved={async () => { setComposing(false); await refresh(); }} />}
  </Section>;
}

type ChangeGroup = { grades: Grade[]; changes: string[] };

/** What the proposal changes against the live schedule, grouped by grades with identical changes, viewer's grade first. */
function proposalChanges(current: Schedule, proposed: Schedule, viewer?: Grade): ChangeGroup[] {
  const order = viewer ? [viewer, ...GRADES.filter(entry => entry !== viewer)] : [...GRADES];
  const groups: ChangeGroup[] = [];
  for (const entry of order) {
    const changes = describeScheduleChanges(scheduleForGrade(current, entry), scheduleForGrade(proposed, entry));
    if (changes.length === 0) continue;
    const same = groups.find(group => JSON.stringify(group.changes) === JSON.stringify(changes));
    if (same) same.grades.push(entry); else groups.push({ grades: [entry], changes });
  }
  return groups;
}

function ProposalCard({ proposal, timeZone, mine, canVote, pending, online, current, currentVersion, grade, onVote, onWithdraw }: { proposal: Proposal; timeZone: string; mine: boolean; canVote: boolean; pending: boolean; online: boolean; current: Schedule; currentVersion: number; grade?: Grade; onVote: (vote: 'for' | 'against') => Promise<void>; onWithdraw: () => Promise<void> }) {
  const [preview, setPreview] = useState(false);
  /** The Withdraw confirmation is open (docs/CHAT.md §Dialogs: a Modal, not confirm()). */
  const [withdrawing, setWithdrawing] = useState(false);
  const blocked = pending || !online;
  const status = STATUS[proposal.status];
  const progress = Math.min(100, Math.round((proposal.votesFor / proposal.threshold) * 100));
  const short = Math.max(0, proposal.threshold - proposal.votesFor);
  const needed = short > 0 ? `${pluralize(short, 'more vote')} needed` : proposal.votesFor > proposal.votesAgainst ? 'Enough votes' : 'Needs more votes for than against';
  const groups = preview ? proposalChanges(current, proposal.schedule, grade) : [];
  return <li className="grid gap-3 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1 basis-[240px]"><strong className="text-sm font-bold">{proposal.summary}</strong><Hint>Proposed by {mine ? 'you' : proposal.proposerName} · {formatDate(instantParts(proposal.createdAt, timeZone).date)} · based on revision {proposal.baseVersion}</Hint></div>
      <Chip tone={status.tone}>{status.label}</Chip>
    </div>
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs font-semibold tabular-nums"><span>{proposal.votesFor} for · {proposal.votesAgainst} against</span><span className="text-muted-foreground">{needed}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-foreground/[0.06]" role="progressbar" aria-valuemin={0} aria-valuemax={proposal.threshold} aria-valuenow={proposal.votesFor} aria-label="Votes for"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
    </div>
    {proposal.status === 'awaiting-support' && <Callout tone="warning" icon="lock">This schedule is locked by support. The vote passed, so support now decides whether to publish it.</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      {proposal.status === 'open' && canVote && <>
        <Button size="sm" variant={proposal.myVote === 'for' ? 'primary' : 'secondary'} icon="check" disabled={blocked} aria-pressed={proposal.myVote === 'for'} onClick={() => void onVote('for')}>For</Button>
        <Button size="sm" variant={proposal.myVote === 'against' ? 'danger' : 'secondary'} icon="x" disabled={blocked} aria-pressed={proposal.myVote === 'against'} onClick={() => void onVote('against')}>Against</Button>
      </>}
      {proposal.status === 'open' && mine && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => setWithdrawing(true)}>Withdraw</Button>}
      <Spacer />
      <Button size="sm" variant="ghost" iconRight="chevronDown" aria-expanded={preview} onClick={() => setPreview(!preview)}>{preview ? 'Hide proposed schedule' : 'See proposed schedule'}</Button>
    </div>
    {withdrawing && proposal.status === 'open' && mine && <WithdrawModal online={online} onClose={() => setWithdrawing(false)} onWithdraw={onWithdraw} />}
    {preview && <Panel className="grid gap-3 ring-2 ring-primary/30">
      {groups.length === 0 && <><Hint className="font-bold uppercase tracking-wide">Proposed changes</Hint><Hint>No differences from the current schedule.</Hint></>}
      {groups.map(group => <div key={group.grades.join()} className="grid gap-1.5">
        <Hint className="font-bold uppercase tracking-wide">Proposed changes{group.grades.length < GRADES.length ? ` for ${group.grades.map(gradeLabel).join(', ')}` : ''}{grade && group.grades.includes(grade) && group.grades.length < GRADES.length ? ' (your grade)' : ''}</Hint>
        <ChangeList changes={group.changes} />
      </div>)}
      {proposal.baseVersion !== currentVersion && <Hint>The shared schedule is now on revision {currentVersion}, so some of these differences may come from updates made after this proposal.</Hint>}
    </Panel>}
  </li>;
}

/** Confirms withdrawing your own open proposal. Only this withdraw in flight locks it; going offline just disables the confirm button. */
function WithdrawModal({ online, onClose, onWithdraw }: { online: boolean; onClose: () => void; onWithdraw: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // onWithdraw never throws: the board shows its failure once this closes.
  const confirm = async () => { setBusy(true); try { await onWithdraw(); } finally { setBusy(false); onClose(); } };
  return <Modal open onClose={onClose} busy={busy} title="Withdraw this proposal?" description="Votes already cast are discarded."
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Keep it</Button><Spacer /><Button variant="danger" busy={busy} disabled={!online} onClick={() => void confirm()}>Withdraw proposal</Button></>}>
    {!online && <Hint>Connect to withdraw this proposal.</Hint>}
  </Modal>;
}

function ComposeProposal({ state, onClose, onSaved }: { state: AppState; onClose: () => void; onSaved: () => Promise<void> }) {
  const { context, personal } = state;
  const school = context.school;
  // Frozen when the sheet opens, so the proposal records the revision its author actually saw (the background
  // sync would otherwise move it under them) and the server can reject it as stale.
  const [base, setBase] = useState(() => ({ version: school.version, schedule: school.schedule }));
  const [adopt, setAdopt] = useState(false);
  if (adopt) {
    setAdopt(false);
    if (school.version !== base.version) setBase({ version: school.version, schedule: school.schedule });
  }
  const [grade, setGrade] = useState<Grade>(personal.grade ?? '9');
  // One draft per grade, so switching grades never throws edits away; only the selected grade is submitted.
  const [drafts, setDrafts] = useState<Partial<Record<Grade, Schedule>>>({});
  const baseFor = (entry: Grade) => scheduleForGrade(base.schedule, entry);
  const draft = drafts[grade] ?? baseFor(grade);
  const setDraft = (value: Schedule) => setDrafts(current => ({ ...current, [grade]: value }));
  const edited = GRADES.filter(entry => drafts[entry] && JSON.stringify(drafts[entry]) !== JSON.stringify(baseFor(entry)));
  const [summary, setSummary] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const issues = describeIssues(draft);
  const unchanged = !edited.includes(grade);
  const moved = school.version > base.version;
  const reload = async () => {
    setPending(true); setError(''); setNotice('');
    try {
      // refresh reports failure instead of throwing; adopting then would keep the stale base and fail the next proposal again.
      if (!(await state.refresh())) { setError('Could not load the latest version. Check your connection and try again.'); return; }
      setAdopt(true);
      setStale(false);
      setNotice(`Reloaded. Your edits are still here; if the vote passes they replace the newer ${gradeLabel(grade)} schedule.`);
    } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const reloadButton = <Button size="sm" variant="secondary" disabled={pending} onClick={() => void reload()}>Reload latest</Button>;
  return <Modal open onClose={onClose} dirty={edited.length > 0 || summary.trim() !== ''} busy={pending} wide fullWidth title="Propose a schedule change" description="Verified members of your school vote on your proposal. If it passes, the shared schedule updates for everyone; personal classes and adjustments are never changed."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={issues.length > 0 || unchanged || summary.trim().length < 10} onClick={async () => {
      setPending(true); setError(''); setNotice(''); setStale(false);
      try {
        await api.proposals.create.mutate({ accountId: context.user.id, schoolId: school.id, baseVersion: base.version, schedule: scheduleSchema.parse(applyScheduleToGrades(base.schedule, draft, [grade])), summary: summary.trim() });
        await onSaved();
      } catch (err) {
        const text = errorMessage(err);
        setError(text);
        if (/changed\. Reload/i.test(text)) setStale(true);
      } finally { setPending(false); }
    }}>Open the vote</Button></>}>
    {moved && !stale && <Callout tone="warning" icon="alert" role="status" actions={reloadButton}>Someone published revision {school.version} while you were writing this. Reload it before opening the vote; your edits stay.</Callout>}
    <div className="grid gap-4 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04] lg:grid-cols-2">
      <Field label="What changes and why?" htmlFor="proposal-summary" hint="At least 10 characters. Everyone sees this next to the vote."><Textarea id="proposal-summary" rows={3} minLength={10} maxLength={1000} value={summary} onChange={event => setSummary(event.target.value)} placeholder="Example: Day 3 lunch moved to 11:20–11:50 in the new bell schedule (see the district PDF)." /></Field>
      <div className="grid gap-2">
        <Label className="text-[13px] font-semibold text-foreground/80">Grade schedule to change</Label>
        <Segmented<Grade> label="Grade schedule to change" value={grade} disabled={pending} options={GRADES.map(entry => ({ value: entry, label: <>{gradeLabel(entry)}{edited.includes(entry) && <><span aria-hidden="true"> *</span><span className="sr-only"> (edited)</span></>}</> }))} onChange={entry => { setGrade(entry); setError(''); setNotice(''); }} />
        <Hint>A proposal changes one grade’s schedule at a time; only {gradeLabel(grade)} is submitted.{edited.some(entry => entry !== grade) ? ' * marks other grades you edited.' : ''} Built on revision {base.version}.</Hint>
      </div>
    </div>
    <ScheduleEditor key={grade} value={draft} onChange={setDraft} disabled={pending} />
    {unchanged && <Hint>Make a change to the schedule above to open a vote.</Hint>}
    {notice && <Callout tone="warning" icon="alert" role="status">{notice}</Callout>}
    {error && <Callout tone={stale ? 'warning' : 'danger'} icon="alert" role="alert" actions={stale ? reloadButton : undefined}>{error}</Callout>}
  </Modal>;
}
