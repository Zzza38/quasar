'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { SCHOOLOGY_BETA, SCHOOLOGY_RETURN_PARAM } from '@/domain/schoology';
import type { AppState } from './app-state';
import { useBeta } from './betas';
import { Button, Callout, Hint, Select, Toggle } from './primitives';

/**
 * The Schoology connection behind the `schoology-connect` beta (src/server/schoology.ts). "Connect Schoology" sends
 * the member to Schoology to approve Quasar; Schoology sends them back to /classes?schoology=return&oauth_token=…,
 * where the server finishes the handshake. Classes → Grades (src/components/grades.tsx) shows the grades; this file
 * keeps the connection, the background task sync, and the settings that used to sit in the Classes panel.
 */

export type SchoologyStatus = RouterOutput['schoology']['status'];
type Sections = RouterOutput['schoology']['sections'];
export type SchoologyPending = 'connect' | 'finish' | 'disconnect' | 'settings' | null;

/** How often an open app asks the server to sync Schoology; the server reads Schoology at most every 15 minutes. */
const SYNC_EVERY_MS = 5 * 60_000;

/**
 * Keeps Schoology tasks up to date while the app is open (SchoologyService.sync: new assignments, turn-ins, classes),
 * then syncs the workspace when something changed. Mounted once in the app for members of the beta; renders nothing.
 */
export function SchoologySync({ accountId, online, synchronize }: { accountId: string; online: boolean; synchronize: () => Promise<unknown> }) {
  const beta = useBeta(SCHOOLOGY_BETA);
  // The session hands a new synchronize on each render; keep the latest without restarting the timer.
  const synchronizeRef = useRef(synchronize);
  useEffect(() => { synchronizeRef.current = synchronize; });
  useEffect(() => {
    if (!beta || !online) return;
    let cancelled = false;
    const run = () => api.schoology.sync.mutate({ accountId })
      .then(({ changed }) => { if (changed > 0 && !cancelled) return synchronizeRef.current(); }, () => undefined);
    void run();
    const timer = window.setInterval(() => void run(), SYNC_EVERY_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [beta, online, accountId]);
  return null;
}

/**
 * The member's Schoology connection for the Grades tab: its status, the connect and finish steps (including the
 * return from Schoology's approval page), the two import switches and disconnect. `onConnected` runs after a
 * handshake finishes, so the caller can load grades.
 */
export function useSchoologyConnection(state: AppState, onConnected: () => void) {
  const accountId = state.context.user.id;
  const [status, setStatus] = useState<SchoologyStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [pending, setPending] = useState<SchoologyPending>(null);
  const [error, setError] = useState('');
  // Schoology may or may not add oauth_token to the return address; the server knows which handshake this account started.
  const returned = state.params.get(SCHOOLOGY_RETURN_PARAM) === 'return';
  const returnedToken = state.params.get('oauth_token') ?? undefined;
  const handled = useRef(false);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; });

  const reload = useCallback(() => api.schoology.status.query().then(next => { setStatus(next); setStatusFailed(false); return next; }, () => { setStatusFailed(true); return null; }), []);
  const finish = useCallback(async (oauthToken?: string) => {
    setPending('finish'); setError('');
    try {
      await api.schoology.finish.mutate({ accountId, oauthToken });
      await state.refresh();
      // Bring in assignments and classes right away instead of waiting for the next pass.
      await api.schoology.sync.mutate({ accountId, force: true }).then(({ changed }) => changed > 0 && state.refresh(), () => undefined);
      await reload();
      onConnectedRef.current();
    } catch (err) {
      setError(errorMessage(err));
      await reload();
    } finally { setPending(null); }
  }, [accountId, state, reload]);

  useEffect(() => { if (!returned && state.online) void reload(); }, [returned, state.online, reload]);
  // Back from Schoology: finish once, and clean the address so a reload doesn't try again.
  useEffect(() => {
    if (!returned || handled.current) return;
    handled.current = true;
    state.navigate('classes', { tab: 'grades' }, { replace: true });
    void finish(returnedToken);
  }, [returned, returnedToken, state, finish]);

  const connect = async () => {
    setPending('connect'); setError('');
    try { window.location.assign((await api.schoology.start.mutate({ accountId })).url); }
    catch (err) { setError(errorMessage(err)); setPending(null); }
  };
  const disconnect = async () => {
    setPending('disconnect'); setError('');
    try { setStatus(await api.schoology.disconnect.mutate({ accountId })); await state.refresh(); }
    catch (err) { setError(errorMessage(err)); }
    setPending(null);
  };
  const setting = async (change: { importAssignments?: boolean; autoComplete?: boolean }) => {
    setPending('settings'); setError('');
    try {
      setStatus(await api.schoology.setSettings.mutate({ accountId, ...change }));
      if ((await api.schoology.sync.mutate({ accountId, force: true })).changed > 0) await state.refresh();
    } catch (err) { setError(errorMessage(err)); }
    setPending(null);
  };
  const connected = status?.beta ? status.connected : null;
  return { status, statusFailed, connected, pending, error, connecting: returned || pending === 'finish', reload, finish, connect, disconnect, setting };
}
export type SchoologyConnection = ReturnType<typeof useSchoologyConnection>;

/** "Connect Schoology" and, when an approval is waiting, "Finish connecting": the two ways into a connection. */
export function SchoologyConnect({ state, connection }: { state: AppState; connection: SchoologyConnection }) {
  const { status, pending } = connection;
  const unavailable = status?.beta === true && !status.available;
  return <div className="grid justify-items-center gap-3">
    <Button variant="primary" busy={pending === 'connect' || pending === 'finish'} disabled={!state.online || pending !== null || unavailable} onClick={() => void connection.connect()}>Connect Schoology</Button>
    {unavailable && <Hint>Connecting Schoology isn’t set up on this server yet.</Hint>}
    {status?.beta && status.pendingConnection && <div className="grid max-w-[44ch] justify-items-center gap-2 rounded-xl bg-muted/80 px-4 py-3">
      <Hint>If you approved Quasar but Schoology stayed blank, finish connecting here. Approval expires 15 minutes after you start.</Hint>
      <Button size="sm" busy={pending === 'finish'} disabled={!state.online || pending !== null} onClick={() => void connection.finish()}>Finish connecting</Button>
    </div>}
  </div>;
}

/** Schoology settings, opened from the Grades tab: who is connected, the two task switches, where tasks go, disconnect. */
export function SchoologySettings({ state, connection, open }: { state: AppState; connection: SchoologyConnection; open: boolean }) {
  const { connected, pending } = connection;
  const [sections, setSections] = useState<Sections | null>(null);
  const isConnected = connected !== null;
  useEffect(() => {
    if (!open || !isConnected) return;
    let cancelled = false;
    api.schoology.sections.query().then(next => { if (!cancelled) setSections(next); }, () => undefined);
    return () => { cancelled = true; };
  }, [open, isConnected, connected?.syncedAt]);
  if (!connected) return <Hint>Schoology isn’t connected.</Hint>;
  const busy = !state.online || pending !== null;
  return <div className="grid gap-4">
    <div className="grid gap-1 text-sm">
      <strong>Connected as {connected.name}</strong>
      <Hint>Quasar reads your grades from Schoology each time and doesn’t save them. It saves only the goals you set.</Hint>
    </div>
    <div className="grid gap-3 rounded-xl bg-muted/80 px-3 py-3">
      <Toggle checked={connected.importAssignments} disabled={busy} onChange={(value) => void connection.setting({ importAssignments: value })}
        label="Add Schoology assignments to Tasks" description="Assignments due from two weeks ago on, plus ones with no due date. Anything your calendar link already brings in isn’t added twice." />
      <Toggle checked={connected.autoComplete} disabled={busy} onChange={(value) => void connection.setting({ autoComplete: value })}
        label="Check off tasks you turn in on Schoology" description="Once per assignment, so a task you reopen stays open." />
      {connected.syncedAt && <Hint>Checked Schoology for assignments {new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(connected.syncedAt))}</Hint>}
    </div>
    {connection.error && <Callout tone="danger" icon="alert" role="alert">{connection.error}</Callout>}
    {sections && sections.sections.length > 0 && <SectionClasses state={state} sections={sections} onChange={setSections} />}
    <div><Button size="sm" variant="ghost" busy={pending === 'disconnect'} disabled={busy} onClick={() => void connection.disconnect()}>Disconnect Schoology</Button></div>
  </div>;
}

/**
 * "Tasks from Schoology go to": where each Schoology class's imported tasks land. Quasar matches by name and leaves
 * a task without a class when it can't tell; the student can pick the class, or turn tagging off, per section.
 */
function SectionClasses({ state, sections, onChange }: { state: AppState; sections: Sections; onChange: (next: Sections) => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const names = new Map(sections.classes.map(entry => [entry.id, entry.name]));
  const choose = async (sectionId: string, value: string) => {
    setSaving(sectionId); setError('');
    try {
      onChange(await api.schoology.setSectionClass.mutate({ accountId: state.context.user.id, sectionId, classId: value === 'auto' ? 'auto' : value === 'none' ? null : value }));
      await state.refresh();
    } catch (err) { setError(errorMessage(err)); }
    setSaving(null);
  };
  return <div className="grid gap-2">
    <strong className="text-sm">Tasks from Schoology go to</strong>
    <Hint>Quasar puts each imported assignment in the class it matches by name, and leaves it blank when it can’t tell. Fix a match here; tasks you changed yourself stay as they are.</Hint>
    <ul className="grid gap-1.5 text-sm" aria-label="Where Schoology tasks go">
      {sections.sections.map(section => <li key={section.sectionId} className="grid gap-1.5 rounded-lg bg-muted/80 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center">
        <span className="min-w-0 truncate">{section.title}</span>
        <Select small aria-label={`Class for ${section.title}`} disabled={!state.online || saving !== null}
          value={section.chosen ? section.classId ?? 'none' : 'auto'} onChange={(event) => void choose(section.sectionId, event.target.value)}>
          <option value="auto">{section.auto ? `Match by name: ${names.get(section.auto) ?? 'a class'}` : 'Match by name: no match'}</option>
          {sections.classes.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          <option value="none">Don’t add a class</option>
        </Select>
      </li>)}
    </ul>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </div>;
}
