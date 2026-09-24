import type { TRPCError } from '@trpc/server';

/**
 * The tRPC route's onError body. Logs the procedure name, error code and message only: inputs may hold
 * private schedule data or chat text, and every chat error message is a fixed string (docs/CHAT.md §3.3).
 */
export function logTrpcError({ path, error }: { path: string | undefined; error: TRPCError }): void {
  if (error.code !== 'UNAUTHORIZED') console.error(`tRPC ${path ?? 'unknown'} failed: ${error.code} ${error.message}`);
}
