import { createTRPCClient, httpBatchLink, httpLink, splitLink, TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@/server/router';
import type { inferRouterOutputs } from '@trpc/server';

export type RouterOutput = inferRouterOutputs<AppRouter>;
export type Workspace = RouterOutput['workspace'];
export type School = RouterOutput['school']['get'];
export type SchoolSummary = RouterOutput['school']['list'][number];

/** Every request gives up after this long, so a stalled connection cannot freeze sync or chat polling. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A schedule scan waits on the model for up to 90 s on the server (src/server/scan.ts), so it gets a longer budget. */
export const SCAN_TIMEOUT_MS = 120_000;

/**
 * A fetch that aborts with a TimeoutError after `ms`, on top of the caller's own signal (a chat send's 15 s timeout,
 * a poller's unmount). The timer also covers reading the body, since a half-open connection can stall there too.
 */
export function timedFetch(ms: number, base: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), ms);
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }
    return base(input, { ...init, signal: controller.signal }).catch((error: unknown) => { clearTimeout(timer); throw error; });
  };
}

/**
 * A chat send always travels alone (httpLink), so it is never batched with a poll: its 15 s timeout
 * and a Playwright route on the chat.send URL both apply to exactly one request. A schedule scan travels
 * alone too, with its longer timeout; everything else is batched under REQUEST_TIMEOUT_MS.
 */
export const api = createTRPCClient<AppRouter>({
  links: [splitLink({
    condition: (op) => op.path === 'chat.send',
    true: httpLink({ url: '/api/trpc', fetch: timedFetch(REQUEST_TIMEOUT_MS) }),
    false: splitLink({
      condition: (op) => op.path === 'scan.schedule',
      true: httpLink({ url: '/api/trpc', fetch: timedFetch(SCAN_TIMEOUT_MS) }),
      false: httpBatchLink({ url: '/api/trpc', fetch: timedFetch(REQUEST_TIMEOUT_MS) }),
    }),
  })],
});

export const UNREACHABLE_MESSAGE = "Can't reach Quasar. Check your connection and try again. Nothing you typed was lost.";
export const INVALID_INPUT_MESSAGE = "Some of this doesn't look right. Check the fields and try again.";
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
const FETCH_FAILURE = /failed to fetch|fetch failed|networkerror|network request|load failed/i;
/** Zod's built-in English messages; custom schema messages are already written for students. */
const DEFAULT_ISSUE = /^(Invalid\b|Too (small|big)\b|Unrecognized key)/;

/**
 * True when the request never got a tRPC answer: the device is offline, fetch itself failed, or a
 * proxy returned something that is not a tRPC response (an HTML error page, a bare 5xx). Server
 * errors such as UNAUTHORIZED or CONFLICT carry `data` and are not transport failures.
 */
export function isTransportFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (timedOut(error)) return true;
  if (error instanceof TRPCClientError) return !error.data || FETCH_FAILURE.test(error.message);
  return error instanceof Error && FETCH_FAILURE.test(error.message);
}

const ABORT_NAMES = new Set(['AbortError', 'TimeoutError']);
/** A request that timed out or was aborted before any answer arrived (tRPC keeps the fetch error as `cause`). */
function timedOut(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return ABORT_NAMES.has(error.name) || (cause instanceof Error && ABORT_NAMES.has(cause.name));
}

function validationIssues(error: unknown): Array<{ message?: unknown }> | null {
  if (!(error instanceof Error) || (error.name !== 'ZodError' && error.name !== 'SchemaError')) return null;
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues : null;
}

export function errorMessage(error: unknown): string {
  const issues = validationIssues(error);
  if (issues) {
    const first = issues[0]?.message;
    return typeof first === 'string' && first.trim() && !DEFAULT_ISSUE.test(first) ? first : INVALID_INPUT_MESSAGE;
  }
  if (isTransportFailure(error)) return UNREACHABLE_MESSAGE;
  if (!(error instanceof Error)) return GENERIC_MESSAGE;
  const message = error.message.trim();
  // A serialized issue list or object is developer text, never something to show a student.
  if (message.startsWith('[') || message.startsWith('{')) {
    return error instanceof TRPCClientError && error.data?.code === 'BAD_REQUEST' ? INVALID_INPUT_MESSAGE : GENERIC_MESSAGE;
  }
  return message || GENERIC_MESSAGE;
}

/**
 * True when the server answered and refused this exact request (a validation failure or a conflict), so sending
 * it again unchanged would fail the same way. Transport failures and UNAUTHORIZED are never permanent.
 */
export function isPermanentRejection(error: unknown): boolean {
  if (isTransportFailure(error) || !error || typeof error !== 'object' || !('data' in error)) return false;
  const code = (error as { data?: { code?: string } }).data?.code;
  return code === 'BAD_REQUEST' || code === 'CONFLICT' || code === 'PAYLOAD_TOO_LARGE' || code === 'UNPROCESSABLE_CONTENT';
}

export function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'data' in error &&
    (error as { data?: { code?: string } }).data?.code === 'UNAUTHORIZED');
}

/** True when the server refused because of who is signed in (signed out, or not allowed), not because it failed. */
export function isAccessDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('data' in error)) return false;
  const code = (error as { data?: { code?: string } }).data?.code;
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN';
}
