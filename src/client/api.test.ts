import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorMessage, INVALID_INPUT_MESSAGE, isAccessDenied, isPermanentRejection, isTransportFailure, isUnauthorized, timedFetch, UNREACHABLE_MESSAGE } from './api';

const serverError = (message: string, code: string) => new TRPCClientError(message, { result: { error: { message, code: -32600, data: { code, httpStatus: 400 } } } });

describe('error messages', () => {
  it('explains transport failures instead of showing browser text', () => {
    for (const error of [new TypeError('Failed to fetch'), new TypeError('Load failed'), new TRPCClientError('Failed to fetch'), new TRPCClientError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")]) {
      expect(isTransportFailure(error)).toBe(true);
      expect(errorMessage(error)).toBe(UNREACHABLE_MESSAGE);
    }
  });

  it('passes server messages through and keeps them out of the offline path', () => {
    const conflict = serverError('This directory class changed. Reload and review it before saving.', 'CONFLICT');
    expect(isTransportFailure(conflict)).toBe(false);
    expect(errorMessage(conflict)).toBe('This directory class changed. Reload and review it before saving.');
    const unauthorized = serverError('Sign in again.', 'UNAUTHORIZED');
    expect(isTransportFailure(unauthorized)).toBe(false);
    expect(isUnauthorized(unauthorized)).toBe(true);
  });

  it('tells a refusal of the signed-in account apart from a failure', () => {
    expect(isAccessDenied(serverError('Sign in again.', 'UNAUTHORIZED'))).toBe(true);
    expect(isAccessDenied(serverError('Owner access is required.', 'FORBIDDEN'))).toBe(true);
    for (const error of [serverError('Oops', 'INTERNAL_SERVER_ERROR'), serverError('Too fast.', 'TOO_MANY_REQUESTS'), new TRPCClientError('Failed to fetch'), new TypeError('Failed to fetch'), null])
      expect(isAccessDenied(error)).toBe(false);
  });

  it('treats only a server refusal of the request itself as permanent', () => {
    expect(isPermanentRejection(serverError('Calendar source metadata can only be changed by calendar synchronization.', 'BAD_REQUEST'))).toBe(true);
    expect(isPermanentRejection(serverError('The next repeating task ID is already in use.', 'CONFLICT'))).toBe(true);
    for (const error of [serverError('Sign in again.', 'UNAUTHORIZED'), serverError('Too fast.', 'TOO_MANY_REQUESTS'), serverError('Oops', 'INTERNAL_SERVER_ERROR'),
      new TRPCClientError('Failed to fetch'), new Error('The signed-in account changed.'), 'nope']) expect(isPermanentRejection(error)).toBe(false);
  });

  it('uses a custom Zod message and hides the built-in ones', () => {
    const custom = z.string().refine((value) => value.includes('.'), 'Enter a domain such as students.example.org').safeParse('school');
    expect(errorMessage(custom.error)).toBe('Enter a domain such as students.example.org');
    const builtIn = z.object({ first: z.string().min(1) }).safeParse({ first: '' });
    expect(errorMessage(builtIn.error)).toBe(INVALID_INPUT_MESSAGE);
  });

  it('never shows a serialized issue list', () => {
    expect(errorMessage(serverError('[{"code":"too_small","minimum":1}]', 'BAD_REQUEST'))).toBe(INVALID_INPUT_MESSAGE);
    expect(errorMessage(new Error('{"error":"upstream"}'))).toBe('Something went wrong. Please try again.');
    expect(errorMessage('nope')).toBe('Something went wrong. Please try again.');
  });
});

describe('request timeout', () => {
  /** A fetch that never answers until its signal aborts, like a request stuck on a half-open connection. */
  const stalled: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });

  it('gives up on a stalled request and reports it as a transport failure', async () => {
    const error = await timedFetch(20, stalled)('/api/trpc/session').catch((caught: unknown) => caught);
    expect((error as Error).name).toBe('TimeoutError');
    expect(isTransportFailure(error)).toBe(true);
    expect(isTransportFailure(new TRPCClientError('The request timed out.', { cause: error as Error }))).toBe(true);
    expect(errorMessage(new TRPCClientError('The request timed out.', { cause: error as Error }))).toBe(UNREACHABLE_MESSAGE);
  });

  it("still honors the caller's own signal and passes answers through", async () => {
    const controller = new AbortController();
    const pending = timedFetch(60_000, stalled)('/api/trpc/chat.inbox', { signal: controller.signal });
    controller.abort(new DOMException('Unmounted.', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const answer = new Response('{}');
    await expect(timedFetch(20, async () => answer)('/api/trpc/session')).resolves.toBe(answer);
  });
});
