'use client';

import { Component, createContext, useCallback, useContext, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { api, errorMessage } from '@/client/api';
import { collectBetaDiagnostics, installBetaErrorBuffer, recordBetaError } from '@/client/beta-diagnostics';
import type { BetaDiagnostics } from '@/domain/betas';
import { browserTimeZone, formatDate, instantParts } from '@/lib/format';
import type { WorkspaceContext } from './app-state';
import type { PublicBeta } from '@/server/betas';
import { Icon } from './icon';
import { Button, Callout, Eyebrow, Field, Hint, Input, Modal, Spacer, Textarea } from './primitives';

/**
 * Betas on the client (README "Running a beta"). Wrap new UI in <Beta id="key" fallback={<Old />}> or branch on
 * useBeta('key'): both are on only for members who joined that beta, with its code or, for a public beta, with a tap.
 * Members join, leave and send feedback from Account (BetaSettings, or the BetasButton popup); leaving never needs a code.
 */

export type JoinedBeta = WorkspaceContext['betas'][number];
type BetaState = { accountId: string; betas: JoinedBeta[]; online: boolean; refresh: () => Promise<unknown> };
const BetaContext = createContext<BetaState | null>(null);

export function BetaProvider({ accountId, betas, online, refresh, children }: BetaState & { children: ReactNode }) {
  // Errors are only collected while the member is in a beta, for its reports.
  useEffect(() => { if (betas.length) installBetaErrorBuffer(); }, [betas.length]);
  // The server already left every beta for `?beta=off` (src/app/boot.ts); drop it from the address so a reload or a
  // shared link doesn't repeat it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('beta') !== 'off') return;
    url.searchParams.delete('beta');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return <BetaContext.Provider value={{ accountId, betas, online, refresh }}>{children}</BetaContext.Provider>;
}

/** True when the signed-in member joined the beta `key`. False outside the signed-in app. */
export function useBeta(key: string): boolean {
  return useContext(BetaContext)?.betas.some((beta) => beta.key === key) ?? false;
}

/**
 * Renders `children` for members in beta `id` and `fallback` (the current UI) for everyone else. If the beta UI
 * throws, the member gets the fallback with a notice offering to leave the beta or report it, instead of a broken page.
 */
export function Beta({ id, fallback = null, children }: { id: string; fallback?: ReactNode; children: ReactNode }) {
  const state = useContext(BetaContext);
  if (!state?.betas.some((beta) => beta.key === id)) return <>{fallback}</>;
  return <BetaBoundary id={id} fallback={fallback} state={state}>{children}</BetaBoundary>;
}

class BetaBoundary extends Component<{ id: string; fallback: ReactNode; state: BetaState; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { recordBetaError(`${this.props.id} crashed: ${error.message}`); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <>
      <BetaCrashNotice id={this.props.id} state={this.props.state} />
      {this.props.fallback}
    </>;
  }
}

function BetaCrashNotice({ id, state }: { id: string; state: BetaState }) {
  const beta = state.betas.find((entry) => entry.key === id);
  const [reporting, setReporting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const leave = async () => {
    setPending(true); setError('');
    try { await api.beta.leave.mutate({ accountId: state.accountId, key: id }); await state.refresh(); }
    catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Callout tone="warning" icon="alert" role="alert" className="mb-4" title={`Part of ${beta?.name ?? 'a beta'} stopped working`}
    actions={<>
      <Button size="sm" busy={pending} disabled={!state.online} onClick={() => void leave()}>Leave beta</Button>
      <Button size="sm" variant="ghost" disabled={!state.online} onClick={() => setReporting(true)}>Report it</Button>
    </>}>
    The regular version is showing instead. Leaving the beta keeps it that way; you can rejoin later{beta?.public ? ' from Account → Betas' : ' with the code'}.
    {error && <span className="mt-1 block font-semibold">{error}</span>}
    {reporting && beta && <BetaFeedbackModal accountId={state.accountId} beta={beta} betas={state.betas} onClose={() => setReporting(false)} />}
  </Callout>;
}

const formatJoined = (iso: string) => formatDate(instantParts(iso, browserTimeZone()).date, { year: true });

type BetaListProps = { accountId: string; betas: JoinedBeta[]; online: boolean; onChanged: () => Promise<unknown> };

/** The betas the member is in, each with Send feedback and Leave beta. Renders nothing when they are in none. */
function JoinedBetaList({ accountId, betas, online, onChanged, onError }: BetaListProps & { onError: (message: string) => void }) {
  const [leaving, setLeaving] = useState<string | null>(null);
  const [reporting, setReporting] = useState<JoinedBeta | null>(null);
  const leave = async (beta: JoinedBeta) => {
    setLeaving(beta.key); onError('');
    try { await api.beta.leave.mutate({ accountId, key: beta.key }); await onChanged(); }
    catch (err) { onError(errorMessage(err)); }
    finally { setLeaving(null); }
  };
  if (!betas.length) return null;
  return <>
    <ul className="grid gap-2" aria-label="Your betas">{betas.map((beta) => <li key={beta.key} className="grid gap-2 rounded-2xl bg-muted/80 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
      <div className="grid gap-0.5"><strong className="text-sm font-bold">{beta.name}</strong>{beta.description && <Hint>{beta.description}</Hint>}<Hint>Joined {formatJoined(beta.joinedAt)}</Hint></div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon="message" disabled={!online} onClick={() => setReporting(beta)}>Send feedback</Button>
        <Button size="sm" variant="ghost" busy={leaving === beta.key} disabled={!online || leaving !== null} onClick={() => void leave(beta)} aria-label={`Leave ${beta.name}`}>Leave beta</Button>
      </div>
    </li>)}</ul>
    {reporting && <BetaFeedbackModal accountId={accountId} beta={reporting} betas={betas} onClose={() => setReporting(null)} />}
  </>;
}

/** The code field that joins a private beta. */
function BetaCodeForm({ accountId, betas, online, onChanged, hint }: BetaListProps & { hint: ReactNode }) {
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [joined, setJoined] = useState('');
  const join = async () => {
    setJoining(true); setError(''); setJoined('');
    try {
      const before = new Set(betas.map((beta) => beta.key));
      const after = await api.beta.join.mutate({ accountId, code });
      const added = after.find((beta) => !before.has(beta.key));
      setCode(''); setJoined(added ? `You’re in ${added.name}.` : 'You’re already in that beta.');
      await onChanged();
    } catch (err) { setError(errorMessage(err)); }
    finally { setJoining(false); }
  };
  return <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); if (code.trim()) void join(); }}>
    <Field label="Beta code" htmlFor="beta-code" hint={hint}>
      <div className="flex gap-2">
        <Input id="beta-code" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={64} value={code} disabled={joining} onChange={(event) => { setCode(event.target.value); setError(''); }} />
        <Button type="submit" variant="primary" busy={joining} disabled={!online || code.trim().length < 4}>Join</Button>
      </div>
    </Field>
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
    {joined && <Hint role="status">{joined}</Hint>}
  </form>;
}

/** The Betas block in Account: the betas the member is in (feedback, leave) and the code field to join one. */
export function BetaSettings(props: BetaListProps) {
  const [error, setError] = useState('');
  return <div className="grid gap-3">
    <JoinedBetaList {...props} onError={setError} />
    <BetaCodeForm {...props} hint={props.betas.length ? 'Have a code for another beta? Enter it here.' : 'Got a code from the person who runs Quasar? Enter it to try something early. You can leave any time.'} />
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
    {!props.online && <Hint>Connect to the internet to join or leave a beta.</Hint>}
  </div>;
}

/**
 * Betas as its own popup (the betas-screen beta): the Account sheet shows one row that opens it. Inside are the betas
 * the member is in, the public betas anyone can join with a tap, and the code field for private ones.
 */
export function BetasButton(props: BetaListProps) {
  const [open, setOpen] = useState(false);
  const count = props.betas.length;
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}
      className="flex w-full items-center justify-between gap-3 rounded-2xl bg-muted/80 px-4 py-3 text-left ring-1 ring-inset ring-foreground/[0.04] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
      <span className="grid min-w-0 gap-0.5">
        <strong className="text-sm font-semibold">Betas</strong>
        <Hint className="truncate">{count ? `You’re in ${count === 1 ? props.betas[0].name : `${count} betas`}` : 'Try new things before everyone else'}</Hint>
      </span>
      <Icon name="chevronRight" size={18} className="shrink-0 text-muted-foreground" />
    </button>
    {open && <BetasModal {...props} onClose={() => setOpen(false)} />}
  </>;
}

function BetasModal({ onClose, ...props }: BetaListProps & { onClose: () => void }) {
  const { accountId, online, onChanged } = props;
  const [available, setAvailable] = useState<PublicBeta[] | null>(null);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [joined, setJoined] = useState('');
  const load = useCallback(async () => {
    try { setAvailable(await api.beta.available.query()); }
    catch (err) { setError(errorMessage(err)); setAvailable([]); }
  }, []);
  // Joining or leaving changes which public betas are on offer.
  const joinedKeys = props.betas.map((beta) => beta.key).join(',');
  useEffect(() => { if (online) void load(); }, [load, online, joinedKeys]);
  const enroll = async (beta: PublicBeta) => {
    setEnrolling(beta.key); setError(''); setJoined('');
    try { await api.beta.enroll.mutate({ accountId, key: beta.key }); setJoined(`You’re in ${beta.name}.`); await onChanged(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setEnrolling(null); }
  };
  return <Modal open onClose={onClose} title="Betas" description="Try new things before everyone else. Leave any time, and the regular version comes back."
    footer={<><Spacer /><Button variant="primary" onClick={onClose}>Done</Button></>}>
    <div className="grid gap-5">
      {props.betas.length > 0 && <section className="grid gap-2" aria-labelledby="betas-yours"><Eyebrow><span id="betas-yours">Yours</span></Eyebrow><JoinedBetaList {...props} onError={setError} /></section>}
      <section className="grid gap-2" aria-labelledby="betas-public">
        <Eyebrow><span id="betas-public">Open to everyone</span></Eyebrow>
        {!online ? <Hint>Connect to the internet to see betas you can join.</Hint>
          : available === null ? <Hint>Looking for betas…</Hint>
          : available.length === 0 ? <Hint>No open betas right now. New ones show up here.</Hint>
          : <ul className="grid gap-2" aria-label="Betas you can join">{available.map((beta) => <li key={beta.key} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted/80 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
            <div className="grid min-w-0 flex-1 gap-0.5"><strong className="text-sm font-bold">{beta.name}</strong>{beta.description && <Hint>{beta.description}</Hint>}</div>
            {beta.full ? <Hint>Full</Hint> : <Button size="sm" variant="primary" busy={enrolling === beta.key} disabled={enrolling !== null} onClick={() => void enroll(beta)} aria-label={`Join ${beta.name}`}>Join</Button>}
          </li>)}</ul>}
        {joined && <Hint role="status">{joined}</Hint>}
      </section>
      <section className="grid gap-2" aria-labelledby="betas-code">
        <Eyebrow><span id="betas-code">Have a code?</span></Eyebrow>
        <BetaCodeForm {...props} hint="Some betas are invite-only. Enter the code you were given." />
      </section>
      {error && <Hint tone="danger" role="alert">{error}</Hint>}
      {!online && <Hint>Connect to the internet to join or leave a beta.</Hint>}
    </div>
  </Modal>;
}

/** Feedback about one beta. The member sees every diagnostic that goes with it before pressing Send. */
export function BetaFeedbackModal({ accountId, beta, betas, onClose }: { accountId: string; beta: JoinedBeta; betas: JoinedBeta[]; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [diagnostics] = useState<BetaDiagnostics>(() => collectBetaDiagnostics(betas.map((entry) => entry.key)));
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const trimmed = message.trim();
  const send = async () => {
    setPending(true); setError('');
    try { await api.beta.feedback.mutate({ accountId, key: beta.key, message: trimmed, diagnostics }); setSent(true); }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };
  const rows: Array<[string, string]> = [
    ['Page', diagnostics.page], ['Screen', diagnostics.viewport], ['Theme', diagnostics.theme], ['Online', diagnostics.online ? 'Yes' : 'No'],
    ['Betas', diagnostics.betas.join(', ')], ['Browser', diagnostics.browser], ['Recent errors', diagnostics.errors.length ? diagnostics.errors.join('\n') : 'None'],
  ];
  return <Modal open onClose={onClose} busy={pending} dirty={!sent && trimmed.length > 0} title={`Feedback on ${beta.name}`}
    description="What worked, what broke, what felt off. It goes to the person who runs Quasar, and you’ll hear back by email if they need more."
    footer={sent ? <><Spacer /><Button variant="primary" onClick={onClose}>Done</Button></> : <><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={trimmed.length < 10} onClick={() => void send()}>Send feedback</Button></>}>
    {sent ? <Callout tone="success" icon="check" role="status">Sent. Thanks for testing.</Callout> : <>
      <Field label="Your feedback" htmlFor="beta-feedback" hint="At least 10 characters."><Textarea id="beta-feedback" autoFocus rows={5} maxLength={5000} value={message} disabled={pending} onChange={(event) => setMessage(event.target.value)} /></Field>
      <details className="rounded-2xl bg-muted/70 px-4 py-3 text-sm ring-1 ring-inset ring-foreground/[0.04]">
        <summary className="cursor-pointer font-semibold">Sent with your feedback</summary>
        <dl className="mt-2 grid gap-1.5">{rows.map(([label, value]) => <div key={label} className="grid gap-0.5"><dt className="text-[12px] font-semibold text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-words font-mono text-[12px]">{value}</dd></div>)}</dl>
        <Hint className="mt-2">Plus the app version the server is running. Nothing else from this device is included.</Hint>
      </details>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    </>}
  </Modal>;
}
