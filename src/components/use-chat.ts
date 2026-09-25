'use client';

/**
 * Chat delivery for the Messages view (docs/CHAT.md §6). Chat is online only: messages, drafts and
 * unsent messages live in this module's memory for the open tab and never reach IndexedDB, the
 * offline queue, localStorage or the service-worker cache.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, errorMessage, isTransportFailure, isUnauthorized, type RouterOutput } from '@/client/api';
import { CHAT } from '@/domain/chat';
import type { AppState } from './app-state';

type ChatRouter = RouterOutput['chat'];
type GlobalRouter = RouterOutput['global'];
type GroupRouter = RouterOutput['group'];
export type ChatInbox = ChatRouter['inbox'];
export type ChatInboxRow = ChatInbox['rows'][number];
export type ChatThreadResult = ChatRouter['thread'];
export type GlobalThreadResult = GlobalRouter['thread'];
export type GroupThreadResult = GroupRouter['thread'];
export type GlobalSummary = ChatInbox['global'];
export type GroupSummary = ChatInbox['groups'][number];
export type ChatPeer = ChatThreadResult['peer'];
export type GlobalRoom = GlobalThreadResult['room'];
export type GroupInfo = GroupThreadResult['group'];
export type GroupMember = GroupInfo['members'][number];
/** Another member's delivery and read markers and typing signal (docs/CHAT.md §13). */
export type Receipt = ChatThreadResult['receipts'][number];
export type ChatPause = NonNullable<ChatThreadResult['pause']>;
/** A message in any kind of thread. Global and group messages also carry their sender (and, in the room, an edit stamp). */
export type ChatMessage = ChatThreadResult['messages'][number] | GlobalThreadResult['messages'][number] | GroupThreadResult['messages'][number];
export type GlobalMessage = GlobalThreadResult['messages'][number];
/** Which conversation a thread hook drives: one friend, a friend group (§12), or the global room (§11). */
export type ChatTarget = { kind: 'peer'; userId: string } | { kind: 'global' } | { kind: 'group'; groupId: string };
export const GLOBAL_TARGET: ChatTarget = { kind: 'global' };
const targetKey = (target: ChatTarget) => (target.kind === 'peer' ? target.userId : target.kind === 'group' ? `group:${target.groupId}` : 'global');

/** Window event that asks every mounted chat poller to poll now (Tracker fires it on a service-worker CHAT_ACTIVITY message). */
export const CHAT_ACTIVITY_EVENT = 'quasar:chat-activity';

const THREAD_POLL_MS = 4_000;
const INBOX_POLL_MS = 10_000;
const MAX_POLL_MS = 30_000;
const SEND_TIMEOUT_MS = 15_000;
const SEND_RETRY_MS = 2_000;

/** An outgoing message that the server has not confirmed yet. `clientId` becomes the message `id`. */
export type Outgoing = {
  clientId: string;
  body: string;
  status: 'pending' | 'failed';
  /** The server's fixed message, when there is one. Network failures have none. */
  error?: string;
  /** Retry is offered (network, timeout, 5xx, rate limit). Otherwise only Discard. */
  retryable: boolean;
  /** Failed for network reasons, so it retries by itself when the device comes back online. */
  network: boolean;
};

/* ---------- Module memory: pending sends and drafts, keyed by `${accountId}:${userId}` (or `:global`) ---------- */

export interface ThreadMemory {
  key: string;
  accountId: string;
  target: ChatTarget;
  draft: string;
  outgoing: Outgoing[];
  /** Server messages from successful sends, waiting for the mounted thread to merge them. */
  delivered: ChatMessage[];
  /** Set when a send learns the chat is closed. */
  closed: boolean;
  /** Set when the thread should poll at once (a send succeeded, or was refused because of a pause). */
  pollRequested: boolean;
  sending: boolean;
  refresh: (() => Promise<unknown>) | null;
  listeners: Set<() => void>;
}

const memory: { accountId: string | null; threads: Map<string, ThreadMemory> } = { accountId: null, threads: new Map() };

/** Another account's drafts and unsent messages never survive an account switch in this tab. */
function claimAccount(accountId: string) {
  if (memory.accountId === accountId) return;
  memory.threads.clear();
  memory.accountId = accountId;
}

/** Forgets every draft and unsent message (for sign-out). In-flight sends stop touching the cleared entries. */
export function clearChatMemory(): void {
  memory.threads.clear();
  memory.accountId = null;
}

/** This account's memory for one conversation, created on first use. Exported for tests. */
export function threadMemory(accountId: string, target: ChatTarget): ThreadMemory {
  claimAccount(accountId);
  const key = `${accountId}:${targetKey(target)}`;
  let entry = memory.threads.get(key);
  if (!entry) {
    entry = { key, accountId, target, draft: '', outgoing: [], delivered: [], closed: false, pollRequested: false, sending: false, refresh: null, listeners: new Set() };
    memory.threads.set(key, entry);
  }
  return entry;
}

const live = (entry: ThreadMemory) => memory.threads.get(entry.key) === entry;

function emit(entry: ThreadMemory) {
  for (const listener of [...entry.listeners]) listener();
}

function setOutgoing(entry: ThreadMemory, outgoing: Outgoing[]) {
  entry.outgoing = outgoing;
  emit(entry);
}

/* ---------- Send queue ---------- */

type ErrorData = { code?: string; httpStatus?: number };
function errorData(error: unknown): ErrorData | undefined {
  return error && typeof error === 'object' && 'data' in error ? (error as { data?: ErrorData }).data ?? undefined : undefined;
}
export function errorCode(error: unknown): string | undefined {
  return errorData(error)?.code;
}

function aborted(error: unknown): boolean {
  const names = ['AbortError', 'TimeoutError'];
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return names.includes(error.name) || (cause instanceof Error && names.includes(cause.name)) || (typeof DOMException !== 'undefined' && cause instanceof DOMException && names.includes(cause.name));
}

export type Failure = { retryable: boolean; network: boolean; error?: string; code?: string };

/** §6 failure table: network, timeout and 5xx retry; rate limits offer Retry; everything else is Discard only. */
export function classifySendError(error: unknown): Failure {
  const data = errorData(error);
  if (aborted(error) || isTransportFailure(error) || (data?.httpStatus ?? 0) >= 500) return { retryable: true, network: true };
  const code = data?.code;
  const message = errorMessage(error);
  if (code === 'TOO_MANY_REQUESTS' || code === 'UNAUTHORIZED') return { retryable: true, network: false, error: message, code };
  return { retryable: false, network: false, error: message, code };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const timeoutSignal = (ms: number): AbortSignal | undefined => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);
const isQueued = (entry: ThreadMemory, clientId: string) => entry.outgoing.some((item) => item.clientId === clientId && item.status === 'pending');

/** One message, with one automatic retry after 2 s (same clientId) for network failures. */
async function deliver(entry: ThreadMemory, item: Outgoing): Promise<{ message: ChatMessage } | { failure: Failure } | 'gone'> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const options = { signal: timeoutSignal(SEND_TIMEOUT_MS) };
      const result = entry.target.kind === 'peer'
        ? await api.chat.send.mutate({ accountId: entry.accountId, userId: entry.target.userId, clientId: item.clientId, body: item.body }, options)
        : entry.target.kind === 'group'
          ? await api.group.send.mutate({ accountId: entry.accountId, groupId: entry.target.groupId, clientId: item.clientId, body: item.body }, options)
          : await api.global.send.mutate({ accountId: entry.accountId, clientId: item.clientId, body: item.body }, options);
      return { message: result.message };
    } catch (error) {
      const failure = classifySendError(error);
      if (!failure.network || attempt > 0) return { failure };
      await wait(SEND_RETRY_MS);
      // A poll may have found the message meanwhile (the response was lost), or the memory was cleared.
      if (!live(entry) || !isQueued(entry, item.clientId)) return 'gone';
    }
  }
}

/** Sends queued messages one at a time, in order. A failure fails everything queued behind it. */
export async function pump(entry: ThreadMemory): Promise<void> {
  if (entry.sending) return;
  entry.sending = true;
  try {
    for (;;) {
      if (!live(entry)) return;
      const item = entry.outgoing.find((candidate) => candidate.status === 'pending');
      if (!item) return;
      const outcome = await deliver(entry, item);
      if (!live(entry)) return;
      if (outcome === 'gone') continue;
      if ('message' in outcome) {
        entry.delivered.push(outcome.message);
        entry.pollRequested = true;
        setOutgoing(entry, entry.outgoing.filter((candidate) => candidate.clientId !== item.clientId));
        continue;
      }
      const index = entry.outgoing.findIndex((candidate) => candidate.clientId === item.clientId);
      if (index < 0) continue; // A poll reconciled it while the request was out.
      const { failure } = outcome;
      const next = entry.outgoing.map((candidate, position): Outgoing => {
        if (position === index) return { ...candidate, status: 'failed', error: failure.error, retryable: failure.retryable, network: failure.network };
        if (position > index && candidate.status === 'pending') return { ...candidate, status: 'failed', error: undefined, retryable: true, network: failure.network };
        return candidate;
      });
      if (failure.code === 'NOT_FOUND') entry.closed = true;
      if (failure.code === 'FORBIDDEN') entry.pollRequested = true; // Picks up the pause so the composer explains it.
      if (failure.code === 'UNAUTHORIZED') void entry.refresh?.();
      setOutgoing(entry, next);
    }
  } finally {
    entry.sending = false;
  }
}

/** Requeues failed messages in their original order. `networkOnly` is the automatic retry on reconnect. */
export function requeue(entry: ThreadMemory, networkOnly: boolean): boolean {
  let changed = false;
  const next = entry.outgoing.map((item): Outgoing => {
    if (item.status !== 'failed' || !item.retryable || (networkOnly && !item.network)) return item;
    changed = true;
    return { ...item, status: 'pending', error: undefined, network: false };
  });
  if (changed) setOutgoing(entry, next);
  return changed;
}

/** Queues a new message behind any unsent ones and starts sending when nothing ahead of it failed. */
export function enqueue(entry: ThreadMemory, body: string) {
  // Only Retry (or reconnecting, for network failures) resends a failed message, so a new message never
  // sends one the student left at "Not sent.". To keep the order, the new message waits behind them as
  // failed too, and Retry sends them all in order. It joins the automatic reconnect retry only when
  // everything ahead of it failed for network reasons, so it can never overtake a rate-limited message.
  const blocking = entry.outgoing.filter((item) => item.status === 'failed' && item.retryable);
  const item: Outgoing = blocking.length
    ? { clientId: crypto.randomUUID(), body, status: 'failed', retryable: true, network: blocking.every((candidate) => candidate.network) }
    : { clientId: crypto.randomUUID(), body, status: 'pending', retryable: true, network: false };
  setOutgoing(entry, [...entry.outgoing, item]);
  if (item.status === 'pending') void pump(entry);
}

/**
 * The automatic retry when the device comes back online (§6): resends messages that failed for network
 * reasons in every thread of this account, not only the open one. Tracker calls it when `online` turns true.
 */
export function resumeChatSends(accountId: string): void {
  if (memory.accountId !== accountId) return;
  for (const entry of memory.threads.values()) if (requeue(entry, true)) void pump(entry);
}

/** Lost response: a polled message whose id matches an unconfirmed clientId means it was stored. */
export function reconcile(entry: ThreadMemory, messages: ChatMessage[]) {
  if (!entry.outgoing.length) return;
  const stored = new Set(messages.filter((message) => message.fromMe).map((message) => message.id));
  if (entry.outgoing.some((item) => stored.has(item.clientId))) setOutgoing(entry, entry.outgoing.filter((item) => !stored.has(item.clientId)));
}

/* ---------- Polling ---------- */

type PollOutcome = 'ok' | 'fail' | 'stop';

/**
 * A chained-setTimeout poller with one request in flight, doubling backoff on failure (capped at
 * 30 s), an AbortController per request, and immediate polls on visibility, reconnect and the
 * chat-activity event. It only polls while the page is visible and `online` is true.
 */
function usePoller(key: string, enabled: boolean, online: boolean, baseMs: number, run: (signal: AbortSignal) => Promise<PollOutcome>) {
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });
  const onlineRef = useRef(online);
  useEffect(() => { onlineRef.current = online; }, [online]);
  const control = useRef<{ now: () => void } | null>(null);
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let stopped = false;
    let inFlight = false;
    let again = false;
    let delay = baseMs;
    let failed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => void tick(), ms); };
    const tick = async () => {
      if (disposed || stopped) return;
      if (inFlight) { again = true; return; }
      // Hidden or offline: stay idle until the visibility or online trigger calls now().
      if (document.visibilityState !== 'visible' || !onlineRef.current) return;
      inFlight = true;
      controller = new AbortController();
      let outcome: PollOutcome;
      try { outcome = await runRef.current(controller.signal); } catch { outcome = 'fail'; }
      inFlight = false;
      controller = null;
      if (disposed) return;
      if (outcome === 'stop') { stopped = true; return; }
      if (outcome === 'ok') { failed = 0; delay = baseMs; } else { failed += 1; delay = Math.min(delay * 2, MAX_POLL_MS); }
      setFailures(failed);
      if (again) { again = false; schedule(0); } else schedule(delay);
    };
    control.current = {
      now: () => {
        if (disposed) return;
        stopped = false;
        if (inFlight) again = true;
        else schedule(0);
      },
    };
    schedule(0);
    const onVisibility = () => { if (document.visibilityState === 'visible') control.current?.now(); };
    const onActivity = () => control.current?.now();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(CHAT_ACTIVITY_EVENT, onActivity);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      control.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(CHAT_ACTIVITY_EVENT, onActivity);
      setFailures(0);
    };
  }, [key, enabled, baseMs]);

  // An effect dependency, not a raw `online` listener: use-workspace flips `online` in its own listener.
  useEffect(() => { if (online) control.current?.now(); }, [online]);

  const pollNow = useCallback(() => control.current?.now(), []);
  return { pollNow, failures };
}

/* ---------- Inbox ---------- */

/**
 * The chat list. Polls every 10 s while `active` (the list pane is mounted), visible and online.
 * `reload()` also works while inactive, as a single fetch (the phone thread uses it to find a closed row).
 */
export function useChatInbox(state: AppState, active = true) {
  const accountId = state.context.user.id;
  claimAccount(accountId);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });
  const [inbox, setInbox] = useState<ChatInbox | null>(null);
  const [error, setError] = useState('');

  const fetchInbox = useCallback(async (signal?: AbortSignal): Promise<PollOutcome> => {
    try {
      const result = await api.chat.inbox.query({ accountId }, { signal });
      if (signal?.aborted) return 'ok';
      setInbox(result);
      setError('');
      latest.current.setChatUnread(result.unreadChats, result.unreadAt);
      return 'ok';
    } catch (err) {
      if (signal?.aborted) return 'ok';
      if (isUnauthorized(err)) void latest.current.refresh();
      setError(errorMessage(err));
      return 'fail';
    }
  }, [accountId]);

  const { pollNow, failures } = usePoller(`inbox:${accountId}`, active, state.online, INBOX_POLL_MS, fetchInbox);
  useEffect(() => { setInbox(null); setError(''); }, [accountId]);

  const reload = useCallback(() => {
    if (active) pollNow();
    else if (latest.current.online) void fetchInbox();
  }, [active, pollNow, fetchInbox]);

  return {
    inbox,
    error,
    loading: state.online && !inbox && !error,
    /** Two or more polls in a row failed. */
    reconnecting: failures >= 2,
    reload,
  };
}

/* ---------- Thread ---------- */

type ThreadData = { peer: ChatPeer | null; room: GlobalRoom | null; group: GroupInfo | null; messages: ChatMessage[]; hasEarlier: boolean; muted: boolean; pause: ChatPause | null; receipts: Receipt[] };
type ThreadPage = { peer: ChatPeer | null; room?: GlobalRoom; group?: GroupInfo; receipts: Receipt[]; messages: ChatMessage[]; revision: number; lastReadSeq: number; hasEarlier: boolean; reset: boolean; muted: boolean; pause: ChatPause | null };

/** The thread query for any target. All three endpoints answer with the same page shape. */
function queryThread(accountId: string, target: ChatTarget, cursor: { after?: number; before?: number }, signal?: AbortSignal): Promise<ThreadPage> {
  if (target.kind === 'peer') return api.chat.thread.query({ accountId, userId: target.userId, ...cursor }, { signal });
  if (target.kind === 'group') return api.group.thread.query({ accountId, groupId: target.groupId, ...cursor }, { signal });
  return api.global.thread.query({ accountId, ...cursor }, { signal });
}
export type ThreadStatus = 'loading' | 'ready' | 'error' | 'closed';

/**
 * Applies changed messages: each replaces the local one with the same seq or is inserted in seq
 * order. With earlier pages still unloaded, a change older than the oldest loaded message is
 * dropped; it arrives fresh with its page.
 */
export function mergeMessages(current: ChatMessage[], changes: ChatMessage[], hasEarlier: boolean): ChatMessage[] {
  if (!changes.length) return current;
  const lowest = current.length ? current[0]!.seq : null;
  const bySeq = new Map(current.map((message) => [message.seq, message]));
  for (const message of changes) {
    if (hasEarlier && lowest !== null && message.seq < lowest) continue;
    bySeq.set(message.seq, message);
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/**
 * Adds an older page under the loaded messages, but only while the page still sits right under them: when a
 * reset poll replaced the list while the request was out (the oldest loaded seq is no longer `anchorSeq`),
 * the page is dropped, because merging it would leave a gap between it and the new latest page that no later
 * "Load earlier" could fill.
 */
export function prependEarlier<T extends { messages: ChatMessage[]; hasEarlier: boolean }>(previous: T | null, anchorSeq: number, page: { messages: ChatMessage[]; hasEarlier: boolean }): T | null {
  if (!previous || previous.messages[0]?.seq !== anchorSeq) return previous;
  return { ...previous, hasEarlier: page.hasEarlier, messages: mergeMessages(page.messages, previous.messages, false) };
}

/**
 * One conversation: a friend, or the global room. Render it with a key per target so a different chat
 * starts from a clean state. `onChange` runs after this tab changes something the chat list shows
 * (send, delete, edit, read, mute).
 */
export function useChatThread(state: AppState, target: ChatTarget, options: { onChange?: () => void } = {}) {
  const accountId = state.context.user.id;
  const entry = threadMemory(accountId, target);
  const userId = target.kind === 'peer' ? target.userId : null;
  const groupId = target.kind === 'group' ? target.groupId : null;
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });
  const onChangeRef = useRef(options.onChange);
  useEffect(() => { onChangeRef.current = options.onChange; });
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const [data, setData] = useState<ThreadData | null>(null);
  const [status, setStatus] = useState<ThreadStatus>('loading');
  const [error, setError] = useState('');
  const [lastReadSeq, setLastReadSeq] = useState(0);
  /** The read marker when the thread first loaded; the "New messages" divider stays where it was. */
  const [initialReadSeq, setInitialReadSeq] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** Revision cursor. Only polls advance it; `send` returns no revision on purpose. */
  const cursor = useRef<number | null>(null);
  const muteVersion = useRef(0);
  const readRequested = useRef(0);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const lastReadRef = useRef(lastReadSeq);
  useEffect(() => { lastReadRef.current = lastReadSeq; }, [lastReadSeq]);

  const poll = useCallback(async (signal: AbortSignal): Promise<PollOutcome> => {
    const after = cursor.current;
    const muteAtStart = muteVersion.current;
    try {
      const result = await queryThread(accountId, entry.target, after === null ? {} : { after }, signal);
      if (signal.aborted) return 'ok';
      const full = after === null || result.reset;
      cursor.current = result.revision;
      setData((previous) => {
        // A mute toggled while this poll was out wins over the poll's older value.
        const muted = previous && muteAtStart !== muteVersion.current ? previous.muted : result.muted;
        const room = result.room ?? null;
        const group = result.group ?? null;
        const receipts = result.receipts ?? [];
        if (full || !previous) return { peer: result.peer, room, group, receipts, messages: result.messages, hasEarlier: result.hasEarlier, muted, pause: result.pause };
        return { peer: result.peer, room, group, receipts, messages: mergeMessages(previous.messages, result.messages, previous.hasEarlier), hasEarlier: previous.hasEarlier, muted, pause: result.pause };
      });
      setLastReadSeq((previous) => Math.max(previous, result.lastReadSeq));
      setInitialReadSeq((previous) => previous ?? result.lastReadSeq);
      setStatus('ready');
      setError('');
      reconcile(entry, result.messages);
      return 'ok';
    } catch (err) {
      if (signal.aborted) return 'ok';
      const code = errorCode(err);
      if (code === 'NOT_FOUND') { setStatus('closed'); return 'stop'; }
      if (code === 'UNAUTHORIZED') void latest.current.refresh();
      if (after === null) { setError(errorMessage(err)); setStatus((current) => (current === 'loading' ? 'error' : current)); }
      return 'fail';
    }
  }, [accountId, entry]);

  const { pollNow, failures } = usePoller(entry.key, status !== 'closed', state.online, THREAD_POLL_MS, poll);

  // Listen to the module memory: merge confirmed sends, poll after a send, close on "This chat is closed.".
  useEffect(() => {
    entry.closed = false;
    entry.delivered = [];
    entry.pollRequested = false;
    entry.refresh = () => latest.current.refresh();
    const listener = () => {
      if (entry.delivered.length) {
        const delivered = entry.delivered;
        entry.delivered = [];
        setData((previous) => previous && { ...previous, messages: mergeMessages(previous.messages, delivered, previous.hasEarlier) });
        onChangeRef.current?.();
      }
      if (entry.pollRequested) { entry.pollRequested = false; pollNow(); }
      if (entry.closed) setStatus('closed');
      rerender();
    };
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry, pollNow]);

  // Coming back online retries network failures through resumeChatSends (Tracker); opening a thread never resends.

  const loadEarlier = useCallback(async () => {
    const first = dataRef.current?.messages[0];
    if (!first) return;
    setLoadingEarlier(true);
    try {
      const result = await queryThread(accountId, entry.target, { before: first.seq });
      // An older page never moves the revision cursor, so no change can be skipped.
      setData((previous) => prependEarlier(previous, first.seq, result));
    } catch (err) {
      if (errorCode(err) === 'NOT_FOUND') { setStatus('closed'); return; }
      if (isUnauthorized(err)) void latest.current.refresh();
      throw err;
    } finally {
      setLoadingEarlier(false);
    }
  }, [accountId, entry]);

  /** Marks everything up to `seq` read. Only moves forward; errors wait for the next chance. */
  const markRead = useCallback(async (seq: number) => {
    if (!latest.current.online || seq <= Math.max(lastReadRef.current, readRequested.current)) return;
    readRequested.current = seq;
    try {
      // Both answer with the server-stamped badge count, so the badge updates even while the list is unmounted (phones).
      const result = userId ? await api.chat.read.mutate({ accountId, userId, seq }) : groupId ? await api.group.read.mutate({ accountId, groupId, seq }) : await api.global.read.mutate({ accountId, seq });
      latest.current.setChatUnread(result.unreadChats, result.unreadAt);
      setLastReadSeq((previous) => Math.max(previous, seq));
      onChangeRef.current?.();
    } catch (err) {
      readRequested.current = lastReadRef.current;
      if (errorCode(err) === 'NOT_FOUND') setStatus('closed');
      else if (isUnauthorized(err)) void latest.current.refresh();
    }
  }, [accountId, userId, groupId]);

  const setMuted = useCallback(async (muted: boolean) => {
    muteVersion.current += 1;
    try {
      const result = userId ? await api.chat.mute.mutate({ accountId, userId, muted }) : groupId ? await api.group.mute.mutate({ accountId, groupId, muted }) : await api.global.mute.mutate({ accountId, muted });
      muteVersion.current += 1;
      setData((previous) => previous && { ...previous, muted: result.muted });
      // Muted chats are left out of the badge (§3.4), so the new count comes back with the answer.
      latest.current.setChatUnread(result.unreadChats, result.unreadAt);
      onChangeRef.current?.();
    } catch (err) {
      if (errorCode(err) === 'NOT_FOUND') { setStatus('closed'); return; }
      if (isUnauthorized(err)) void latest.current.refresh();
      throw err;
    }
  }, [accountId, userId, groupId]);

  /** `reason` is the owner's note, shown to everyone; it only applies to global messages the owner removes. */
  const deleteMessage = useCallback(async (messageId: string, reason = '') => {
    try {
      if (userId) await api.chat.delete.mutate({ accountId, userId, messageId });
      else if (groupId) await api.group.delete.mutate({ accountId, groupId, messageId });
      else await api.global.delete.mutate({ accountId, messageId, reason });
    } catch (err) {
      // A private chat that vanished is closed; a global or group message that vanished is simply gone, and the poll shows that.
      if (errorCode(err) === 'NOT_FOUND' && (userId || (groupId && errorMessage(err) === 'You are not in this group.'))) { setStatus('closed'); return; }
      if (isUnauthorized(err)) void latest.current.refresh();
      throw err;
    }
    // The owner's (or a group admin's) removal of someone else's message shows with its note once the poll lands.
    setData((previous) => previous && { ...previous, messages: previous.messages.map((message): ChatMessage => (message.id === messageId
      ? { ...message, body: null, deletedBy: message.fromMe ? 'sender' : groupId ? 'admin' : 'owner', ...(message.fromMe || userId || groupId ? {} : { reason }) } as ChatMessage : message)) });
    pollNow();
    onChangeRef.current?.();
  }, [accountId, userId, groupId, pollNow]);

  /**
   * The typing signal (§13): `true` while the draft is being typed, renewed every CHAT.typingRenewMs so the server's
   * CHAT.typingMs expiry never lapses mid-sentence; `false` as soon as the draft is empty or the composer goes away.
   * Best effort: a failed signal is simply dropped. The room has no typing signal.
   */
  const typingOn = useRef(false);
  const typingSentAt = useRef(0);
  const signalTyping = useCallback((active: boolean) => {
    if (!userId && !groupId) return;
    const now = Date.now();
    if (active) {
      if (typingOn.current && now - typingSentAt.current < CHAT.typingRenewMs) return;
      typingOn.current = true; typingSentAt.current = now;
    } else {
      if (!typingOn.current) return;
      typingOn.current = false;
    }
    const call = userId ? api.chat.typing.mutate({ accountId, userId, typing: active }) : api.group.typing.mutate({ accountId, groupId: groupId!, typing: active });
    call.catch(() => undefined);
  }, [accountId, userId, groupId]);
  // Leaving the thread with a live signal turns it off, so nobody sees "typing" for a closed tab.
  useEffect(() => () => { if (typingOn.current) { typingOn.current = false; const cancel = userId ? api.chat.typing.mutate({ accountId, userId, typing: false }) : groupId ? api.group.typing.mutate({ accountId, groupId, typing: false }) : null; cancel?.catch(() => undefined); } }, [accountId, userId, groupId]);

  /** Owner only, global room only: replaces a message's text. The server applies the same body rules and filter. */
  const editMessage = useCallback(async (messageId: string, body: string, reason = '') => {
    if (userId) throw new Error('Only global chat messages can be edited.');
    let result: { message: GlobalMessage };
    try {
      result = await api.global.edit.mutate({ accountId, messageId, body, reason });
    } catch (err) {
      if (isUnauthorized(err)) void latest.current.refresh();
      throw err;
    }
    setData((previous) => previous && { ...previous, messages: previous.messages.map((message) => (message.id === messageId ? result.message : message)) });
    pollNow();
    onChangeRef.current?.();
  }, [accountId, userId, pollNow]);

  // A send clears the signal on the server too, so the flag only needs resetting here.
  const send = useCallback((body: string) => { typingOn.current = false; enqueue(entry, body); }, [entry]);
  const retry = useCallback(() => { if (requeue(entry, false)) void pump(entry); }, [entry]);
  const discard = useCallback((clientId: string) => setOutgoing(entry, entry.outgoing.filter((item) => item.clientId !== clientId)), [entry]);
  const saveDraft = useCallback((text: string) => { entry.draft = text; }, [entry]);

  const messages = data?.messages ?? [];
  const shown = new Set(messages.map((message) => message.id));
  return {
    status,
    /** Load error for the first page (the thread shows it with Try again). */
    error,
    peer: data?.peer ?? null,
    /** The global room's details; null otherwise. */
    room: data?.room ?? null,
    /** The friend group's details (name, members, the viewer's role); null otherwise. */
    group: data?.group ?? null,
    /** The other members' delivery and read markers and typing signals (§13); empty in the room. */
    receipts: data?.receipts ?? [],
    messages,
    hasEarlier: data?.hasEarlier ?? false,
    muted: data?.muted ?? false,
    pause: data?.pause ?? null,
    lastReadSeq,
    initialReadSeq,
    /** Two or more polls in a row failed. */
    reconnecting: failures >= 2,
    outgoing: entry.outgoing.filter((item) => !shown.has(item.clientId)),
    /** The draft kept in memory for this chat; the composer owns the live value. */
    initialDraft: entry.draft,
    saveDraft,
    send,
    retry,
    discard,
    loadEarlier,
    loadingEarlier,
    pollNow,
    markRead,
    setMuted,
    deleteMessage,
    editMessage,
    signalTyping,
  };
}

export type ChatThread = ReturnType<typeof useChatThread>;

/* ---------- Phone thread sizing ---------- */

/**
 * While a phone thread is mounted, sets `--chat-h` on <html> to the visual viewport height minus the
 * top bar, so the composer stays above the on-screen keyboard (iOS Safari ignores interactive-widget).
 */
export function useChatViewport(active: boolean): void {
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const update = () => {
      const topbar = document.querySelector<HTMLElement>('.app-topbar');
      const height = (viewport?.height ?? window.innerHeight) - (topbar?.offsetHeight ?? 0);
      root.style.setProperty('--chat-h', `${Math.max(0, Math.round(height))}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      root.style.removeProperty('--chat-h');
    };
  }, [active]);
}
