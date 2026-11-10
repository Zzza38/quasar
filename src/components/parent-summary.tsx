'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { browserTimeZone, formatDate, formatTime, instantParts } from '@/lib/format';
import type { SummarySection, SummarySections } from '@/server/parent-summary';
import { ParentSummaryView } from './parent-summary-view';
import { Button, Callout, Hint, Input, Modal, Spacer, Toggle } from './primitives';
import { Checkbox } from './ui/checkbox';

/**
 * "Share a weekly summary with a parent" in Account → AI (ai-tasks beta, Quasar AI Plus; src/server/parent-summary.ts).
 * The link is shown only right after it is made, because the server keeps just a hash of it. To send it again the
 * student makes a new one, which kills the old.
 */

type Status = RouterOutput['parentSummary']['status'];
const SECTION_LABELS: Record<SummarySection, string> = {
  dueThisWeek: 'Tasks due this week, and whether they’re done',
  overdue: 'How many tasks are overdue',
  assessments: 'Upcoming tests and quizzes',
  completed: 'What you finished this week',
};
const SECTION_ORDER: SummarySection[] = ['dueThisWeek', 'overdue', 'assessments', 'completed'];

const viewedAt = (iso: string) => { const { date, time } = instantParts(iso, browserTimeZone()); return `${formatDate(date, { weekday: 'short' })} at ${formatTime(time)}`; };

export function ParentSummarySettings({ accountId, online }: { accountId: string; online: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => { api.parentSummary.status.query().then(setStatus, () => setStatus(null)); }, []);
  if (!status) return null;

  const run = async <T,>(key: string, call: () => Promise<T>, done: (result: T) => void) => {
    setPending(key); setError('');
    try { done(await call()); } catch (err) { setError(errorMessage(err)); }
    finally { setPending(null); }
  };
  const withLink = (result: { token: string; status: Status }) => { setStatus(result.status); setLink(`${window.location.origin}/summary/${result.token}`); setCopied(false); };
  const toggle = (on: boolean) => on
    ? run('enable', () => api.parentSummary.enable.mutate({ accountId }), withLink)
    : run('disable', () => api.parentSummary.disable.mutate({ accountId }), (next) => { setStatus(next); setLink(null); });
  const choose = (section: SummarySection, value: boolean) => {
    if (!status.enabled) return;
    const sections: SummarySections = { ...status.sections, [section]: value };
    setStatus({ ...status, sections });
    void run('sections', () => api.parentSummary.setSections.mutate({ accountId, sections }), setStatus);
  };
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); }
    catch { input.current?.select(); document.execCommand('copy'); }
    setCopied(true);
  };
  const busy = pending !== null;

  return <div className="grid gap-3 rounded-2xl bg-muted/80 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
    <Toggle checked={status.enabled} disabled={!online || busy || (!status.enabled && !status.unlocked)} onChange={(on) => void toggle(on)}
      label="Share a weekly summary with a parent"
      description={status.enabled ? 'A private link shows a parent your week. They don’t need an account. Only you can change or turn it off.'
        : status.unlocked ? 'Makes a private link that shows a parent your week, without an account. You pick what’s on it, and you can turn it off any time.'
        : 'Part of Quasar AI Plus. A private link that shows a parent your week.'} />

    {status.enabled && <>
      {status.paused && <Callout tone="warning" icon="info" role="status">Paused while you don’t have Plus. The link shows a “paused” note instead of your week until Plus is back.</Callout>}

      {link ? <div className="grid gap-1.5">
        <div className="flex gap-2">
          <Input ref={input} readOnly value={link} aria-label="Summary link" spellCheck={false} onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 font-mono text-[12.5px]" />
          <Button size="sm" icon={copied ? 'check' : 'copy'} className="h-10 shrink-0" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <Hint>Send it to your parent yourself. Anyone who has it can open it, so don’t post it anywhere. Quasar keeps no copy, so this is the only time it’s shown.</Hint>
      </div> : <Hint>Quasar keeps no copy of the link. To send it again, make a new link. The old one stops working.</Hint>}

      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-[13px] font-semibold">What the link shows</legend>
        {SECTION_ORDER.map((section) => <div key={section} className="flex items-start gap-2.5">
          <Checkbox id={`${id}-${section}`} className="mt-0.5" checked={status.sections[section]} disabled={!online || pending === 'enable' || pending === 'disable'}
            onCheckedChange={(value) => choose(section, value === true)} />
          <label htmlFor={`${id}-${section}`} className="cursor-pointer text-[13.5px] leading-snug">{SECTION_LABELS[section]}</label>
        </div>)}
        <Hint>It shows your first name and only what’s ticked. Task notes are never shared.</Hint>
      </fieldset>

      <Hint role="status">{status.lastViewedAt ? `Last viewed ${viewedAt(status.lastViewedAt)}. Opened ${status.views === 1 ? 'once' : `${status.views} times`} since this link was made.` : 'Nobody has opened this link yet.'}</Hint>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon="eye" onClick={() => setPreviewing(true)}>Preview</Button>
        <Button size="sm" icon="refresh" disabled={!online || busy || status.paused} busy={pending === 'regenerate'} onClick={() => setConfirmNew(true)}>Make a new link</Button>
      </div>
    </>}

    {error && <Hint tone="danger" role="alert">{error}</Hint>}

    {previewing && status.enabled && <Modal open wide onClose={() => setPreviewing(false)} title="What your parent sees" description="The page the link opens, as of right now."
      footer={<><Spacer /><Button variant="primary" onClick={() => setPreviewing(false)}>Done</Button></>}>
      <div className="rounded-2xl bg-background p-3.5 sm:p-5">
        {status.paused ? <p className="text-[14px] text-muted-foreground">The page says your summary is paused, and shows nothing else.</p> : <ParentSummaryView summary={status.preview} preview />}
      </div>
    </Modal>}

    {confirmNew && <Modal open onClose={() => setConfirmNew(false)} busy={pending === 'regenerate'} title="Make a new link?"
      description="The old link stops working right away, and its view history is cleared. Send the new one to your parent."
      footer={<><Button variant="ghost" disabled={busy} onClick={() => setConfirmNew(false)}>Cancel</Button><Spacer />
        <Button variant="primary" busy={pending === 'regenerate'} onClick={() => void run('regenerate', () => api.parentSummary.regenerate.mutate({ accountId }), (result) => { withLink(result); setConfirmNew(false); })}>Make a new link</Button></>}>
      {null}
    </Modal>}
  </div>;
}
