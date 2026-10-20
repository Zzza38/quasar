'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { BETA_KEY_PATTERN, normalizeBetaCode, type StoredBetaDiagnostics } from '@/domain/betas';
import { browserTimeZone, formatDate, instantParts, pluralize } from '@/lib/format';
import { Icon } from './icon';
import { Button, Callout, Chip, Field, Hint, Input, Modal, Section, Spacer, Textarea, Toggle } from './primitives';

type BetaRow = RouterOutput['admin']['betas']['list'][number];
const formatDay = (iso: string) => formatDate(instantParts(iso, browserTimeZone()).date, { weekday: 'short', year: true });

/** A code that is easy to read out loud: no 0/O or 1/I/L. */
function randomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
const parseLimit = (value: string): number | null | 'invalid' => {
  if (!value.trim()) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100_000 ? limit : 'invalid';
};

/**
 * /admin → Betas (README "Running a beta"). Create a beta with a code, pause joining, cap it, swap a leaked code, see
 * who is in and remove them, or close it. Only the code's hash is stored, so a new code is shown once.
 */
export function BetaAdmin({ accountId, onAccessLost }: { accountId: string | null; onAccessLost: (error: unknown) => Promise<boolean> }) {
  const [betas, setBetas] = useState<BetaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BetaRow | null>(null);
  const [shownCode, setShownCode] = useState<{ name: string; code: string } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { setBetas(await api.admin.betas.list.query()); setError(''); }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); }
    finally { setLoading(false); }
  }, [onAccessLost]);
  useEffect(() => { void load(); }, [load]);
  /** Runs an owner change, then reloads the list. Returns whether it worked. */
  const run = async (action: (accountId: string) => Promise<unknown>): Promise<boolean> => {
    if (!accountId) return false;
    setError('');
    try { await action(accountId); await load(); return true; }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); await load(); return false; }
  };
  const newCode = async (beta: BetaRow) => {
    const code = randomCode();
    if (!window.confirm(`Replace the code for ${beta.name}? The old code stops working. Members already in stay in.`)) return;
    if (await run((id) => api.admin.betas.changeCode.mutate({ accountId: id, key: beta.key, code }))) setShownCode({ name: beta.name, code });
  };
  const close = (beta: BetaRow) => {
    if (!window.confirm(`Close ${beta.name}? Everyone in it (${beta.members.length}) leaves the beta. Its feedback stays in the inbox.`)) return;
    void run((id) => api.admin.betas.close.mutate({ accountId: id, key: beta.key }));
  };
  return <Section id="betas-title" title="Betas" icon="sparkle"
    description="Members join a beta by typing its code in Account, and code wrapped in <Beta> or useBeta() turns on for them. They can leave any time without the code. Feedback arrives in the inbox."
    action={<Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>New beta</Button>}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {shownCode && <Callout tone="success" icon="check" title={`Code for ${shownCode.name}`} actions={<>
      <Button size="sm" icon="copy" onClick={() => void navigator.clipboard?.writeText(shownCode.code)}>Copy</Button>
      <Button size="sm" variant="ghost" onClick={() => setShownCode(null)}>Done</Button>
    </>}>
      <code className="font-mono text-base font-bold tracking-wider">{shownCode.code}</code>
      <span className="block">Share it with your testers. Only its hash is saved, so this is the one time it’s shown.</span>
    </Callout>}
    {!loading && betas.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="info" size={14} />No betas yet.</Hint>}
    {betas.length > 0 && <ul className="grid gap-3">{betas.map((beta) => <li key={beta.key} className="grid gap-3 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <div className="flex flex-wrap items-center gap-2"><strong className="text-[15px] font-bold">{beta.name}</strong><code className="font-mono text-[12px] text-muted-foreground">{beta.key}</code></div>
          {beta.description && <Hint>{beta.description}</Hint>}
          <Hint>Created {formatDay(beta.createdAt)}</Hint>
        </div>
        <div className="flex flex-wrap gap-1">
          {beta.open ? <Chip tone="success" icon="unlock">Taking testers</Chip> : <Chip tone="warning" icon="lock">Joining paused</Chip>}
          <Chip icon="users">{beta.maxMembers === null ? pluralize(beta.members.length, 'member') : `${beta.members.length} of ${beta.maxMembers}`}</Chip>
          {beta.openFeedback > 0 && <Chip tone="accent" icon="inbox">{pluralize(beta.openFeedback, 'open report')}</Chip>}
        </div>
      </div>
      {beta.members.length > 0 && <details className="rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/[0.06]">
        <summary className="cursor-pointer font-semibold">Members</summary>
        <ul className="mt-2 grid gap-1.5">{beta.members.map((member) => <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0"><strong className="font-semibold">{member.displayName || member.email}</strong> <Hint className="inline">{member.email} · joined {formatDay(member.joinedAt)}</Hint></span>
          <Button size="sm" variant="ghost" onClick={() => void run((id) => api.admin.betas.removeMember.mutate({ accountId: id, key: beta.key, userId: member.userId }))} aria-label={`Remove ${member.email} from ${beta.name}`}>Remove</Button>
        </li>)}</ul>
      </details>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon="edit" onClick={() => setEditing(beta)}>Edit</Button>
        <Button size="sm" icon={beta.open ? 'lock' : 'unlock'} onClick={() => void run((id) => api.admin.betas.update.mutate({ accountId: id, key: beta.key, name: beta.name, description: beta.description, maxMembers: beta.maxMembers, open: !beta.open }))}>{beta.open ? 'Pause joining' : 'Reopen joining'}</Button>
        <Button size="sm" icon="refresh" onClick={() => void newCode(beta)}>New code</Button>
        <Button size="sm" variant="ghost" icon="trash" onClick={() => close(beta)}>Close beta</Button>
      </div>
    </li>)}</ul>}
    {creating && <BetaForm onClose={() => setCreating(false)} onSave={async (input) => {
      const ok = await run((id) => api.admin.betas.create.mutate({ accountId: id, ...input, code: input.code! }));
      if (ok) { setCreating(false); setShownCode({ name: input.name, code: input.code! }); }
      return ok;
    }} />}
    {editing && <BetaForm beta={editing} onClose={() => setEditing(null)} onSave={async (input) => {
      const ok = await run((id) => api.admin.betas.update.mutate({ accountId: id, key: editing.key, name: input.name, description: input.description, maxMembers: input.maxMembers, open: editing.open }));
      if (ok) setEditing(null);
      return ok;
    }} />}
  </Section>;
}

type BetaFormValue = { key: string; name: string; description: string; maxMembers: number | null; code?: string };

/** New beta (key, name, description, limit, code) or editing one (name, description, limit). */
function BetaForm({ beta, onClose, onSave }: { beta?: BetaRow; onClose: () => void; onSave: (value: BetaFormValue) => Promise<boolean> }) {
  const [key, setKey] = useState(beta?.key ?? '');
  const [name, setName] = useState(beta?.name ?? '');
  const [description, setDescription] = useState(beta?.description ?? '');
  const [limit, setLimit] = useState(beta?.maxMembers ? String(beta.maxMembers) : '');
  const [capped, setCapped] = useState(beta ? beta.maxMembers !== null : false);
  const [code, setCode] = useState(() => beta ? '' : randomCode());
  const [pending, setPending] = useState(false);
  const maxMembers = capped ? parseLimit(limit) : null;
  const keyValid = !!beta || (key.length >= 2 && key.length <= 40 && BETA_KEY_PATTERN.test(key));
  const codeValid = !!beta || normalizeBetaCode(code).length >= 4;
  const limitValid = maxMembers !== 'invalid' && (!capped || maxMembers !== null);
  const valid = keyValid && codeValid && name.trim().length >= 2 && limitValid;
  const save = async () => {
    if (!valid) return;
    setPending(true);
    const ok = await onSave({ key, name: name.trim(), description: description.trim(), maxMembers, ...(beta ? {} : { code }) });
    if (!ok) setPending(false);
  };
  return <Modal open onClose={onClose} busy={pending} title={beta ? `Edit ${beta.name}` : 'New beta'}
    description={beta ? 'Members already in stay in.' : 'The key is what the code checks: useBeta(\'key\') or <Beta id="key">. Ship the code first, then create the beta here.'}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={!valid} onClick={() => void save()}>{beta ? 'Save' : 'Create beta'}</Button></>}>
    {!beta && <Field label="Key" htmlFor="beta-key" hint="Lowercase letters, numbers and dashes. Can’t be changed later." error={key && !keyValid ? 'Use lowercase letters, numbers and dashes, like month-grid.' : undefined}>
      <Input id="beta-key" autoFocus autoComplete="off" spellCheck={false} maxLength={40} placeholder="month-grid" value={key} disabled={pending} onChange={(event) => setKey(event.target.value.toLowerCase())} />
    </Field>}
    <Field label="Name" htmlFor="beta-name" hint="Members see this in Account."><Input id="beta-name" autoFocus={!!beta} maxLength={80} placeholder="Month grid schedule" value={name} disabled={pending} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="Description" htmlFor="beta-description" hint="Optional. What to try, shown under the name."><Textarea id="beta-description" rows={2} maxLength={500} value={description} disabled={pending} onChange={(event) => setDescription(event.target.value)} /></Field>
    <Toggle checked={capped} onChange={setCapped} disabled={pending} label="Limit how many can join" description="Stops a leaked code from pulling in the whole school." />
    {capped && <Field label="Most members" htmlFor="beta-limit" error={maxMembers === 'invalid' ? 'A whole number from 1 to 100000.' : undefined}><Input id="beta-limit" inputMode="numeric" value={limit} disabled={pending} onChange={(event) => setLimit(event.target.value)} /></Field>}
    {!beta && <Field label="Code" htmlFor="beta-code-new" hint="Case, spaces and dashes don’t matter. Shown once after you create the beta." error={code && !codeValid ? 'At least 4 letters or numbers.' : undefined}>
      <div className="flex gap-2"><Input id="beta-code-new" autoComplete="off" spellCheck={false} maxLength={64} value={code} disabled={pending} onChange={(event) => setCode(event.target.value)} /><Button disabled={pending} onClick={() => setCode(randomCode())}>Generate</Button></div>
    </Field>}
  </Modal>;
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
