export type ChatEvent = { kind: 'peer' | 'group' | 'global'; key: string };
type Subscriber = { receive: (event: ChatEvent) => void; close: (reason: 'capacity') => void };
const globals = globalThis as typeof globalThis & { quasarChatSubscribers?: Map<string, Set<Subscriber>> };
const subscribers = globals.quasarChatSubscribers ??= new Map<string, Set<Subscriber>>();
export const CHAT_SUBSCRIBER_LIMIT = 8;

function safely(callback: () => void): void {
  try { callback(); } catch { /* A disconnected stream must not fail a committed mutation. */ }
}

export function subscribeChat(userId: string, receive: Subscriber['receive'], close: Subscriber['close'] = () => {}): () => void {
  let account = subscribers.get(userId);
  if (!account) subscribers.set(userId, account = new Set());
  while (account.size >= CHAT_SUBSCRIBER_LIMIT) {
    const oldest = account.values().next().value!;
    account.delete(oldest);
    safely(() => oldest.close('capacity'));
  }
  // Closing an evicted subscriber can remove the account's map entry.
  subscribers.set(userId, account);
  const subscriber = { receive, close };
  account.add(subscriber);
  return () => {
    account.delete(subscriber);
    if (!account.size && subscribers.get(userId) === account) subscribers.delete(userId);
  };
}

/** Global room changes broadcast to all connected accounts; other kinds use only the supplied accounts. */
export function notifyChat(userIds: string[], event: ChatEvent): void {
  safely(() => {
    const targets = event.kind === 'global' ? [...subscribers.keys()] : [...new Set(userIds)];
    // Explicit fields keep accidental message data out of the transport.
    const payload: ChatEvent = { kind: event.kind, key: event.key };
    for (const id of targets) {
      for (const subscriber of [...(subscribers.get(id) ?? [])]) safely(() => subscriber.receive(payload));
    }
  });
}

export function formatChatEvent(event: ChatEvent): string {
  return `event: chat\ndata: ${JSON.stringify({ kind: event.kind, key: event.key })}\n\n`;
}
