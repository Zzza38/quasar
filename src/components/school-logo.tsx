'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { formatDate, instantParts } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from './app-state';
import { Button, Callout, Chip, Hint, Section } from './primitives';

type Board = RouterOutput['schoolLogo']['list'];
type LogoProposal = Board['proposals'][number];

/** The longest side of a stored logo, in pixels: sharp at the sizes the app draws it, small to store. */
const LOGO_PIXELS = 256;
/** The server's cap on a logo's bytes (LOGO_MAX_BYTES in src/server/school-logos.ts). */
const LOGO_BYTES = 200_000;
const SMALL_WORDS = new Set(['of', 'the', 'and', 'for', 'at', 'in']);

/** Up to two initials for a school with no logo, skipping words such as "of" and "the". */
export function schoolInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const main = words.filter((word) => !SMALL_WORDS.has(word.toLowerCase()));
  return (main.length ? main : words).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('') || 'S';
}

/**
 * Fits an image file inside a LOGO_PIXELS square without cropping it, keeping transparency, all in the browser, so
 * the server only stores a small picture. PNG when that is small enough, else WebP. Returns the base64 body.
 */
export async function encodeLogo(file: File): Promise<{ mime: 'image/png' | 'image/webp'; data: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('Choose an image file, such as a PNG or a JPEG.');
  try {
    const scale = Math.min(LOGO_PIXELS / bitmap.width, LOGO_PIXELS / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = LOGO_PIXELS; canvas.height = LOGO_PIXELS;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the picture.');
    context.drawImage(bitmap, (LOGO_PIXELS - width) / 2, (LOGO_PIXELS - height) / 2, width, height);
    for (const mime of ['image/png', 'image/webp'] as const) {
      const url = canvas.toDataURL(mime, 0.9);
      const data = url.startsWith(`data:${mime}`) ? url.split(',')[1] ?? '' : '';
      if (data && data.length * 3 / 4 <= LOGO_BYTES) return { mime, data };
    }
    throw new Error('That picture has too much detail for a logo. Try a simpler one.');
  } finally { bitmap.close(); }
}

/**
 * A school's mark: its logo on a white tile (logos are drawn for light paper), or a shield with its initials until it
 * has one. Decorative; the school's name is always beside it.
 */
export function SchoolMark({ name, logo, size = 'md', className }: { name: string; logo?: string | null; size?: 'md' | 'lg'; className?: string }) {
  const box = size === 'lg' ? 'size-20' : 'size-14';
  // eslint-disable-next-line @next/next/no-img-element -- a small, already-sized picture from our own route; next/image adds nothing.
  if (logo) return <img src={logo} alt="" draggable={false} className={cn('shrink-0 rounded-2xl bg-white object-contain p-1 ring-1 ring-foreground/10', box, className)} />;
  return <svg aria-hidden="true" viewBox="0 0 56 56" className={cn('shrink-0', box, className)}>
    <path d="M9 3h38a5 5 0 0 1 5 5v20c0 11.5-8.4 19.6-24 25C12.400 47.600 4 39.500 4 28V8a5 5 0 0 1 5-5Z" className="fill-primary-soft stroke-primary/35" strokeWidth="1.5" />
    <path d="M12.500 9h31a2 2 0 0 1 2 2v17c0 8.300-6 14.400-17.500 18.700C16.500 42.400 10.500 36.300 10.500 28V11a2 2 0 0 1 2-2Z" fill="none" className="stroke-primary/20" strokeWidth="1" />
    <text x="28" y="25.500" textAnchor="middle" dominantBaseline="central" className="fill-primary-soft-foreground font-extrabold" style={{ fontSize: 17, letterSpacing: '-0.02em' }}>{schoolInitials(name)}</text>
  </svg>;
}

type Closed = Exclude<LogoProposal['status'], 'open' | 'requested'>;
const STATUS: Record<Closed, { label: string; tone: 'neutral' | 'success' | 'warning' | 'accent' }> = {
  published: { label: 'Published', tone: 'success' },
  rejected: { label: 'Voted down', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  declined: { label: 'Stopped by support', tone: 'warning' },
  superseded: { label: 'Replaced', tone: 'neutral' },
  reverted: { label: 'Reverted by support', tone: 'warning' },
};
/** The statuses a staff member can still force to win (WINNABLE in src/server/school-logos.ts), apart from an open vote. */
const LOST: readonly LogoProposal['status'][] = ['rejected', 'declined', 'superseded', 'reverted'];
const statusChip = (proposal: LogoProposal) => {
  const status = STATUS[proposal.status as Closed];
  const label = proposal.status === 'published' && proposal.byStaff ? (proposal.request ? 'Approved by support' : 'Published by support')
    : proposal.status === 'declined' && proposal.request ? 'Declined by support' : status.label;
  return <Chip tone={status.tone}>{label}</Chip>;
};
/** What a closed proposal shows under its proposer: a vote's count, or that it was a request (which has no votes). */
const closedDetail = (proposal: LogoProposal) => proposal.request ? 'Request to support' : `${proposal.votesFor} for, ${proposal.votesAgainst} against`;

function ProposedLogo({ src }: { src: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- see SchoolMark.
  return <img src={src} alt="Proposed logo" draggable={false} className="size-16 shrink-0 rounded-2xl bg-white object-contain p-1 ring-1 ring-foreground/10" />;
}

/**
 * The School page's logo section: the current logo, proposing a new one, and the vote. Members propose and vote, and
 * a vote that passes publishes the logo. While support chose the logo (`locked`), a member's new logo is a request
 * that only they and support see. Staff who are members of the school can overrule it here: force a vote to win or
 * lose, answer a request, set or remove the logo, and revert the last change.
 */
export function SchoolLogoSection({ state }: { state: AppState }) {
  const { context, online } = state;
  const accountId = context.user.id;
  const school = context.school;
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const mode = useRef<'propose' | 'set'>('propose');
  const refresh = useCallback(async () => {
    if (!online) return;
    try { setBoard(await api.schoolLogo.list.query()); } catch (err) { setError(errorMessage(err)); }
  }, [online]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); setError('');
    // The board reloads either way: a failed vote usually means the logo closed elsewhere.
    try { await action(); } catch (err) { setError(errorMessage(err)); }
    await refresh();
    await state.refresh();
    setPending(false);
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const picture = await encodeLogo(file);
      if (mode.current === 'set') await api.admin.setSchoolLogo.mutate({ schoolId: school.id, ...picture });
      else await api.schoolLogo.propose.mutate({ accountId, schoolId: school.id, ...picture });
    });
  };
  const choose = (next: 'propose' | 'set') => { mode.current = next; picker.current?.click(); };
  const logo = board?.logo ?? school.logo ?? null;
  const isWaiting = (entry: LogoProposal) => entry.status === 'open' || entry.status === 'requested';
  const waiting = (board?.proposals ?? []).filter(isWaiting);
  const closed = (board?.proposals ?? []).filter((entry) => !isWaiting(entry));
  const force = (id: string, win: boolean) => void run(() => api.admin.forceLogo.mutate({ id, win }));
  const blocked = pending || !online;
  const when = (iso: string) => formatDate(instantParts(iso, state.timeZone).date);

  return <Section id="logo-title" title="School logo" icon="imageUp"
    description={board ? (board.locked ? 'Support chose this school’s logo. Members can ask support for a different one.' : board.voting ? `Verified members vote on a new logo. One with at least ${board.threshold} votes for, and more for than against, becomes the school’s logo.` : 'This school is small enough to skip the vote, so a logo a member adds shows right away.') : 'Members choose the school’s logo.'}>
    {/* The only raw input allowed (AGENTS.md): a hidden file picker a shadcn Button opens. */}
    <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; upload(file); }} />
    <div className="flex flex-wrap items-center gap-4">
      <SchoolMark name={school.name} logo={logo} size="lg" />
      <div className="grid min-w-0 flex-1 basis-48 gap-2">
        <div className="grid gap-0.5">
          <strong className="text-sm font-bold">{logo ? 'The school’s logo' : 'No logo yet'}</strong>
          <Hint>{logo ? 'Every member sees it on the School page.' : 'The school shows its initials until a logo is published.'}</Hint>
        </div>
        <div className="flex flex-wrap gap-2">
          {board?.canPropose && <Button size="sm" icon="imageUp" busy={pending} disabled={blocked} onClick={() => choose('propose')}>{board.locked ? 'Request a new logo' : board.voting ? (logo ? 'Propose a new logo' : 'Propose a logo') : (logo ? 'Change the logo' : 'Add a logo')}</Button>}
          {board?.canSet && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => choose('set')}>Set as support</Button>}
          {board?.canSet && logo && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void run(() => api.admin.removeSchoolLogo.mutate({ schoolId: school.id }))}>Remove logo</Button>}
          {board?.canRevert && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void run(() => api.admin.revertSchoolLogo.mutate({ schoolId: school.id }))}>Revert last change</Button>}
        </div>
      </div>
    </div>
    {!online && <Hint>{board?.locked ? 'Connect to request a new logo.' : 'Connect to propose a logo or vote on one.'}</Hint>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {board && !board.canPropose && <Callout tone="info" icon="checkCircle" actions={<Button size="sm" onClick={() => state.navigate('people')}>Verify my school</Button>}>{board.locked ? 'Verify your school membership to request a new logo.' : 'Verify your school membership to propose a logo and vote.'}</Callout>}

    {waiting.length > 0 && <ul className="grid gap-2">{waiting.map((proposal) => {
      const mine = proposal.proposerId === accountId;
      const request = proposal.status === 'requested';
      return <li key={proposal.id} className="flex flex-wrap items-center gap-3.5 rounded-2xl bg-muted/70 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
        <ProposedLogo src={proposal.image} />
        <div className="grid min-w-0 flex-1 basis-52 gap-2">
          <div className="grid gap-0.5">
            <strong className="text-sm font-bold">{request ? (mine ? 'Your request' : `Requested by ${proposal.proposerName}`) : (mine ? 'Your proposal' : `Proposed by ${proposal.proposerName}`)}</strong>
            <Hint>{when(proposal.createdAt)} · {request ? 'waiting for support' : `${proposal.votesFor} for, ${proposal.votesAgainst} against · passes at ${proposal.threshold}`}</Hint>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!request && board?.canVote && <>
              <Button size="sm" variant={proposal.myVote === 'for' ? 'primary' : 'secondary'} icon="check" disabled={blocked} aria-pressed={proposal.myVote === 'for'} onClick={() => void run(() => api.schoolLogo.vote.mutate({ accountId, proposalId: proposal.id, vote: 'for' }))}>For</Button>
              <Button size="sm" variant={proposal.myVote === 'against' ? 'danger' : 'secondary'} icon="x" disabled={blocked} aria-pressed={proposal.myVote === 'against'} onClick={() => void run(() => api.schoolLogo.vote.mutate({ accountId, proposalId: proposal.id, vote: 'against' }))}>Against</Button>
            </>}
            {board?.canForce && <>
              <Button size="sm" variant="ghost" disabled={blocked} onClick={() => force(proposal.id, true)}>{request ? 'Approve' : 'Force win'}</Button>
              <Button size="sm" variant="ghost" disabled={blocked} onClick={() => force(proposal.id, false)}>{request ? 'Decline' : 'Force loss'}</Button>
            </>}
            {mine && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void run(() => api.schoolLogo.withdraw.mutate({ accountId, proposalId: proposal.id }))}>Withdraw</Button>}
          </div>
        </div>
      </li>;
    })}</ul>}
    {board?.voting && !board.locked && waiting.length === 0 && <Hint>No logos are being voted on.</Hint>}

    {closed.length > 0 && <div className="grid gap-2">
      <Button size="sm" variant="ghost" className="w-fit" iconRight="chevronDown" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Hide' : 'Show'} earlier logos ({closed.length})</Button>
      {showClosed && <ul className="grid gap-2">{closed.map((proposal) => <li key={proposal.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 px-3 py-2">
        <ProposedLogo src={proposal.image} />
        <span className="grid min-w-0 flex-1 basis-32"><strong className="truncate text-sm font-semibold">{proposal.proposerName}</strong><Hint>{when(proposal.createdAt)} · {closedDetail(proposal)}</Hint></span>
        {statusChip(proposal)}
        {board?.canForce && LOST.includes(proposal.status) && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => force(proposal.id, true)}>Force win</Button>}
      </li>)}</ul>}
    </div>}
  </Section>;
}

/**
 * Support's controls for one school's logo in the /admin review sheet: set it from a file, remove it, revert the last
 * change, force any of the school's logo votes, and answer its logo requests. Staff need not belong to the school.
 */
export function SupportLogoControls({ school, canForce, onChanged }: { school: { id: string; name: string; logo?: string | null }; canForce: boolean; onChanged: () => Promise<unknown> }) {
  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [board, setBoard] = useState<RouterOutput['admin']['schoolLogos'] | null>(null);
  const load = useCallback(async () => {
    try { setBoard(await api.admin.schoolLogos.query({ schoolId: school.id })); } catch (err) { setError(errorMessage(err)); }
  }, [school.id]);
  useEffect(() => { void load(); }, [load]);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); setError('');
    try { await action(); } catch (err) { setError(errorMessage(err)); }
    await load();
    await onChanged().catch(() => undefined);
    setPending(false);
  };
  const logo = board ? board.logo : school.logo;
  const force = (id: string, win: boolean) => void run(() => api.admin.forceLogo.mutate({ id, win }));
  return <div className="grid gap-3">
    <div className="flex flex-wrap items-center gap-3">
      <SchoolMark name={school.name} logo={logo} />
      {/* The only raw input allowed (AGENTS.md): a hidden file picker a shadcn Button opens. */}
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true"
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => api.admin.setSchoolLogo.mutate({ schoolId: school.id, ...await encodeLogo(file) })); }} />
      <div className="grid gap-1.5">
        <strong className="text-sm font-bold">School logo</strong>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="imageUp" busy={pending} disabled={pending} onClick={() => picker.current?.click()}>{logo ? 'Replace logo' : 'Set logo'}</Button>
          {logo && <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(() => api.admin.removeSchoolLogo.mutate({ schoolId: school.id }))}>Remove logo</Button>}
          {board?.canRevert && <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(() => api.admin.revertSchoolLogo.mutate({ schoolId: school.id }))}>Revert last change</Button>}
        </div>
      </div>
    </div>
    <Hint>Setting a logo here publishes it at once, deletes the school’s logo votes and locks the logo: until you remove it, members can only ask support for a different one. Reverting brings back the logo from before the last change.</Hint>
    {board?.locked && <Hint className="flex items-center gap-1.5"><Chip tone="accent">Locked</Chip>Support chose this logo, so new ones come in as requests.</Hint>}
    {board && board.proposals.length > 0 && <ul aria-label="Logo votes" className="grid gap-2">{board.proposals.map((proposal) => <li key={proposal.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 px-3 py-2">
      <ProposedLogo src={proposal.image} />
      <span className="grid min-w-0 flex-1 basis-32"><strong className="truncate text-sm font-semibold">{proposal.proposerName}</strong><Hint>{proposal.status === 'open' ? `${proposal.votesFor} for, ${proposal.votesAgainst} against · passes at ${proposal.threshold}` : closedDetail(proposal)}</Hint></span>
      {proposal.status === 'open' ? <Chip tone="accent">Voting</Chip> : proposal.status === 'requested' ? <Chip tone="accent">Waiting for you</Chip> : statusChip(proposal)}
      {canForce && proposal.status === 'requested' && <><Button size="sm" variant="ghost" disabled={pending} onClick={() => force(proposal.id, true)}>Approve</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => force(proposal.id, false)}>Decline</Button></>}
      {canForce && (proposal.status === 'open' || LOST.includes(proposal.status)) && <Button size="sm" variant="ghost" disabled={pending} onClick={() => force(proposal.id, true)}>Force win</Button>}
      {canForce && proposal.status === 'open' && <Button size="sm" variant="ghost" disabled={pending} onClick={() => force(proposal.id, false)}>Force loss</Button>}
    </li>)}</ul>}
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
  </div>;
}
