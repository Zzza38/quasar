import { getAuthValidator } from '@/server/auth';
import { formatChatEvent, subscribeChat } from '@/server/chat-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Cross-site request', { status: 403 });
  // accountScoped binds to this exact session user too; there is no acting-account override.
  const validateAuth = await getAuthValidator();
  const userId = validateAuth().userId;
  if (!userId) return new Response('Sign in first', { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener('abort', close);
        try { controller.close(); } catch { /* The reader may already have cancelled. */ }
      };
      cleanup = close;
      const write = (frame: string) => {
        if (closed) return;
        // Bound queued data for clients which stop reading without disconnecting.
        if ((controller.desiredSize ?? 0) <= 0) return close();
        try { controller.enqueue(encoder.encode(frame)); } catch { close(); }
      };
      const finish = (event: 'bye' | 'capacity') => {
        write(`event: ${event}\n${event === 'capacity' ? 'retry: 3600000\n' : ''}data: {}\n\n`);
        close();
      };
      const writeAuthorized = (frame: string) => {
        if (closed) return;
        try {
          if (validateAuth().userId !== userId) return finish('bye');
        } catch { return finish('bye'); }
        write(frame);
      };
      write('retry: 3000\n\n');
      unsubscribe = subscribeChat(userId, event => writeAuthorized(formatChatEvent(event)), () => finish('capacity'));
      heartbeat = setInterval(() => writeAuthorized(': heartbeat\n\n'), 25_000);
      request.signal.addEventListener('abort', close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 64 });
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  } });
}
