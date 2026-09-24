'use client';

/**
 * Chat delivery for the Messages view (docs/CHAT.md §6). Chat is online only: messages, drafts and
 * unsent messages live in this module's memory for the open tab and never reach IndexedDB, the
 * offline queue, localStorage or the service-worker cache.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, errorMessage, isTransportFailure, isUnauthorized, type RouterOutput } from '@/client/api';
import type { AppState } from './app-state';

type ChatRouter = RouterOutput['chat'];
type GlobalRouter = RouterOutput['global'];
export type ChatInbox = ChatRouter['inbox'];
export type ChatInboxRow = ChatInbox['rows'][number];
export type ChatThreadResult = ChatRouter['thread'];
export type GlobalThreadResult = GlobalRouter['thread'];
export type GlobalSummary = ChatInbox['global'];
export type ChatPeer = ChatThreadResult['peer'];
export type GlobalRoom = GlobalThreadResult['room'];
export type ChatPause = NonNullable<ChatThreadResult['pause']>;
/** A message in either kind of thread. Global messages also carry their sender and an edit stamp. */
export type ChatMessage = ChatThreadResult['messages'][number] | GlobalThreadResult['messages'][number];
export type GlobalMessage = GlobalThreadResult['messages'][number];
/** Which conversation a thread hook drives: one friend, or the global room (docs/CHAT.md §11). */
export type ChatTarget = { kind: 'peer'; userId: string } | { kind: 'global' };
export const GLOBAL_TARGET: ChatTarget = { kind: 'global' };
const targetKey = (target: ChatTarget) => (target.kind === 'peer' ? target.userId : 'global');

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

interface ThreadMemory {
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
  refresh: (() => Promise<void>) | null;
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

function threadMemory(accountId: string, target: ChatTarget): ThreadMemory {
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

type Failure = { retryable: boolean; network: boolean; error?: string; code?: string };

/** §6 failure table: network, timeout and 5xx retry; rate limits offer Retry; everything else is Discard only. */
function classifySendError(error: unknown): Failure {
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
async function pump(entry: ThreadMemory): Promise<void> {
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
function requeue(entry: ThreadMemory, networkOnly: boolean): boolean {
  let changed = false;
  const next = entry.outgoing.map((item): Outgoing => {
    if (item.status !== 'failed' || !item.retryable || (networkOnly && !item.network)) return item;
    changed = true;
    return { ...item, status: 'pending', error: undefined, network: false };
  });
  if (changed) setOutgoing(entry, next);
  return changed;
}

function enqueue(entry: ThreadMemory, body: string) {
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
function reconcile(entry: ThreadMemory, messages: ChatMessage[]) {
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

type ThreadData = { peer: ChatPeer | null; room: GlobalRoom | null; messages: ChatMessage[]; hasEarlier: boolean; muted: boolean; pause: ChatPause | null };
type ThreadPage = { peer: ChatPeer | null; room?: GlobalRoom; messages: ChatMessage[]; revision: number; lastReadSeq: number; hasEarlier: boolean; reset: boolean; muted: boolean; pause: ChatPause | null };

/** The thread query for either target. Both endpoints answer with the same page shape. */
function queryThread(accountId: string, target: ChatTarget, cursor: { after?: number; before?: number }, signal?: AbortSignal): Promise<ThreadPage> {
  if (target.kind === 'peer') return api.chat.thread.query({ accountId, userId: target.userId, ...cursor }, { signal });
  return api.global.thread.query({ accountId, ...cursor }, { signal });
}
export type ThreadStatus = 'loading' | 'ready' | 'error' | 'closed';

/**
 * Applies changed messages: each replaces the local one with the same seq or is inserted in seq
 * order. With earlier pages still unloaded, a change older than the oldest loaded message is
 * dropped; it arrives fresh with its page.
 */
function mergeMessages(current: ChatMessage[], changes: ChatMessage[], hasEarlier: boolean): ChatMessage[] {
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
 * One conversation: a friend, or the global room. Render it with a key per target so a different chat
 * starts from a clean state. `onChange` runs after this tab changes something the chat list shows
 * (send, delete, edit, read, mute).
 */
export function useChatThread(state: AppState, target: ChatTarget, options: { onChange?: () => void } = {}) {
  const accountId = state.context.user.id;
  const entry = threadMemory(accountId, target);
  const userId = target.kind === 'peer' ? target.userId : null;
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
        if (full || !previous) return { peer: result.peer, room, messages: result.messages, hasEarlier: result.hasEarlier, muted, pause: result.pause };
        return { peer: result.peer, room, messages: mergeMessages(previous.messages, result.messages, previous.hasEarlier), hasEarlier: previous.hasEarlier, muted, pause: result.pause };
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
      setData((previous) => previous && { ...previous, hasEarlier: result.hasEarlier, messages: mergeMessages(result.messages, previous.messages, false) });
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
      if (userId) {
        const result = await api.chat.read.mutate({ accountId, userId, seq });
        latest.current.setChatUnread(result.unreadChats, result.unreadAt);
      } else {
        await api.global.read.mutate({ accountId, seq });
      }
      setLastReadSeq((previous) => Math.max(previous, seq));
      onChangeRef.current?.();
    } catch (err) {
      readRequested.current = lastReadRef.current;
      if (errorCode(err) === 'NOT_FOUND') setStatus('closed');
      else if (isUnauthorized(err)) void latest.current.refresh();
    }
  }, [accountId, userId]);

  const setMuted = useCallback(async (muted: boolean) => {
    muteVersion.current += 1;
    try {
      const result = userId ? await api.chat.mute.mutate({ accountId, userId, muted }) : await api.global.mute.mutate({ accountId, muted });
      muteVersion.current += 1;
      setData((previous) => previous && { ...previous, muted: result.muted });
      onChangeRef.current?.();
    } catch (err) {
      if (errorCode(err) === 'NOT_FOUND') { setStatus('closed'); return; }
      if (isUnauthorized(err)) void latest.current.refresh();
      throw err;
    }
  }, [accountId, userId]);

  /** `reason` is the owner's note, shown to everyone; it only applies to global messages the owner removes. */
  const deleteMessage = useCallback(async (messageId: string, reason = '') => {
    try {
      if (userId) await api.chat.delete.mutate({ accountId, userId, messageId });
      else await api.global.delete.mutate({ accountId, messageId, reason });
    } catch (err) {
      // A private chat that vanished is closed; a global message that vanished is simply gone, and the poll shows that.
      if (errorCode(err) === 'NOT_FOUND' && userId) { setStatus('closed'); return; }
      if (isUnauthorized(err)) void latest.current.refresh();
      throw err;
    }
    // The owner's deletion of someone else's global message shows as "Removed by the owner" once the poll lands.
    setData((previous) => previous && { ...previous, messages: previous.messages.map((message): ChatMessage => (message.id === messageId
      ? { ...message, body: null, deletedBy: message.fromMe ? 'sender' : 'owner', ...(message.fromMe || userId ? {} : { reason }) } as ChatMessage : message)) });
    pollNow();
    onChangeRef.current?.();
  }, [accountId, userId, pollNow]);

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

  const send = useCallback((body: string) => enqueue(entry, body), [entry]);
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
    /** The global room's details; null for a one-to-one chat. */
    room: data?.room ?? null,
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
