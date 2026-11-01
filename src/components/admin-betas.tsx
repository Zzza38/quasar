'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import type { StoredBetaDiagnostics } from '@/domain/betas';
import { browserTimeZone, formatDate, instantParts, pluralize } from '@/lib/format';
import { Icon } from './icon';
import { Button, Callout, Chip, Hint, Section } from './primitives';

type BetaList = RouterOutput['admin']['betas']['list'];
const formatDay = (iso: string) => formatDate(instantParts(iso, browserTimeZone()).date, { weekday: 'short', year: true });

/**
 * /admin → Betas (README "Running a beta"): each beta's code to share, who is in it, and its open feedback. Betas are
 * created and changed with `npm run beta`, not here; the only change made here is taking a member out.
 */
export function BetaAdmin({ accountId, onAccessLost }: { accountId: string | null; onAccessLost: (error: unknown) => Promise<boolean> }) {
  const [list, setList] = useState<BetaList | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setList(await api.admin.betas.list.query()); setError(''); }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); }
  }, [onAccessLost]);
  useEffect(() => { void load(); }, [load]);
  const remove = async (key: string, userId: string) => {
    if (!accountId) return;
    setError('');
    try { await api.admin.betas.removeMember.mutate({ accountId, key, userId }); }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); }
    await load();
  };
  const copy = async (key: string, code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(key); setTimeout(() => setCopied((current) => current === key ? null : current), 2000); }
    catch { setError('Couldn’t copy. Select the code and copy it instead.'); }
  };
  return <Section id="betas-title" title="Betas" icon="sparkle"
    description="Members join a private beta by typing its code in Account, or a public one with a tap, and code wrapped in <Beta> or useBeta() turns on for them. They can leave any time without the code. Feedback arrives in the inbox."
    action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void load()}>Refresh</Button>}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    <Hint>Create and change betas from the checkout with <code className="font-mono">npm run beta</code>. The list{list ? <> lives in <code className="break-all font-mono">{list.path}</code> and</> : ''} is never committed. Changes show up here right away.</Hint>
    {list && list.betas.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="info" size={14} />No betas. Create one with <code className="font-mono">npm run beta -- create &lt;key&gt; --name &quot;Name&quot;</code>.</Hint>}
    {list && list.betas.length > 0 && <ul className="grid gap-3">{list.betas.map((beta) => <li key={beta.key} className="grid gap-3 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <div className="flex flex-wrap items-center gap-2"><strong className="text-[15px] font-bold">{beta.name}</strong><code className="font-mono text-[12px] text-muted-foreground">{beta.key}</code></div>
          {beta.description && <Hint>{beta.description}</Hint>}
        </div>
        <div className="flex flex-wrap gap-1">
          {beta.public ? <Chip icon="users">Public</Chip> : <Chip icon="lock">Private</Chip>}
          {beta.open ? <Chip tone="success" icon="unlock">Taking testers</Chip> : <Chip tone="warning" icon="lock">Joining paused</Chip>}
          <Chip icon="users">{beta.maxMembers === null ? pluralize(beta.members.length, 'member') : `${beta.members.length} of ${beta.maxMembers}`}</Chip>
          {beta.openFeedback > 0 && <Chip tone="accent" icon="inbox">{pluralize(beta.openFeedback, 'open report')}</Chip>}
        </div>
      </div>
      {beta.code === undefined ? <Hint>Anyone can join from Account → Betas. There is no code.</Hint> : <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-muted-foreground">Code</span>
        <code className="rounded-lg bg-card px-2.5 py-1 font-mono text-[15px] font-bold tracking-wider ring-1 ring-foreground/[0.06]">{beta.code}</code>
        <Button size="sm" icon={copied === beta.key ? 'check' : 'copy'} onClick={() => void copy(beta.key, beta.code!)} aria-label={`Copy the code for ${beta.name}`}>{copied === beta.key ? 'Copied' : 'Copy'}</Button>
      </div>}
      {beta.members.length > 0 && <details className="rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/[0.06]">
        <summary className="cursor-pointer font-semibold">Members</summary>
        <ul className="mt-2 grid gap-1.5">{beta.members.map((member) => <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0"><strong className="font-semibold">{member.displayName || member.email}</strong> <Hint className="inline">{member.email} · joined {formatDay(member.joinedAt)}</Hint></span>
          <Button size="sm" variant="ghost" disabled={!accountId} onClick={() => void remove(beta.key, member.userId)} aria-label={`Remove ${member.email} from ${beta.name}`}>Remove</Button>
        </li>)}</ul>
      </details>}
    </li>)}</ul>}
  </Section>;
}

/** A beta report's diagnostics in the inbox (src/server/betas.ts). */
export function BetaDiagnosticsDetails({ diagnostics }: { diagnostics: StoredBetaDiagnostics }) {
  const rows: Array<[string, string]> = [
    ['Build', diagnostics.build], ['Page', diagnostics.page], ['Screen', diagnostics.viewport], ['Theme', diagnostics.theme], ['Online', diagnostics.online ? 'Yes' : 'No'],
    ['Betas', diagnostics.betas.join(', ') || 'None'], ['Browser', diagnostics.browser], ['Sent from the device at', diagnostics.at], ['Recent errors', diagnostics.errors.length ? diagnostics.errors.join('\n') : 'None'],
  ];
  return <details className="rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/[0.06]">
    <summary className="cursor-pointer font-semibold">Diagnostics{diagnostics.errors.length ? ` · ${pluralize(diagnostics.errors.length, 'error')}` : ''}</summary>
    <dl className="mt-2 grid gap-1.5">{rows.map(([label, value]) => <div key={label} className="grid gap-0.5"><dt className="text-[12px] font-semibold text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-words font-mono text-[12px]">{value}</dd></div>)}</dl>
  </details>;
}
