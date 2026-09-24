import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@/server/router';
import type { inferRouterOutputs } from '@trpc/server';

export type RouterOutput = inferRouterOutputs<AppRouter>;
export type Workspace = RouterOutput['workspace'];
export type School = RouterOutput['school']['list'][number];

export const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api/trpc' })],
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
  if (error instanceof TRPCClientError) return !error.data || FETCH_FAILURE.test(error.message);
  return error instanceof Error && FETCH_FAILURE.test(error.message);
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

export function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'data' in error &&
    (error as { data?: { code?: string } }).data?.code === 'UNAUTHORIZED');
}
