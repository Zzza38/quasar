export type ChatEvent = { kind: 'peer' | 'group' | 'global'; key: string };

/** Notifications invalidate existing authorized tRPC queries; the stream never carries messages. */
export function connectChatEvents(onEvent: (event: ChatEvent) => void, onState?: (connected: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => {};
  let source: EventSource | undefined;
  let disposed = false;
  let suspended = false;
  let atCapacity = false;
  let capacityHidden = false;
  let retryDelay = 3000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let hidden: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    const previous = source;
    source = undefined;
    previous?.close();
    onState?.(false);
  };
  const scheduleRetry = () => {
    if (disposed || suspended || atCapacity || retry) return;
    retry = setTimeout(() => { retry = undefined; open(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
  const open = () => {
    if (disposed || suspended || atCapacity || source) return;
    let current: EventSource;
    try { current = new EventSource('/api/chat/events'); } catch { scheduleRetry(); return; }
    source = current;
    current.onopen = () => {
      if (source !== current) return;
      retryDelay = 3000;
      onState?.(true);
    };
    current.addEventListener('chat', message => {
      if (source !== current) return;
      let event: unknown;
      try { event = JSON.parse((message as MessageEvent<string>).data); } catch { return; }
      if (!event || typeof event !== 'object' || !('kind' in event) || !('key' in event)) return;
      if ((event.kind === 'peer' || event.kind === 'group' || event.kind === 'global') && typeof event.key === 'string') {
        onEvent({ kind: event.kind, key: event.key });
      }
    });
    current.addEventListener('capacity', () => {
      if (source !== current) return;
      atCapacity = true;
      capacityHidden = document.hidden;
      clearTimeout(retry);
      retry = undefined;
      close();
    });
    current.addEventListener('bye', () => {
      if (source !== current) return;
      close();
      retryDelay = 5000 + Math.floor(Math.random() * 5001);
      scheduleRetry();
    });
    current.onerror = () => {
      if (source !== current) return;
      onState?.(false);
      // CONNECTING uses EventSource's built-in retry. CLOSED needs a new instance.
      if (current.readyState === EventSource.CLOSED) { close(); scheduleRetry(); }
    };
  };
  const visibility = () => {
    clearTimeout(hidden);
    if (document.hidden) {
      if (atCapacity) capacityHidden = true;
      hidden = setTimeout(() => {
        suspended = true;
        clearTimeout(retry);
        retry = undefined;
        close();
      }, 60_000);
    } else {
      if (atCapacity && !capacityHidden) return;
      atCapacity = false;
      capacityHidden = false;
      suspended = false;
      clearTimeout(retry);
      retry = undefined;
      open();
    }
  };
  document.addEventListener('visibilitychange', visibility);
  open();
  visibility();
  return () => {
    disposed = true;
    clearTimeout(retry);
    clearTimeout(hidden);
    document.removeEventListener('visibilitychange', visibility);
    close();
  };
}
