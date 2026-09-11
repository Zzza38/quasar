import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@/server/router';
import type { inferRouterOutputs } from '@trpc/server';

export type RouterOutput = inferRouterOutputs<AppRouter>;
export type Workspace = RouterOutput['workspace'];
export type School = RouterOutput['school']['list'][number];

export const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api/trpc' })],
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'data' in error &&
    (error as { data?: { code?: string } }).data?.code === 'UNAUTHORIZED');
}
