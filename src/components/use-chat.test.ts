import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './use-chat';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/client/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/api')>()),
  api: { chat: { send: { mutate: send } }, global: { send: { mutate: send } } },
}));

const { classifySendError, clearChatMemory, enqueue, GLOBAL_TARGET, mergeMessages, prependEarlier, reconcile, requeue, pump, resumeChatSends, threadMemory } = await import('./use-chat');

const serverError = (message: string, code: string, httpStatus = 400) => new TRPCClientError(message, { result: { error: { message, code: -32600, data: { code, httpStatus } } } });
const offline = () => new TypeError('Failed to fetch');
const RATE = 'You’re sending messages too fast. Wait a minute and try again.';

const message = (seq: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${seq}`, seq, fromMe: false, body: `message ${seq}`, createdAt: '2026-09-24T12:00:00.000Z', deletedBy: null, ...extra }) as ChatMessage;
const seqs = (messages: ChatMessage[]) => messages.map((item) => item.seq);

/** Lets the send queue's promise chain run. */
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
/** A send that answers only when the test says so. */
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sentBodies = () => send.mock.calls.map(([input]) => (input as { body: string }).body);

describe('classifySendError (§6 failure table)', () => {
  it('retries network failures, timeouts and 5xx by itself', () => {
    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    for (const error of [offline(), timeout, serverError('Oops', 'INTERNAL_SERVER_ERROR', 500), serverError('Bad gateway', 'BAD_GATEWAY', 502)]) {
      expect(classifySendError(error)).toEqual({ retryable: true, network: true });
    }
  });

  it('offers Retry for rate limits and sign-in, but not an automatic resend', () => {
    expect(classifySendError(serverError(RATE, 'TOO_MANY_REQUESTS', 429))).toEqual({ retryable: true, network: false, error: RATE, code: 'TOO_MANY_REQUESTS' });
    expect(classifySendError(serverError('Sign in again.', 'UNAUTHORIZED', 401))).toEqual({ retryable: true, network: false, error: 'Sign in again.', code: 'UNAUTHORIZED' });
  });

  it('offers only Discard for everything else', () => {
    expect(classifySendError(serverError('This chat is closed.', 'NOT_FOUND', 404))).toEqual({ retryable: false, network: false, error: 'This chat is closed.', code: 'NOT_FOUND' });
    expect(classifySendError(serverError('Support paused your messaging.', 'FORBIDDEN', 403))).toMatchObject({ retryable: false, network: false, code: 'FORBIDDEN' });
  });
});

describe('mergeMessages', () => {
  it('replaces a message with the same seq and inserts new ones in seq order', () => {
    const merged = mergeMessages([message(2), message(4)], [message(4, { body: null, deletedBy: 'sender' }), message(3), message(5)], false);
    expect(seqs(merged)).toEqual([2, 3, 4, 5]);
    expect(merged[2]).toMatchObject({ seq: 4, body: null, deletedBy: 'sender' });
  });

  it('drops a change older than the oldest loaded message while earlier pages are unloaded', () => {
    expect(seqs(mergeMessages([message(10), message(11)], [message(3), message(12)], true))).toEqual([10, 11, 12]);
    expect(seqs(mergeMessages([message(10), message(11)], [message(3)], false))).toEqual([3, 10, 11]);
  });
});

describe('prependEarlier', () => {
  const page = { messages: [message(8), message(9)], hasEarlier: false };

  it('adds the older page under the loaded messages', () => {
    const next = prependEarlier({ messages: [message(10), message(11)], hasEarlier: true }, 10, page);
    expect(next).toMatchObject({ hasEarlier: false });
    expect(seqs(next!.messages)).toEqual([8, 9, 10, 11]);
  });

  it('drops the page when a reset poll replaced the list while it was loading', () => {
    // Load earlier asked for the page before seq 10; meanwhile a reset brought the latest page, 300 and up.
    const reset = { messages: [message(300), message(301)], hasEarlier: true };
    expect(prependEarlier(reset, 10, page)).toBe(reset);
    expect(prependEarlier(null, 10, page)).toBeNull();
  });
});

describe('send queue', () => {
  beforeEach(() => { vi.useFakeTimers(); send.mockReset(); clearChatMemory(); });
  afterEach(() => { vi.useRealTimers(); clearChatMemory(); });

  const entryFor = () => threadMemory('account-1', { kind: 'peer', userId: 'friend-1' });
  const statuses = (entry: ReturnType<typeof entryFor>) => entry.outgoing.map((item) => ({ body: item.body, status: item.status, retryable: item.retryable, network: item.network, error: item.error }));

  it('sends one message at a time, in order, and hands confirmed messages to the thread', async () => {
    const entry = entryFor();
    const first = deferred();
    send.mockImplementationOnce(() => first.promise).mockImplementation(async (input: { clientId: string; body: string }) => ({ message: message(2, { id: input.clientId, fromMe: true, body: input.body }) }));
    enqueue(entry, 'one');
    enqueue(entry, 'two');
    await settle();
    expect(sentBodies()).toEqual(['one']);
    first.resolve({ message: message(1, { id: entry.outgoing[0]!.clientId, fromMe: true, body: 'one' }) });
    await settle();
    expect(sentBodies()).toEqual(['one', 'two']);
    expect(entry.outgoing).toEqual([]);
    expect(entry.delivered.map((item) => item.body)).toEqual(['one', 'two']);
    expect(entry.pollRequested).toBe(true);
  });

  it('fails everything queued behind a failure, and keeps new messages behind it until Retry', async () => {
    const entry = entryFor();
    const first = deferred();
    send.mockImplementationOnce(() => first.promise);
    enqueue(entry, 'one');
    enqueue(entry, 'two');
    await settle();
    first.reject(serverError(RATE, 'TOO_MANY_REQUESTS', 429));
    await settle();
    expect(statuses(entry)).toEqual([
      { body: 'one', status: 'failed', retryable: true, network: false, error: RATE },
      { body: 'two', status: 'failed', retryable: true, network: false, error: undefined },
    ]);
    // A new message never overtakes a rate-limited one, and reconnecting does not resend any of them.
    enqueue(entry, 'three');
    resumeChatSends('account-1');
    await settle();
    expect(sentBodies()).toEqual(['one']);
    expect(statuses(entry).map((item) => [item.body, item.status, item.network])).toEqual([['one', 'failed', false], ['two', 'failed', false], ['three', 'failed', false]]);
    // Retry resends them all, in their original order.
    send.mockImplementation(async (input: { clientId: string; body: string }) => ({ message: message(9, { id: input.clientId, fromMe: true, body: input.body }) }));
    expect(requeue(entry, false)).toBe(true);
    await pump(entry);
    expect(sentBodies()).toEqual(['one', 'one', 'two', 'three']);
    expect(entry.outgoing).toEqual([]);
  });

  it('retries a network failure once after 2 s, then resends only network failures on reconnect', async () => {
    const entry = entryFor();
    send.mockRejectedValue(offline());
    enqueue(entry, 'one');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(statuses(entry)).toEqual([{ body: 'one', status: 'failed', retryable: true, network: true, error: undefined }]);
    // Behind network failures only, a new message joins the reconnect retry.
    enqueue(entry, 'two');
    expect(statuses(entry)[1]).toMatchObject({ body: 'two', status: 'failed', network: true });
    // A thread whose message was rate-limited is left alone on reconnect.
    const other = threadMemory('account-1', GLOBAL_TARGET);
    other.outgoing = [{ clientId: crypto.randomUUID(), body: 'room', status: 'failed', retryable: true, network: false, error: RATE }];
    send.mockReset();
    send.mockImplementation(async (input: { clientId: string; body: string }) => ({ message: message(5, { id: input.clientId, fromMe: true, body: input.body }) }));
    resumeChatSends('account-1');
    await settle();
    expect(sentBodies()).toEqual(['one', 'two']);
    expect(entry.outgoing).toEqual([]);
    expect(other.outgoing).toMatchObject([{ body: 'room', status: 'failed' }]);
    // Another account's reconnect touches nothing here.
    resumeChatSends('account-2');
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('skips the automatic retry when a poll found the message meanwhile (lost response)', async () => {
    const entry = entryFor();
    send.mockRejectedValueOnce(offline()).mockImplementation(async (input: { clientId: string; body: string }) => ({ message: message(7, { id: input.clientId, fromMe: true, body: input.body }) }));
    enqueue(entry, 'one');
    enqueue(entry, 'two');
    await settle();
    const lost = entry.outgoing[0]!.clientId;
    // The poll during the 2 s wait shows the first message stored; someone else's message with that id does not count.
    reconcile(entry, [message(6, { id: 'someone-else', fromMe: false })]);
    expect(entry.outgoing).toHaveLength(2);
    reconcile(entry, [message(6, { id: lost, fromMe: true, body: 'one' })]);
    expect(entry.outgoing.map((item) => item.body)).toEqual(['two']);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(sentBodies()).toEqual(['one', 'two']);
    expect(entry.outgoing).toEqual([]);
  });

  it('marks the chat closed when the server says it is gone', async () => {
    const entry = entryFor();
    send.mockRejectedValue(serverError('This chat is closed.', 'NOT_FOUND', 404));
    enqueue(entry, 'one');
    await settle();
    expect(entry.closed).toBe(true);
    expect(statuses(entry)).toEqual([{ body: 'one', status: 'failed', retryable: false, network: false, error: 'This chat is closed.' }]);
    // Discard-only messages do not block new ones.
    send.mockImplementation(async (input: { clientId: string; body: string }) => ({ message: message(8, { id: input.clientId, fromMe: true, body: input.body }) }));
    enqueue(entry, 'two');
    await settle();
    expect(sentBodies()).toEqual(['one', 'two']);
  });
});
