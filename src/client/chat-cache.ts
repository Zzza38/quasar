import { z } from 'zod';
import { pruneReceivedThreads, removeReceived } from './received-cache';
import type { ChatInbox, ThreadData } from '@/components/use-chat';
const text = z.string(), n = z.number(), b = z.boolean();
const instant = text.datetime({ offset: true });
const person = z.object({ id: text, displayName: text, avatar: text.nullable() }).passthrough();
const peer = person.extend({ fullName: text.nullable(), verified: b });
const preview = z.object({ fromMe: b, preview: text.nullable(), createdAt: instant, deletedBy: text.nullable() }).passthrough().nullable();
const summary = z.object({ lastMessage: preview, unread: n, muted: b }).passthrough();
const group = z.object({ id: text, name: text, createdAt: instant, role: z.enum(['admin', 'member']), members: z.array(person.extend({ verified: b, role: z.enum(['admin', 'member']), joinedAt: text })) }).passthrough();
const pause = z.object({ until: instant.nullable(), reason: text, appealed: b }).nullable();
const reply = z.object({ seq: n, fromMe: b, senderName: text, preview: text.nullable() }).nullable();
const revealed = z.object({ body: text, original: text.nullable() });
const message = z.object({
  id: text, seq: n, revision: n, body: text.nullable(), fromMe: b, createdAt: instant,
  deletedBy: z.enum(['sender', 'support', 'owner', 'admin']).nullable(),
  original: text.nullable().optional(), removed: revealed.extend({ image: text.nullable() }).nullable().optional(),
  editedFrom: revealed.nullable().optional(), editedAt: text.nullable().optional(), reason: text.nullable().optional(), moderatedBy: text.nullable().optional(),
  image: text.nullable().optional(),
  reactions: z.array(z.object({ emoji: text, count: n, mine: b })), replyTo: reply,
  sender: person.extend({ verified: b }).passthrough().optional(),
}).passthrough();
const thread = z.object({
  messages: z.array(message).max(100), receipts: z.array(z.object({ id: text, displayName: text, avatar: text.nullable(), deliveredSeq: n, readSeq: n, typing: b })),
  hasEarlier: b, muted: b, pause, peer: peer.nullable(),
  room: z.object({ members: n, canModerate: b, moderator: text.nullable() }).nullable(), group: group.nullable(),
  school: z.object({ id: text, name: text }).nullable().optional(),
});
const inbox = z.object({
  rows: z.array(z.discriminatedUnion('state', [
    summary.extend({ state: z.literal('open'), peer }),
    z.object({ state: z.literal('closed'), userId: text, displayName: text, lastAt: instant, reopen: z.enum(['unblock', 'friend']).nullable() }),
  ])),
  groups: z.array(summary.extend({ id: text, name: text, memberCount: n, role: z.enum(['admin', 'member']), members: z.array(person), lastAt: instant })),
  global: summary, school: summary.extend({ schoolId: text, schoolName: text }).nullable(), unreadChats: n, unreadAt: instant, pause,
});
export function validThread(value: unknown): value is ThreadData {
  const parsed = thread.safeParse(value);
  return parsed.success && (!(parsed.data.room || parsed.data.group) || parsed.data.messages.every(message => message.sender));
}
export function validInbox(value: unknown): value is ChatInbox { return inbox.safeParse(value).success; }
/** Keep the latest page and no ephemeral typing receipts. Only confirmed server rows enter here. */
export function threadSnapshot(data: ThreadData): ThreadData {
  return { ...data, receipts: [], messages: data.messages.slice(-100), hasEarlier: data.hasEarlier || data.messages.length > 100 };
}

/** A local block changes visibility in every room; a leave/unfriend closes just one conversation. */
export function clearChatCache(account: string, conversation?: string): void {
  if (conversation) removeReceived(account, `thread:${conversation}`);
  else pruneReceivedThreads(account, []);
  removeReceived(account, 'inbox');
}
