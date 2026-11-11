'use client';

import { chatImage, imageDataUrl } from '@/client/chat-image';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { api, errorMessage } from '@/client/api';
import { bodyError, censorBody, CHAT, COMPOSER_MAX_LENGTH, mentionParts, mentionQuery, mentionsName, mentionText, normalizeBody, QUICK_REACTIONS, REACTIONS, REPORT_CATEGORIES, revealableText, withinEditWindow, type CensorMask, type MessageMention, type MessageReactor, type MessageReply, type Reaction, type ReportCategory, type SearchHit } from '@/domain/chat';
import { censorSlurs, slurNotice } from '@/domain/chat-filter';
import { parseMarkdown, plainText, type Block, type Inline } from '@/domain/markdown';
import { chatTime, daysBetween, formatDate, formatDateTime, formatTime, instantParts, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import type { AppState } from '../app-state';
import { AppealModal } from '../appeal';
import { useBeta } from '../betas';
import { FORMAT_HINT_KEY, FORMAT_HINT_TIMES, REACTION_NAMES, imageFilesFrom, liveQuote, mentionMatches, sendParts, outsideRestoresFocus, quoteName, quoteOf, reactionLabel, reactionToggleLabel, reactionWhoLabel, reactorNames, selectionRect, swipeOffset, swipeProgress, swipeReplies } from '../chat-ui';
import { NotificationNudge, NotificationNudgeChip, useChatNotifications, type ChatNotifications } from '../chat-notifications';
import { Icon, Spinner, type IconName } from '../icon';
import { AvatarStack, MemberAvatar } from '../member-avatar';
import { Button, Callout, Chip, EmptyState, Field, Hint, IconButton, Input, Modal, Segmented, Spacer, Textarea } from '../primitives';
import { Checkbox } from '../ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Label } from '../ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { Toggle } from '../ui/toggle';
import { Button as MenuRow } from '../ui/button';
import { STAFF_LABELS, STAFF_NOUNS, type StaffRank } from '@/domain/staff';
import { GLOBAL_TARGET, useChatInbox, useChatThread, useChatViewport, type ChatInboxRow, type ChatMessage, type ChatPause, type ChatTarget, type ChatThread, type GlobalSummary, type GroupInfo, type GroupSummary, type Outgoing, type Receipt, type SchoolSummary } from '../use-chat';

type OpenRow = Extract<ChatInboxRow, { state: 'open' }>;
type ClosedRow = Extract<ChatInboxRow, { state: 'closed' }>;
type Friend = OpenRow['peer'];
type Mode = 'peer' | 'group' | 'global' | 'school';
type RoomKind = 'global' | 'school';

/**
 * `#messages?room=global` opens the global chat (docs/CHAT.md §11), `?room=school` the member's school chat (§16),
 * and `?group=<id>` a friend group (§12).
 */
const GLOBAL_ROOM = 'global';
const SCHOOL_ROOM = 'school';
const GLOBAL_NAME = 'Global chat';
const SCHOOL_NAME = 'School chat';
const groupKey = (groupId: string) => `group:${groupId}`;
/**
 * The beta that holds the chat polish: pasted and dropped images, the list of who reacted, the list of who read a
 * group message, a bubble fill whose tail shows on every theme, and quotes without the side bar. Since 2026-11-11
 * also editing your own message, "@" mentions, search inside a chat, GIFs that keep moving, several images in one
 * send and the larger set of reactions.
 */
const CHAT_POLISH = 'chat-polish';

/** Gap after which a new run (and a time header) starts, even for the same sender. */
const RUN_GAP_MS = 10 * 60_000;
/** How long a press on a bubble has to last to open its actions (ms). */
const LONG_PRESS_MS = 400;
/** A press that travels further than this (px) is a scroll, not a long press. */
const LONG_PRESS_SLOP = 8;
/** Two taps this close (ms) on a bubble are a double tap, which toggles a heart. */
const DOUBLE_TAP_MS = 300;
/** How many older pages a quote tap loads while looking for its target before giving up. */
const JUMP_PAGES = 10;
/** A search result may sit much further back, so it is given more pages before the jump gives up. */
const SEARCH_JUMP_PAGES = 40;
/** How long the search field waits after the last keystroke before asking the server (ms). */
const SEARCH_DEBOUNCE_MS = 250;
/** How close to the bottom (px) still counts as "at the bottom" for auto-scroll and read marking. */
const BOTTOM_SLACK = 80;

/* ---------- Small helpers ---------- */

/** "Mon, Sep 28, 4:12 PM" in the student's time zone. */
function pauseDate(until: string, timeZone: string): string {
  const { date, time } = instantParts(until, timeZone);
  return `${formatDate(date, { weekday: 'short' })}, ${formatTime(time)}`;
}

function pauseText(pause: ChatPause, timeZone: string): string {
  return pause.until ? `Support paused your messaging until ${pauseDate(pause.until, timeZone)}.` : 'Support paused your messaging.';
}

function dayLabel(date: string, today: string): string {
  const days = daysBetween(date, today);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return formatDate(date, { weekday: 'short' });
}

/** Task title from a message: markup dropped, whitespace collapsed, trimmed, first 120 characters. */
function taskTitle(body: string): string {
  return plainText(body).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function subscribePointer(callback: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia('(pointer: fine)');
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}
function finePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
}
/** True for a mouse or trackpad; false for touch screens. */
function useFinePointer(): boolean {
  return useSyncExternalStore(subscribePointer, finePointer, () => true);
}

/** Who sent a message, for runs and name labels: rooms and groups key by sender, a one-to-one chat by side. */
function senderKey(message: ChatMessage): string {
  return 'sender' in message ? message.sender.id : message.fromMe ? 'me' : 'them';
}
function senderName(message: ChatMessage): string {
  return 'sender' in message ? message.sender.displayName : '';
}
function senderAvatar(message: ChatMessage): string | null {
  return 'sender' in message ? message.sender.avatar : null;
}
/**
 * A moderator's edit or removal note on a global message, if any, and who made it ("the owner", "a moderator").
 * A message from a server before staff roles has no `moderatedBy`; only the owner moderated then.
 */
function moderation(message: ChatMessage): { edited: boolean; own: boolean; reason: string | null; by: string } {
  // `own` marks the sender's own edit (any chat kind), which shows as a plain "Edited" with no name or reason.
  return { edited: !!message.editedAt, own: !!message.editedBySender, reason: 'reason' in message ? message.reason : null, by: STAFF_NOUNS[('moderatedBy' in message ? message.moderatedBy : null) ?? 'owner'] };
}
function removedText(message: ChatMessage): string {
  const { reason, by } = moderation(message);
  if (message.deletedBy === 'support') return 'Hidden by support';
  if (message.deletedBy === 'owner') return reason ? `Removed by ${by}: ${reason}` : `Removed by ${by}`;
  if (message.deletedBy === 'admin') return 'Removed by the group admin';
  return 'Message deleted';
}

/**
 * What the other side has done with the viewer's message (docs/CHAT.md §13), for the caption under their newest one:
 * one friend reads or receives it; in a group, how many of the others have.
 */
export function receiptStatus(seq: number, receipts: Receipt[], group: boolean): { label: string; icon: IconName; read: boolean } | null {
  if (!receipts.length) return null;
  const read = receipts.filter((receipt) => receipt.readSeq >= seq).length;
  const delivered = receipts.filter((receipt) => receipt.deliveredSeq >= seq).length;
  if (!group) {
    if (read) return { label: 'Read', icon: 'checkCheck', read: true };
    if (delivered) return { label: 'Delivered', icon: 'checkCheck', read: false };
    return { label: 'Sent', icon: 'check', read: false };
  }
  if (read === receipts.length) return { label: 'Read by everyone', icon: 'checkCheck', read: true };
  if (read) return { label: `Read by ${read}`, icon: 'checkCheck', read: true };
  if (delivered === receipts.length) return { label: 'Delivered', icon: 'checkCheck', read: false };
  if (delivered) return { label: `Delivered to ${delivered}`, icon: 'checkCheck', read: false };
  return { label: 'Sent', icon: 'check', read: false };
}

/**
 * Who has read the viewer's message, who only received it and who has not got it yet, for the list behind a group's
 * "Read by 3" caption. Everyone lands in exactly one list, in the order the thread sends them.
 */
export function receiptGroups(seq: number, receipts: Receipt[]): { read: Receipt[]; delivered: Receipt[]; waiting: Receipt[] } {
  return {
    read: receipts.filter((receipt) => receipt.readSeq >= seq),
    delivered: receipts.filter((receipt) => receipt.readSeq < seq && receipt.deliveredSeq >= seq),
    waiting: receipts.filter((receipt) => receipt.readSeq < seq && receipt.deliveredSeq < seq),
  };
}

/**
 * The members a message's receipts can count: in a group, those who had joined when it was sent. A member added later
 * starts with their read marker at the newest message, which would otherwise read as having seen everything before it.
 */
export function receiptsFor(createdAt: string, receipts: Receipt[]): Receipt[] {
  return receipts.some((receipt) => receipt.joinedAt && receipt.joinedAt > createdAt) ? receipts.filter((receipt) => !receipt.joinedAt || receipt.joinedAt <= createdAt) : receipts;
}

/** "Bob is typing…", "Bob and Cara are typing…", "Bob, Cara and 2 others are typing…" */
export function typingText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length - 2 === 1 ? 'other' : 'others'} are typing…`;
}

/* ---------- Message text: the markdown subset, censored at display time ---------- */

/** What a text run needs beyond its words: the owner's masks, the people the message mentions, and whose bubble it is. */
type TextContext = { masks: CensorMask[] | null; mentions: MessageMention[] | null; mine: boolean };

/** A run with its "@Name"s set apart (chat-polish beta); a mention of the viewer gets a tinted pill. */
function mentionText_(text: string, context: TextContext, key: string): ReactNode {
  const censored = censorSlurs(text);
  if (!context.mentions?.length) return censored;
  return mentionParts(censored, context.mentions).map((part, index) => (part.mention
    ? <span key={`${key}-at${index}`} data-mention={part.mention.me ? 'me' : 'other'} className={cn('font-semibold', part.mention.me
        ? cn('rounded-[5px] px-1 py-px', context.mine ? 'bg-primary-foreground/25' : 'bg-primary/15 text-primary')
        : context.mine ? 'underline decoration-primary-foreground/50 underline-offset-2' : 'text-primary')}>{part.text}</span>
    : part.text));
}

/**
 * A text run, censored at display time too (messages stored before the filter, slur-shaped words in links). With
 * `masks` (the owner's view, revealableText), each marker becomes the asterisks the filter put there, which show
 * what they hid on hover or focus.
 */
function shownText(text: string, context: TextContext, key: string): ReactNode {
  if (!context.masks) return mentionText_(text, context, key);
  const masks = context.masks;
  return text.split(/\uE000(\d+)\uE001/).map((part, index) => (index % 2 ? <Censored key={`${key}-m${index}`} mask={masks[Number(part)]} /> : <span key={`${key}-t${index}`}>{mentionText_(part, context, `${key}-${index}`)}</span>));
}

/** The owner's view of a word the slur filter hid: its asterisks, swapped for the original on hover or focus. */
function Censored({ mask }: { mask: CensorMask | undefined }) {
  if (!mask) return null;
  return <span tabIndex={0} className="group/censor cursor-help rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span aria-hidden="true" className="group-hover/censor:hidden group-focus/censor:hidden">{'*'.repeat(mask.stars)}</span>
    <span aria-hidden="true" className="hidden group-hover/censor:inline group-focus/censor:inline">{mask.original}</span>
    <span className="sr-only">(censored: {mask.original})</span>
  </span>;
}

function renderInline(nodes: Inline[], keyPrefix: string, context: TextContext): ReactNode[] {
  const { mine } = context;
  // Links and code never carry a mention: an "@name" inside either is part of the address or the snippet.
  const plain: TextContext = { ...context, mentions: null };
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      // Links keep the real href.
      case 'text': return <span key={key}>{shownText(node.text, context, key)}</span>;
      case 'link': return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow ugc" className={cn('underline underline-offset-2', mine ? 'text-primary-foreground decoration-primary-foreground/60' : 'text-primary decoration-primary/50')}>{shownText(node.text, plain, key)}</a>;
      // Each style has to read at 15 px on a coloured bubble: 700 weight, a true italic, a visible strike, a mono pill.
      case 'code': return <code key={key} className={cn('rounded-md px-1.5 py-px font-mono text-[0.88em]', mine ? 'bg-black/25' : 'bg-foreground/[0.1]')}>{shownText(node.text, plain, key)}</code>;
      case 'strong': return <strong key={key} className="font-bold">{renderInline(node.children, key, context)}</strong>;
      case 'em': return <em key={key} className="italic">{renderInline(node.children, key, context)}</em>;
      case 'strike': return <s key={key} className="line-through decoration-[1.5px] opacity-85">{renderInline(node.children, key, context)}</s>;
    }
  });
}

function renderLines(lines: Inline[][], keyPrefix: string, context: TextContext): ReactNode[] {
  return lines.flatMap((line, index) => [index > 0 ? <br key={`${keyPrefix}-br-${index}`} /> : null, ...renderInline(line, `${keyPrefix}-${index}`, context)]);
}

function renderBlock(block: Block, index: number, context: TextContext): ReactNode {
  const key = `b${index}`;
  const { mine } = context;
  switch (block.kind) {
    case 'paragraph': return <p key={key} className="m-0">{renderLines(block.lines, key, context)}</p>;
    case 'code': return <pre key={key} className={cn('my-1 overflow-x-auto whitespace-pre-wrap rounded-lg px-2.5 py-1.5 font-mono text-[13px] leading-snug', mine ? 'bg-black/25' : 'bg-foreground/[0.1]')}>{shownText(block.text, { ...context, mentions: null }, key)}</pre>;
    case 'quote': return <blockquote key={key} className={cn('my-1 border-l-2 pl-2.5', mine ? 'border-primary-foreground/50 text-primary-foreground/90' : 'border-foreground/30 text-foreground/80')}>{renderLines(block.lines, key, context)}</blockquote>;
    case 'list': return block.ordered
      ? <ol key={key} start={block.start} className="my-1 list-decimal pl-5">{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `${key}-${itemIndex}`, context)}</li>)}</ol>
      : <ul key={key} className="my-1 list-disc pl-5">{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `${key}-${itemIndex}`, context)}</li>)}</ul>;
  }
}

/**
 * Message text as React nodes: the markdown subset of docs/CHAT.md §13 rendered without any HTML, slurs censored at
 * display time (see shownText), and only https links (full URL shown) clickable. `original` is the uncensored text
 * the server sends the owner only (src/server/moderation.ts); with it, censored words reveal themselves on hover.
 * `mentions` are the people the message names with "@" (chat-polish beta). Memoised on the text: the log re-renders
 * every bubble on each poll and menu toggle, and parsing and censoring are real work.
 */
function MessageText({ text, mine, original, mentions }: { text: string; mine: boolean; original?: string | null; mentions?: MessageMention[] | null }) {
  const mentionKey = (mentions ?? []).map((mention) => `${mention.id}:${mention.name}:${mention.me}`).join('|');
  return useMemo(() => {
    const revealed = original ? revealableText(original) : null;
    const context: TextContext = { masks: revealed?.masks ?? null, mentions: mentions?.length ? mentions : null, mine };
    return <div className="grid gap-1.5">{parseMarkdown(revealed?.text ?? text).map((block, index) => renderBlock(block, index, context))}</div>;
    // `mentionKey` stands for `mentions`, which is a new array on every poll.
  }, [text, mine, original, mentionKey]);
}

/* ---------- View ---------- */

export function MessagesView({ state }: { state: AppState }) {
  const withId = state.params.get('with');
  const groupId = state.params.get('group');
  const roomParam = state.params.get('room');
  const room: RoomKind | null = roomParam === GLOBAL_ROOM ? 'global' : roomParam === SCHOOL_ROOM ? 'school' : null;
  /** The open conversation's key: a friend's id, "group:<id>", "global", "school", or null for the list alone. */
  const openKey = withId ?? (groupId ? groupKey(groupId) : room);
  const phone = useIsMobile();
  // Phones show the list or a thread; desktop shows both panes.
  const listMounted = !phone || !openKey;
  /**
   * The friend whose open thread closed (the server answered NOT_FOUND), and whether the chat list has since shown
   * that chat as not open. A closed thread stops polling, so the list keeps polling for it (on phones too); once the
   * list shows the chat open again (a reopen here, or the other person accepting), the thread remounts fresh.
   */
  const [closedThread, setClosedThread] = useState<{ userId: string; seenClosed: boolean } | null>(null);
  const [threadGeneration, setThreadGeneration] = useState(0);
  const threadClosed = !!withId && closedThread?.userId === withId;
  const inbox = useChatInbox(state, listMounted || threadClosed);
  useChatViewport(phone && !!openKey);
  const [notice, setNotice] = useState('');
  const [reporting, setReporting] = useState<ClosedRow | null>(null);
  const [creating, setCreating] = useState(false);
  const accountId = state.context.user.id;
  const refresh = state.refresh;
  const onChatPush = useCallback(async (enabled: boolean) => { await api.chat.setPush.mutate({ accountId, enabled }); await refresh(); }, [accountId, refresh]);
  /** Whether message notifications reach this device, and the nudge that fixes it (docs/CHAT.md §7). */
  const nudge = useChatNotifications(accountId, state.online, state.context.community.chatPush, onChatPush);

  /** The chat a notice was just set for: opening that chat (Reopen from the list) keeps the notice once. */
  const noticeFor = useRef<string | null>(null);
  // Opening another chat clears the last result message.
  useEffect(() => {
    const keep = noticeFor.current === openKey;
    noticeFor.current = null;
    if (openKey && !keep) setNotice('');
  }, [openKey]);
  useEffect(() => { setClosedThread(null); }, [openKey]);

  const rows = inbox.inbox?.rows ?? [];
  const friends = useMemo(() => rows.filter((row): row is OpenRow => row.state === 'open').map((row) => row.peer), [rows]);
  const closedRow = withId ? rows.find((row): row is ClosedRow => row.state === 'closed' && row.userId === withId) ?? null : null;
  const openRow = withId ? rows.find((row): row is OpenRow => row.state === 'open' && row.peer.id === withId) ?? null : null;
  const reloadInbox = inbox.reload;
  const onThreadChange = useCallback(() => { if (listMounted) reloadInbox(); }, [listMounted, reloadInbox]);
  const onThreadClosed = useCallback(() => {
    if (withId) setClosedThread((current) => (current?.userId === withId ? current : { userId: withId, seenClosed: false }));
    reloadInbox();
  }, [withId, reloadInbox]);
  // The list must first show the chat as not open (a closed row, or no row): one fetched before the thread closed may still show it open.
  const listLoaded = !!inbox.inbox;
  useEffect(() => {
    if (!threadClosed || !listLoaded) return;
    if (!openRow) setClosedThread((current) => (current && !current.seenClosed ? { ...current, seenClosed: true } : current));
    else if (closedThread?.seenClosed) { setClosedThread(null); setThreadGeneration((count) => count + 1); }
  }, [threadClosed, listLoaded, openRow, closedThread?.seenClosed]);

  // Leaving a thread removes the control that had focus (the list comes back on phones, and a block
  // closes the thread everywhere). Focus goes to the row of the chat just left, or to the heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const lastWith = useRef(openKey);
  const focusHeading = useRef(false);
  useEffect(() => {
    const previous = lastWith.current;
    lastWith.current = openKey;
    if (openKey || !previous || (!phone && !focusHeading.current)) return;
    const row = focusHeading.current ? null : document.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(previous)}"]`);
    focusHeading.current = false;
    if (row) row.focus();
    else heading.current?.focus({ preventScroll: true });
  }, [openKey, phone]);

  const backToList = (message: string) => {
    setNotice(message);
    focusHeading.current = true;
    state.navigate('messages');
    reloadInbox();
    void state.refresh();
  };
  /** Lifts the viewer's block (if any) and re-requests the friendship; a waiting request from the other side reopens at once. */
  const reopen = async (row: ClosedRow) => {
    const result = await api.chat.reopen.mutate({ accountId: state.context.user.id, userId: row.userId });
    reloadInbox();
    void state.refresh();
    if (result.friendState === 'friends') {
      noticeFor.current = row.userId;
      setNotice(`Chat with ${row.displayName} reopened.`);
      state.navigate('messages', { with: row.userId });
    } else {
      setNotice(`${result.unblocked ? `${row.displayName} is unblocked. ` : ''}Friend request sent. The chat reopens when ${row.displayName} accepts.`);
    }
  };

  {/* A phone thread's header pulls up by the page's top padding (HEADER) to sit flush under the top bar, or under a callout. */}
  return <div className={cn('flex min-h-0 flex-1 flex-col gap-4 animate-in fade-in-0 duration-300', openKey && 'max-lg:gap-5')}>
    {/* A phone thread keeps the page heading for screen readers only. */}
    <header className={cn('grid gap-1', openKey && 'max-lg:sr-only')}><h1 ref={heading} tabIndex={-1} className="outline-none">Messages</h1></header>
    {!state.online && <Callout tone="neutral" icon="cloudOff" role="status">You’re offline. Messages load when you reconnect.</Callout>}
    {notice && <Callout tone="success" icon="check" role="status">{notice}</Callout>}
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-5">
      {listMounted && <div className={cn('min-h-0 lg:overflow-y-auto lg:pr-1', openKey && 'max-lg:hidden')}>
        <ChatList state={state} inbox={inbox} nudge={nudge} selected={openKey} onReport={(row) => { setNotice(''); setReporting(row); }} onReopen={reopen} onNewGroup={() => setCreating(true)} />
      </div>}
      {withId
        ? <Thread key={`${withId}:${threadGeneration}`} state={state} userId={withId} phone={phone} nudge={nudge} fallbackName={openRow?.peer.displayName ?? closedRow?.displayName ?? ''} closedRow={closedRow}
            onChange={onThreadChange} onClosed={onThreadClosed} onReportClosed={setReporting} onReopen={reopen} onLeave={backToList} />
        : groupId
          ? <GroupThread key={groupId} state={state} groupId={groupId} phone={phone} nudge={nudge} friends={friends} onChange={onThreadChange} onLeave={backToList} />
          // Keyed by school too: a school switch in another tab must start the room fresh, never merge two schools' pages.
          : room
            ? <RoomThread key={room === 'school' ? `school:${state.context.school.id}` : room} kind={room} state={state} phone={phone} nudge={nudge} onChange={onThreadChange} />
            : <div className="hidden min-h-0 place-items-center rounded-3xl bg-card text-sm text-muted-foreground shadow-card ring-1 ring-foreground/[0.06] lg:grid">Pick a chat.</div>}
    </div>
    {reporting && <ReportModal state={state} name={reporting.displayName} target={{ kind: 'peer', userId: reporting.userId, mode: 'closed' }} onClose={() => setReporting(null)}
      onSent={() => { setReporting(null); setNotice('Report sent to support.'); reloadInbox(); }} />}
    {creating && <NewGroupModal state={state} friends={friends} onClose={() => setCreating(false)}
      onCreated={(group) => { setCreating(false); noticeFor.current = groupKey(group.id); setNotice(`Group “${group.name}” created.`); reloadInbox(); state.navigate('messages', { group: group.id }); }} />}
  </div>;
}

/* ---------- Chat list ---------- */

function ChatList({ state, inbox, nudge, selected, onReport, onReopen, onNewGroup }: { state: AppState; inbox: ReturnType<typeof useChatInbox>; nudge: ChatNotifications; selected: string | null; onReport: (row: ClosedRow) => void; onReopen: (row: ClosedRow) => Promise<void>; onNewGroup: () => void }) {
  const data = inbox.inbox;
  const recent = (data?.rows ?? []).filter((row) => row.state === 'closed' || row.lastMessage !== null);
  const friends = (data?.rows ?? []).filter((row): row is OpenRow => row.state === 'open' && row.lastMessage === null);
  const hasFriends = (data?.rows ?? []).some((row) => row.state === 'open');
  const [appealing, setAppealing] = useState(false);
  return <div className="grid gap-5">
    {inbox.loading && <Hint role="status">Loading chats…</Hint>}
    {inbox.error && !data && <Callout tone="danger" icon="alert" role="alert" actions={<Button size="sm" disabled={!state.online} onClick={inbox.reload}>Try again</Button>}>{inbox.error}</Callout>}
    {data && inbox.reconnecting && <Hint role="status" title={liveTitle(inbox.live)}>Reconnecting…</Hint>}
    {data && <NotificationNudge nudge={nudge} />}
    {data?.pause && <Callout tone="warning" icon="lock" title={pauseText(data.pause, state.timeZone)}
      actions={data.pause.appealed ? <Chip tone="neutral" icon="clock">Appeal sent</Chip> : <Button size="sm" disabled={!state.online} onClick={() => setAppealing(true)}>Appeal</Button>}>
      Reason: {data.pause.reason} You can still read your chats.
    </Callout>}
    {appealing && data?.pause && <AppealModal accountId={state.context.user.id} kind="pause" what="your messaging pause" onClose={() => setAppealing(false)} onSent={async () => { setAppealing(false); inbox.reload(); await state.refresh(); }} />}
    {data && <section className="grid gap-1" aria-labelledby="chat-groups-title">
      <div className="flex items-center justify-between gap-2 px-2">
        <h2 id="chat-groups-title" className={SECTION_LABEL}>Groups</h2>
        <Button size="sm" variant="ghost" icon="plus" disabled={!state.online || !hasFriends} title={hasFriends ? undefined : 'Add friends first'} onClick={onNewGroup}>New group</Button>
      </div>
      <ul className="grid" aria-label="Groups">
        <GlobalChatRow summary={data.global} state={state} selected={selected === GLOBAL_ROOM} />
        {data.school && <SchoolChatRow summary={data.school} state={state} selected={selected === SCHOOL_ROOM} />}
        {data.groups.map((group) => <GroupChatRow key={group.id} group={group} state={state} selected={selected === groupKey(group.id)} />)}
      </ul>
    </section>}
    {data && data.rows.length === 0 && <EmptyState icon="users" title="No friends to message yet" action={<Button variant="primary" icon="users" onClick={() => state.navigate('people')}>Find friends</Button>}>Chats open once a schoolmate accepts your friend request.</EmptyState>}
    {recent.length > 0 && <section className="grid gap-1" aria-labelledby="chat-recent-title">
      <h2 id="chat-recent-title" className={cn(SECTION_LABEL, 'px-2')}>Recent</h2>
      <ul className="grid" aria-label="Chats">
        {recent.map((row) => row.state === 'open'
          ? <OpenChatRow key={row.peer.id} row={row} state={state} selected={selected === row.peer.id} />
          : <ClosedChatRow key={row.userId} row={row} online={state.online} onReport={() => onReport(row)} onReopen={() => onReopen(row)} />)}
      </ul>
    </section>}
    {friends.length > 0 && <section className="grid gap-1" aria-labelledby="chat-friends-title">
      <h2 id="chat-friends-title" className={cn(SECTION_LABEL, 'px-2')}>Friends</h2>
      <ul className="grid" aria-label="Start a chat">
        {friends.map((row) => <OpenChatRow key={row.peer.id} row={row} state={state} selected={selected === row.peer.id} />)}
      </ul>
    </section>}
  </div>;
}

/** The Reconnecting hint says, on hover, whether instant updates are flowing or only the polling fallback. */
const liveTitle = (live: boolean) => (live ? 'Live updates connected' : 'Live updates disconnected, checking by polling');

/** Section labels in the chat list: a quiet 13 px semibold line, like an inbox. */
const SECTION_LABEL = 'text-[13px] font-semibold text-muted-foreground';

function previewText(row: OpenRow): string {
  const last = row.lastMessage;
  if (!last) return 'No messages yet';
  if (last.preview === null) return last.deletedBy === 'support' ? 'Hidden by support' : 'Message deleted';
  const preview = censorSlurs(last.preview);
  return last.fromMe ? `You: ${preview}` : preview;
}

function globalPreview(summary: GlobalSummary): string {
  const last = summary.lastMessage;
  if (!last) return 'Everyone on Quasar can post here';
  if (last.preview === null) return last.deletedBy === 'owner' ? `Removed by ${STAFF_NOUNS[last.moderatedBy ?? 'owner']}` : 'Message deleted';
  return `${last.fromMe ? 'You' : last.senderName}: ${censorSlurs(last.preview)}`;
}

function schoolPreview(summary: SchoolSummary): string {
  const last = summary.lastMessage;
  if (!last) return `Everyone at ${summary.schoolName} can post here`;
  if (last.preview === null) return last.deletedBy === 'owner' ? `Removed by ${STAFF_NOUNS[last.moderatedBy ?? 'owner']}` : 'Message deleted';
  return `${last.fromMe ? 'You' : last.senderName}: ${censorSlurs(last.preview)}`;
}

function groupPreview(group: GroupSummary): string {
  const last = group.lastMessage;
  if (!last) return pluralize(group.memberCount, 'member');
  if (last.preview === null) return last.deletedBy === 'support' ? 'Hidden by support' : last.deletedBy === 'admin' ? 'Removed by the group admin' : 'Message deleted';
  return `${last.fromMe ? 'You' : last.senderName}: ${censorSlurs(last.preview)}`;
}

/** The parts every list row shares: bold name while unread, mute icon, time, preview and the unread pill. */
function RowBody({ id, name, unread, muted, time, preview, verified, extra, mentioned = false }: { id: string; name: string; unread: number; muted: boolean; time: string | null; preview: string; verified?: boolean; extra?: ReactNode; mentioned?: boolean }) {
  return <span className="grid min-w-0 flex-1 gap-0.5">
    <span className="flex min-w-0 items-center gap-1.5">
      <strong className={cn('truncate text-[15px]', unread > 0 ? 'font-bold' : 'font-semibold')}>{name}</strong>
      {verified && <span id={`${id}-verified`} role="img" aria-label="Verified" className="shrink-0 text-success"><Icon name="checkCircle" size={14} /></span>}
      {extra}
      {muted && <span id={`${id}-muted`} role="img" aria-label="Notifications muted" className="shrink-0 text-muted-foreground"><Icon name="bellOff" size={13} /></span>}
      {time && <span id={`${id}-time`} className={cn('ml-auto shrink-0 pl-2 text-[12px] tabular-nums', unread > 0 && !muted ? 'font-semibold text-primary' : 'text-muted-foreground')}>{time}</span>}
    </span>
    <span className="flex min-w-0 items-center gap-2">
      <span id={`${id}-preview`} className={cn('truncate text-[13.5px] leading-snug', unread > 0 ? 'font-medium text-foreground' : 'text-muted-foreground')}>{preview}</span>
      {(unread > 0 || mentioned) && <span className="ml-auto flex shrink-0 items-center gap-1">
        {mentioned && <span id={`${id}-mentioned`} role="img" aria-label="You were mentioned" className="grid size-5 place-items-center rounded-full bg-primary-soft text-[12px] font-bold leading-none text-primary-soft-foreground ring-1 ring-inset ring-primary/30">@</span>}
        {unread > 0 && <span id={`${id}-unread`} role="img" aria-label={unread === 1 ? '1 unread message' : `${unread} unread messages`}
          className={cn('grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-bold leading-none tabular-nums', muted ? 'bg-muted-foreground/20 text-muted-foreground' : 'bg-primary text-primary-foreground')}>{unread > 99 ? '99+' : unread}</span>}
      </span>}
    </span>
  </span>;
}

/**
 * An inbox row: a 44 px picture, the name with the time at the right, a one-line preview, and a hairline under it
 * that starts where the text starts. The hairline is on the list item, so the last row of a section has none.
 */
const ROW_ITEM = 'relative after:pointer-events-none after:absolute after:bottom-0 after:left-[4.25rem] after:right-2 after:h-px after:bg-foreground/[0.07] last:after:hidden';
const ROW = 'flex w-full min-w-0 items-center gap-3 rounded-2xl px-2 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary-soft aria-[current=true]:text-primary-soft-foreground';
const describedBy = (id: string, parts: Array<string | false | null | undefined>) => parts.filter(Boolean).map((part) => `${id}-${part}`).join(' ');

/** The global room's row. It is always present and sits above the friend groups. */
function GlobalChatRow({ summary, state, selected }: { summary: GlobalSummary; state: AppState; selected: boolean }) {
  const id = useId();
  const mentioned = useBeta(CHAT_POLISH) && !!summary.mentioned;
  return <li className={ROW_ITEM}>
    <button type="button" data-chat-row={GLOBAL_ROOM} aria-label={`Open ${GLOBAL_NAME}`} aria-describedby={describedBy(id, ['preview', summary.lastMessage && 'time', mentioned && 'mentioned', summary.unread > 0 && 'unread', summary.muted && 'muted'])} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { room: GLOBAL_ROOM })} className={ROW}>
      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground ring-1 ring-inset ring-primary/15"><Icon name="users" size={20} /></span>
      <RowBody id={id} name={GLOBAL_NAME} unread={summary.unread} muted={summary.muted} time={summary.lastMessage ? chatTime(summary.lastMessage.createdAt, state.timeZone, state.now) : null} preview={globalPreview(summary)} mentioned={mentioned} />
    </button>
  </li>;
}

/** The member's school room's row, right under the global room's. */
function SchoolChatRow({ summary, state, selected }: { summary: SchoolSummary; state: AppState; selected: boolean }) {
  const id = useId();
  const mentioned = useBeta(CHAT_POLISH) && !!summary.mentioned;
  return <li className={ROW_ITEM}>
    <button type="button" data-chat-row={SCHOOL_ROOM} aria-label={`Open ${SCHOOL_NAME}, ${summary.schoolName}`} aria-describedby={describedBy(id, ['school', 'preview', summary.lastMessage && 'time', mentioned && 'mentioned', summary.unread > 0 && 'unread', summary.muted && 'muted'])} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { room: SCHOOL_ROOM })} className={ROW}>
      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground ring-1 ring-inset ring-primary/15"><Icon name="school" size={20} /></span>
      <RowBody id={id} name={SCHOOL_NAME} unread={summary.unread} muted={summary.muted} time={summary.lastMessage ? chatTime(summary.lastMessage.createdAt, state.timeZone, state.now) : null} preview={schoolPreview(summary)} mentioned={mentioned}
        extra={<span id={`${id}-school`} className="min-w-0 truncate text-[12px] text-muted-foreground">{summary.schoolName}</span>} />
    </button>
  </li>;
}

function GroupChatRow({ group, state, selected }: { group: GroupSummary; state: AppState; selected: boolean }) {
  const id = useId();
  const mentioned = useBeta(CHAT_POLISH) && !!group.mentioned;
  return <li className={ROW_ITEM}>
    <button type="button" data-chat-row={groupKey(group.id)} aria-label={`Open group ${group.name}`} aria-describedby={describedBy(id, ['preview', group.lastMessage && 'time', mentioned && 'mentioned', group.unread > 0 && 'unread', group.muted && 'muted'])} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { group: group.id })} className={ROW}>
      <AvatarStack members={group.members} size="sm" max={2} className="w-11 justify-center" />
      <RowBody id={id} name={group.name} unread={group.unread} muted={group.muted} time={group.lastMessage ? chatTime(group.lastMessage.createdAt, state.timeZone, state.now) : null} preview={groupPreview(group)} mentioned={mentioned} />
    </button>
  </li>;
}

function OpenChatRow({ row, state, selected }: { row: OpenRow; state: AppState; selected: boolean }) {
  const id = useId();
  const name = row.peer.displayName;
  return <li className={ROW_ITEM}>
    <button type="button" data-chat-row={row.peer.id} aria-label={`Open chat with ${name}`} aria-describedby={describedBy(id, [row.peer.verified && 'verified', 'preview', row.lastMessage && 'time', row.unread > 0 && 'unread', row.muted && 'muted'])} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { with: row.peer.id })} className={ROW}>
      <MemberAvatar name={name} src={row.peer.avatar} className="size-11 text-[15px]" />
      <RowBody id={id} name={name} verified={row.peer.verified} unread={row.unread} muted={row.muted} time={row.lastMessage ? chatTime(row.lastMessage.createdAt, state.timeZone, state.now) : null} preview={previewText(row)} />
    </button>
  </li>;
}

/** The reopen control for a closed chat: lift the viewer's own block, or send a friend request. Nothing about the other side's block shows. */
function ReopenButton({ row, online, onReopen, size = 'sm', variant = 'ghost' }: { row: ClosedRow; online: boolean; onReopen: () => Promise<void>; size?: 'sm' | 'md'; variant?: 'ghost' | 'secondary' | 'primary' }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!row.reopen) return null;
  const run = async () => {
    setPending(true); setError('');
    try { await onReopen(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const label = row.reopen === 'unblock' ? 'Unblock' : 'Add friend';
  return <span className="grid justify-items-end gap-1">
    <Button size={size} variant={variant} icon={row.reopen === 'unblock' ? 'unlock' : 'plus'} aria-label={label === 'Unblock' ? `Unblock ${row.displayName} and reopen the chat` : `Add friend: ${row.displayName}`} busy={pending} disabled={!online} onClick={() => void run()}>{label}</Button>
    {error && <Hint tone="danger" role="alert" className="text-right text-[12px]">{error}</Hint>}
  </span>;
}

/**
 * A closed chat: no history, no link, a reopen control (when the viewer can) and Report tucked into the row's menu.
 * It looks the same however the chat closed.
 */
function ClosedChatRow({ row, online, onReport, onReopen }: { row: ClosedRow; online: boolean; onReport: () => void; onReopen: () => Promise<void> }) {
  return <li className={cn(ROW_ITEM, 'flex min-w-0 items-center gap-3 rounded-2xl px-2 py-2.5')}>
    <MemberAvatar name={row.displayName} muted className="size-11 text-[15px]" />
    <span className="grid min-w-0 flex-1 gap-0.5">
      <strong className="truncate text-[15px] font-semibold">{row.displayName}</strong>
      <span className="text-[13.5px] leading-snug text-muted-foreground">Chat closed</span>
    </span>
    <ReopenButton row={row} online={online} onReopen={onReopen} />
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild><IconButton label={`More options for ${row.displayName}`} icon="more" size="sm" className="rounded-full" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem disabled={!online} onSelect={onReport}><Icon name="flag" />Report {row.displayName}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </li>;
}

/* ---------- Thread frame and header ---------- */

/**
 * The thread's frame. On phones the header and composer bleed to the screen edges as translucent bars (BAR), so
 * the frame must not clip there; on desktop it is a card that clips to its corners.
 */
const FRAME = 'flex min-h-0 flex-1 flex-col outline-none max-lg:overflow-visible lg:overflow-hidden lg:rounded-3xl lg:bg-card lg:shadow-card lg:ring-1 lg:ring-foreground/[0.06]';
/** The header and composer: a frosted bar with a hairline edge, edge to edge on phones. */
const BAR = 'bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/80 max-lg:-mx-4 max-lg:px-4 lg:bg-card/85';

/** On phones the list (and the row that opened this chat) unmounts, so focus moves to the thread itself once. */
function useThreadFocus(phone: boolean) {
  const section = useRef<HTMLElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!phone || focused.current) return;
    focused.current = true;
    if (!section.current?.contains(document.activeElement)) section.current?.focus({ preventScroll: true });
  }, [phone]);
  return section;
}

function BackButton({ state }: { state: AppState }) {
  return <IconButton label="Back to chats" icon="chevronLeft" className="-ml-1 rounded-full lg:hidden" onClick={() => state.navigate('messages')} />;
}

/** The thread header: back, picture, the name with a smaller second line, and whatever sits at the right. */
const HEADER = cn(BAR, 'flex items-center gap-2.5 border-b border-foreground/[0.07] py-2 max-lg:-mt-5 lg:px-4 lg:pt-3');
const HEADER_NAME = 'w-fit max-w-full truncate rounded-md text-left text-[16px] font-bold leading-tight outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring';

/** The loading and error state of a thread that has not answered yet. */
function ThreadLoading({ state, chat, back, title }: { state: AppState; chat: ChatThread; back: ReactNode; title: ReactNode }) {
  return <>
    <div className="flex items-center gap-2 lg:px-4 lg:pt-3">{back}{title}</div>
    <div className="grid gap-3 py-4 lg:px-4">
      {chat.status === 'error' && chat.error
        ? <Callout tone="danger" icon="alert" role="alert" actions={<Button size="sm" disabled={!state.online} onClick={chat.pollNow}>Try again</Button>}>{chat.error}</Callout>
        : state.online && <Hint role="status">Loading messages…</Hint>}
    </div>
  </>;
}

/** The one-line nudge above a thread's composer, in the bar's own translucent treatment. */
function ComposerNudge({ nudge }: { nudge: ChatNotifications }) {
  if (!nudge.reason || nudge.hidden) return null;
  return <div className={cn(BAR, 'pt-2')}><NotificationNudge nudge={nudge} compact /></div>;
}

/** The composer's replacement while support has paused the student: the reason and an appeal (docs/CHAT.md §14). */
function PausedComposer({ pause, state, onAppealed }: { pause: ChatPause; state: AppState; onAppealed: () => void }) {
  const [appealing, setAppealing] = useState(false);
  return <div className={cn(BAR, 'grid gap-2 border-t border-foreground/[0.07] pt-3 pb-[max(8px,env(safe-area-inset-bottom))] lg:px-4 lg:pb-4')}>
    <Hint role="status" className="text-[13px]">{pauseText(pause, state.timeZone)} Reason: {pause.reason}</Hint>
    <div>{pause.appealed ? <Chip tone="neutral" icon="clock">Appeal sent. Support will review it.</Chip> : <Button size="sm" disabled={!state.online} onClick={() => setAppealing(true)}>Appeal</Button>}</div>
    {appealing && <AppealModal accountId={state.context.user.id} kind="pause" what="your messaging pause" onClose={() => setAppealing(false)} onSent={async () => { setAppealing(false); onAppealed(); await state.refresh(); }} />}
  </div>;
}

/* ---------- One-to-one thread ---------- */

type ThreadModal = { kind: 'delete'; messageId: string } | { kind: 'block' } | { kind: 'report'; seq?: number } | null;

function Thread({ state, userId, phone, nudge, fallbackName, closedRow, onChange, onClosed, onReportClosed, onReopen, onLeave }: {
  state: AppState; userId: string; phone: boolean; nudge: ChatNotifications; fallbackName: string; closedRow: ClosedRow | null;
  onChange: () => void; onClosed: () => void; onReportClosed: (row: ClosedRow) => void; onReopen: (row: ClosedRow) => Promise<void>; onLeave: (notice: string) => void;
}) {
  const chat = useChatThread(state, { kind: 'peer', userId }, { onChange });
  const name = chat.peer?.displayName ?? fallbackName;
  const [modal, setModal] = useState<ThreadModal>(null);
  const [actionError, setActionError] = useState('');
  const [reported, setReported] = useState(false);
  const [muting, setMuting] = useState(false);
  const polish = useBeta(CHAT_POLISH);
  const [searching, setSearching] = useState(false);
  const back = <BackButton state={state} />;
  const section = useThreadFocus(phone);

  // A closed chat refreshes the list, which says whether a closed row (and so Report) exists.
  useEffect(() => { if (chat.status === 'closed') onClosed(); }, [chat.status, onClosed]);

  const frame = (children: ReactNode) => <section ref={section} tabIndex={-1} aria-label={name ? `Chat with ${name}` : 'Chat'} className={FRAME}>{children}</section>;

  if (chat.status === 'closed') {
    return frame(<>
      <div className="flex items-center gap-2 lg:px-4 lg:pt-3">{back}</div>
      <EmptyState icon="lock" title="This chat is closed." action={<div className="flex flex-wrap justify-center gap-2">
        {closedRow && <ReopenButton row={closedRow} online={state.online} onReopen={() => onReopen(closedRow)} size="md" variant="secondary" />}
        {closedRow && <Button disabled={!state.online} onClick={() => onReportClosed(closedRow)}>Report</Button>}
        <Button variant="primary" onClick={() => state.navigate('messages')}>All chats</Button>
      </div>}>{closedRow?.reopen === 'unblock' ? 'You blocked this person. Unblocking sends them a friend request; the chat and its history come back when they accept.' : closedRow?.reopen === 'friend' ? 'Add them as a friend again to reopen the chat with its history.' : undefined}</EmptyState>
    </>);
  }

  if (!chat.peer) return frame(<ThreadLoading state={state} chat={chat} back={back} title={fallbackName && <strong className="truncate text-[15px] font-bold">{fallbackName}</strong>} />);

  const peer = chat.peer;
  const toggleMute = async () => {
    setMuting(true); setActionError('');
    try { await chat.setMuted(!chat.muted); } catch (err) { setActionError(errorMessage(err)); } finally { setMuting(false); }
  };

  return frame(<>
    <header className={HEADER}>
      {back}
      <MemberAvatar name={name} src={peer.avatar} size="md" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <button type="button" aria-label={`Open ${name}’s profile`} onClick={() => state.navigate('people', { member: userId })} className={HEADER_NAME}>{name}</button>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {peer.verified ? <Chip tone="success" icon="checkCircle" className="min-h-5 px-2 text-[11px]">Verified</Chip> : <Chip tone="outline" className="min-h-5 px-2 text-[11px]">Not verified</Chip>}
          {peer.fullName && <Hint className="truncate text-[12.5px]">{peer.fullName}</Hint>}
          {chat.muted && <span role="img" aria-label="Notifications muted" className="text-muted-foreground"><Icon name="bellOff" size={14} /></span>}
          {chat.reconnecting && <Hint role="status" title={liveTitle(chat.live)}>Reconnecting…</Hint>}
        </div>
      </div>
      <NotificationNudgeChip nudge={nudge} />
      {/* Report and Block live in the menu: they matter, but they are not what a chat is for. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><IconButton label="More options" icon="more" className="rounded-full" aria-busy={muting || undefined} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => state.navigate('people', { member: userId })}><Icon name="users" />View profile</DropdownMenuItem>
          {polish && <DropdownMenuItem disabled={!state.online} onSelect={() => setSearching(true)}><Icon name="search" />Search messages</DropdownMenuItem>}
          <DropdownMenuItem disabled={!state.online || muting} onSelect={() => void toggleMute()}><Icon name={chat.muted ? 'bell' : 'bellOff'} />{chat.muted ? 'Unmute notifications' : 'Mute notifications'}</DropdownMenuItem>
          <DropdownMenuSeparator />
          {chat.messages.length > 0 && <DropdownMenuItem disabled={!state.online} onSelect={() => { setReported(false); setModal({ kind: 'report' }); }}><Icon name="flag" />Report {name}</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" disabled={!state.online} onSelect={() => setModal({ kind: 'block' })}><Icon name="ban" />Block {name}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
    {(actionError || reported) && <div className="grid gap-2 pt-3 lg:px-4">
      {actionError && <Callout tone="danger" icon="alert" role="alert">{actionError}</Callout>}
      {reported && <Callout tone="success" icon="check" role="status">Report sent to support.</Callout>}
    </div>}
    <MessageLog state={state} chat={chat} name={name} mode="peer" searching={searching} onSearchClose={() => setSearching(false)} onDelete={(message) => setModal({ kind: 'delete', messageId: message.id })} onReport={(seq) => { setReported(false); setModal({ kind: 'report', seq }); }} />
    <ComposerNudge nudge={nudge} />
    {chat.pause
      ? <PausedComposer pause={chat.pause} state={state} onAppealed={() => { chat.pollNow(); onChange(); }} />
      : <Composer key={userId} chat={chat} name={name} online={state.online} filtered />}

    {modal?.kind === 'delete' && <ConfirmModal title="Delete for both of you?" description={`It disappears from this chat now. Support can still see it for ${CHAT.deletedTextDays} days if this chat is reported.`} confirm="Delete" online={state.online}
      onClose={() => setModal(null)} onConfirm={async () => { await chat.deleteMessage(modal.messageId); setModal(null); }} />}
    {modal?.kind === 'block' && <ConfirmModal title={`Block ${name}?`} description={`You won’t see each other in People, their Global chat, school chat and group messages are hidden from you, and this chat closes.`} confirm="Block" online={state.online}
      onClose={() => setModal(null)} onConfirm={async () => {
        await api.community.block.mutate({ accountId: state.context.user.id, userId, blocked: true });
        setModal(null);
        onLeave(`${name} is blocked.`);
      }} />}
    {modal?.kind === 'report' && <ReportModal state={state} name={name} target={{ kind: 'peer', userId, mode: modal.seq ? 'message' : 'chat', seq: modal.seq }} onClose={() => setModal(null)}
      onSent={(blocked) => { setModal(null); if (blocked) onLeave(`Report sent. ${name} is blocked.`); else setReported(true); }} />}
  </>);
}

/* ---------- Friend group thread (docs/CHAT.md §12) ---------- */

type GroupModal = { kind: 'delete'; message: ChatMessage } | { kind: 'report'; message: ChatMessage } | { kind: 'members' } | { kind: 'rename' } | { kind: 'leave' } | null;

function GroupThread({ state, groupId, phone, nudge, friends, onChange, onLeave }: { state: AppState; groupId: string; phone: boolean; nudge: ChatNotifications; friends: Friend[]; onChange: () => void; onLeave: (notice: string) => void }) {
  const chat = useChatThread(state, { kind: 'group', groupId }, { onChange });
  const [modal, setModal] = useState<GroupModal>(null);
  const [actionError, setActionError] = useState('');
  const [reported, setReported] = useState(false);
  const [muting, setMuting] = useState(false);
  const polish = useBeta(CHAT_POLISH);
  const [searching, setSearching] = useState(false);
  const back = <BackButton state={state} />;
  const section = useThreadFocus(phone);
  const group = chat.group;
  const name = group?.name ?? 'Group';
  const frame = (children: ReactNode) => <section ref={section} tabIndex={-1} aria-label={`Group ${name}`} className={FRAME}>{children}</section>;

  if (chat.status === 'closed') {
    return frame(<>
      <div className="flex items-center gap-2 lg:px-4 lg:pt-3">{back}</div>
      <EmptyState icon="lock" title="You’re not in this group anymore." action={<Button variant="primary" onClick={() => state.navigate('messages')}>All chats</Button>}>You left, or the group’s admin removed you. A friend can add you again.</EmptyState>
    </>);
  }
  if (chat.status !== 'ready' || !group) return frame(<ThreadLoading state={state} chat={chat} back={back} title={<strong className="truncate text-[15px] font-bold">Group</strong>} />);

  const me = state.context.user.id;
  const admin = group.role === 'admin';
  const others = group.members.filter((member) => member.id !== me);
  const toggleMute = async () => {
    setMuting(true); setActionError('');
    try { await chat.setMuted(!chat.muted); } catch (err) { setActionError(errorMessage(err)); } finally { setMuting(false); }
  };

  return frame(<>
    <header className={HEADER}>
      {back}
      <AvatarStack members={others} size="sm" max={3} className="w-12 justify-center" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <button type="button" aria-label={`Open the members of ${name}`} onClick={() => setModal({ kind: 'members' })} className={HEADER_NAME}>{name}</button>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip tone="neutral" icon="users" className="min-h-5 px-2 text-[11px]">{pluralize(group.members.length, 'member')}</Chip>
          {admin && <Chip tone="accent" icon="crown" className="min-h-5 px-2 text-[11px]">You’re the admin</Chip>}
          {chat.muted && <span role="img" aria-label="Notifications muted" className="text-muted-foreground"><Icon name="bellOff" size={14} /></span>}
          {chat.reconnecting && <Hint role="status" title={liveTitle(chat.live)}>Reconnecting…</Hint>}
        </div>
      </div>
      <NotificationNudgeChip nudge={nudge} />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><IconButton label="More options" icon="more" className="rounded-full" aria-busy={muting || undefined} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => setModal({ kind: 'members' })}><Icon name="users" />{admin ? 'Members and adding people' : 'Members'}</DropdownMenuItem>
          {polish && <DropdownMenuItem disabled={!state.online} onSelect={() => setSearching(true)}><Icon name="search" />Search messages</DropdownMenuItem>}
          {admin && <DropdownMenuItem disabled={!state.online} onSelect={() => setModal({ kind: 'rename' })}><Icon name="edit" />Rename group</DropdownMenuItem>}
          <DropdownMenuItem disabled={!state.online || muting} onSelect={() => void toggleMute()}><Icon name={chat.muted ? 'bell' : 'bellOff'} />{chat.muted ? 'Unmute notifications' : 'Mute notifications'}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={!state.online} onSelect={() => setModal({ kind: 'leave' })}><Icon name="logout" />Leave group</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
    {(actionError || reported) && <div className="grid gap-2 pt-3 lg:px-4">
      {actionError && <Callout tone="danger" icon="alert" role="alert">{actionError}</Callout>}
      {reported && <Callout tone="success" icon="check" role="status">Report sent to support.</Callout>}
    </div>}
    <MessageLog state={state} chat={chat} name={name} mode="group" canModerate={admin} searching={searching} onSearchClose={() => setSearching(false)}
      onDelete={(message) => setModal({ kind: 'delete', message })} onReport={(seq) => { const message = chat.messages.find((entry) => entry.seq === seq); if (message) { setReported(false); setModal({ kind: 'report', message }); } }} />
    <ComposerNudge nudge={nudge} />
    {chat.pause
      ? <PausedComposer pause={chat.pause} state={state} onAppealed={() => { chat.pollNow(); onChange(); }} />
      : <Composer key={groupId} chat={chat} name={name} online={state.online} filtered people={others} />}

    {modal?.kind === 'delete' && (modal.message.fromMe
      ? <ConfirmModal title="Delete for everyone?" description={`It disappears from the group now. Support can still see it for ${CHAT.deletedTextDays} days if it is reported.`} confirm="Delete" online={state.online}
          onClose={() => setModal(null)} onConfirm={async () => { await chat.deleteMessage(modal.message.id); setModal(null); }} />
      : <ConfirmModal title={`Remove ${senderName(modal.message)}’s message?`} description="Everyone in the group sees “Removed by the group admin” in its place." confirm="Remove" online={state.online}
          onClose={() => setModal(null)} onConfirm={async () => { await chat.deleteMessage(modal.message.id); setModal(null); }} />)}
    {modal?.kind === 'report' && <ReportModal state={state} name={senderName(modal.message)} target={{ kind: 'group', groupId, seq: modal.message.seq }} onClose={() => setModal(null)}
      onSent={(blocked) => { setModal(null); setReported(true); if (blocked) chat.pollNow(); }} />}
    {modal?.kind === 'members' && <GroupMembersModal state={state} group={group} friends={friends} onClose={() => setModal(null)} onChanged={() => { chat.pollNow(); onChange(); }} />}
    {modal?.kind === 'rename' && <RenameGroupModal state={state} group={group} onClose={() => setModal(null)} onRenamed={() => { setModal(null); chat.pollNow(); onChange(); }} />}
    {modal?.kind === 'leave' && <ConfirmModal title={`Leave ${name}?`} description={admin && others.length > 0 ? 'The member who has been in the group longest becomes its admin. You can only come back if they add you.' : 'You can only come back if the group’s admin adds you again.'} confirm="Leave" online={state.online}
      onClose={() => setModal(null)} onConfirm={async () => { await api.group.leave.mutate({ accountId: me, groupId }); setModal(null); onLeave(`You left ${name}.`); }} />}
  </>);
}

/** The members of a group; the admin also adds friends and removes people here. Tapping a member opens their profile. */
function GroupMembersModal({ state, group, friends, onClose, onChanged }: { state: AppState; group: GroupInfo; friends: Friend[]; onClose: () => void; onChanged: () => void }) {
  const me = state.context.user.id;
  const admin = group.role === 'admin';
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const addable = friends.filter((friend) => !group.members.some((member) => member.id === friend.id));
  const room = CHAT.groupMaxMembers - group.members.length;
  const run = async (key: string, action: () => Promise<unknown>) => {
    setPending(key); setError('');
    try { await action(); onChanged(); } catch (err) { setError(errorMessage(err)); } finally { setPending(null); }
  };
  return <Modal open onClose={onClose} busy={pending !== null} dirty={picked.length > 0} title={group.name} description={`${pluralize(group.members.length, 'member')} · up to ${CHAT.groupMaxMembers}. ${admin ? 'You made this group, so you add and remove people.' : 'The admin adds and removes people; anyone can leave.'}`}>
    <ul className="grid gap-1" aria-label="Members">
      {group.members.map((member) => <li key={member.id} className="flex items-center gap-3 rounded-2xl px-2 py-2">
        {member.id === me
          ? <><MemberAvatar name={member.displayName} src={member.avatar} /><span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-bold">{member.displayName} <span className="font-medium text-muted-foreground">(you)</span></strong></span></>
          : <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${member.displayName}’s profile`} onClick={() => { onClose(); state.navigate('people', { member: member.id }); }}>
            <MemberAvatar name={member.displayName} src={member.avatar} />
            <span className="grid min-w-0 flex-1"><strong className="flex items-center gap-1.5 truncate text-sm font-bold">{member.displayName}{member.verified && <Icon name="checkCircle" size={14} className="shrink-0 text-success" />}</strong></span>
          </button>}
        {member.role === 'admin' && <Chip tone="accent" icon="crown">Admin</Chip>}
        {admin && member.id !== me && <Button size="sm" variant="ghost" icon="userMinus" aria-label={`Remove ${member.displayName} from the group`} busy={pending === member.id} disabled={!state.online || pending !== null}
          onClick={() => void run(member.id, () => api.group.removeMember.mutate({ accountId: me, groupId: group.id, userId: member.id }))}>Remove</Button>}
      </li>)}
    </ul>
    {admin && <div className="grid gap-2 border-t pt-4">
      <strong className="text-sm font-bold">Add friends</strong>
      {addable.length === 0 && <Hint>All of your friends are already here, or you have no other friends yet.</Hint>}
      {addable.length > 0 && <FriendPicker friends={addable} picked={picked} onChange={setPicked} disabled={pending !== null} limit={room} />}
      {addable.length > 0 && <div><Button size="sm" variant="primary" icon="userPlus" busy={pending === 'add'} disabled={!state.online || picked.length === 0 || pending !== null}
        onClick={() => void run('add', async () => { await api.group.addMembers.mutate({ accountId: me, groupId: group.id, memberIds: picked }); setPicked([]); })}>Add {picked.length > 0 ? pluralize(picked.length, 'friend') : 'to group'}</Button></div>}
    </div>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

/** Checkboxes for friends, capped at `limit` picks. */
function FriendPicker({ friends, picked, onChange, disabled, limit }: { friends: Friend[]; picked: string[]; onChange: (ids: string[]) => void; disabled?: boolean; limit: number }) {
  const id = useId();
  return <ul className="grid max-h-[40vh] gap-1 overflow-y-auto" aria-label="Friends to add">
    {friends.map((friend) => {
      const checked = picked.includes(friend.id);
      const full = !checked && picked.length >= limit;
      return <li key={friend.id}>
        <Label htmlFor={`${id}-${friend.id}`} className={cn('flex cursor-pointer items-center gap-3 rounded-2xl px-2 py-2 hover:bg-muted', full && 'opacity-50')}>
          <Checkbox id={`${id}-${friend.id}`} checked={checked} disabled={disabled || full} onCheckedChange={(value) => onChange(value === true ? [...picked, friend.id] : picked.filter((entry) => entry !== friend.id))} />
          <MemberAvatar name={friend.displayName} src={friend.avatar} size="sm" />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold"><span className="truncate">{friend.displayName}</span>{friend.verified && <Icon name="checkCircle" size={14} className="shrink-0 text-success" />}</span>
        </Label>
      </li>;
    })}
  </ul>;
}

function NewGroupModal({ state, friends, onClose, onCreated }: { state: AppState; friends: Friend[]; onClose: () => void; onCreated: (group: GroupInfo) => void }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const trimmed = name.trim();
  const create = async () => {
    setPending(true); setError('');
    try { onCreated(await api.group.create.mutate({ accountId: state.context.user.id, name: trimmed, memberIds: picked })); }
    catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={trimmed.length > 0 || picked.length > 0} title="New group" description={`A group chat with your friends, up to ${CHAT.groupMaxMembers} people. You add and remove people; anyone can leave.`}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="primary" icon="newGroup" busy={pending} disabled={!state.online || !trimmed || picked.length === 0} onClick={() => void create()}>Create group</Button></>}>
    <Field label="Group name" htmlFor="group-name"><Input id="group-name" autoFocus maxLength={CHAT.groupNameMax} placeholder="Study crew" value={name} onChange={(event) => setName(event.target.value)} disabled={pending} /></Field>
    <div className="grid gap-2">
      <span className="text-[13px] font-semibold text-foreground/80">Friends to add ({picked.length} of {CHAT.groupMaxMembers - 1})</span>
      {friends.length === 0 ? <Hint>Add friends in People first.</Hint> : <FriendPicker friends={friends} picked={picked} onChange={setPicked} disabled={pending} limit={CHAT.groupMaxMembers - 1} />}
    </div>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

function RenameGroupModal({ state, group, onClose, onRenamed }: { state: AppState; group: GroupInfo; onClose: () => void; onRenamed: () => void }) {
  const [name, setName] = useState(group.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const trimmed = name.trim();
  const save = async () => {
    setPending(true); setError('');
    try { await api.group.rename.mutate({ accountId: state.context.user.id, groupId: group.id, name: trimmed }); onRenamed(); }
    catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={trimmed !== group.name} title="Rename group"
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={!state.online || !trimmed || trimmed === group.name} onClick={() => void save()}>Save</Button></>}>
    <Field label="Group name" htmlFor="group-rename"><Input id="group-rename" autoFocus maxLength={CHAT.groupNameMax} value={name} onChange={(event) => setName(event.target.value)} disabled={pending} /></Field>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

/* ---------- Room threads: the global chat and the school chat ---------- */

type RoomModal = { kind: 'delete'; message: ChatMessage } | { kind: 'edit'; message: ChatMessage } | null;

/**
 * A room: the global chat (§11) or the member's school chat (§16). No block, report or "closed" state for the global
 * room: it is public, and the owner moderates it directly with Edit and Delete on any message, each with a reason
 * everyone can read. The school room works the same for one school's members; it closes for someone who left the
 * school. The header switches between the two rooms.
 */
function RoomThread({ state, kind, phone, nudge, onChange }: { state: AppState; kind: RoomKind; phone: boolean; nudge: ChatNotifications; onChange: () => void }) {
  const schoolId = state.context.school.id;
  const target = useMemo<ChatTarget>(() => (kind === 'school' ? { kind: 'school', schoolId } : GLOBAL_TARGET), [kind, schoolId]);
  const chat = useChatThread(state, target, { onChange });
  const [modal, setModal] = useState<RoomModal>(null);
  const [actionError, setActionError] = useState('');
  const [muting, setMuting] = useState(false);
  const polish = useBeta(CHAT_POLISH);
  const [searching, setSearching] = useState(false);
  const me = state.context.user.id;
  /** Who "@" can offer in a room: the people who posted in the part of it this device has loaded. */
  const people = useMemo(() => recentSenders(chat.messages, me), [chat.messages, me]);
  const canModerate = chat.room?.canModerate ?? false;
  const schoolName = chat.school?.name ?? state.context.school.name;
  const name = kind === 'school' ? SCHOOL_NAME : GLOBAL_NAME;
  // How the note under a message this viewer moderates names them ("Removed by a moderator").
  const moderator = STAFF_NOUNS[chat.room?.moderator ?? 'owner'];
  const back = <BackButton state={state} />;
  const section = useThreadFocus(phone);
  const frame = (children: ReactNode) => <section ref={section} tabIndex={-1} aria-label={kind === 'school' ? `${SCHOOL_NAME}, ${schoolName}` : GLOBAL_NAME} className={FRAME}>{children}</section>;
  /** Both rooms side by side: the switch sits in the header, so the two chats read as one place. */
  const switcher = <Segmented size="sm" label="Room" value={kind} className="shrink-0" onChange={(next) => state.navigate('messages', { room: next === 'school' ? SCHOOL_ROOM : GLOBAL_ROOM })}
    options={[{ value: 'global', label: 'Global' }, { value: 'school', label: 'School' }]} />;

  if (chat.status === 'closed') return frame(<>
    <div className="flex items-center gap-2 lg:px-4 lg:pt-3">{back}<strong className="truncate text-[15px] font-bold">{name}</strong><span className="ml-auto">{switcher}</span></div>
    <div className="grid gap-3 py-4 lg:px-4">
      <Callout tone="neutral" icon="school" role="status">You’re not in this school’s chat anymore. Each school’s chat is for the people at that school.</Callout>
    </div>
  </>);
  if (chat.status !== 'ready' || !chat.room) return frame(<ThreadLoading state={state} chat={chat} back={back} title={<><strong className="truncate text-[15px] font-bold">{name}</strong><span className="ml-auto">{switcher}</span></>} />);

  const members = chat.room.members;
  const toggleMute = async () => {
    setMuting(true); setActionError('');
    try { await chat.setMuted(!chat.muted); } catch (err) { setActionError(errorMessage(err)); } finally { setMuting(false); }
  };
  const mine = modal?.kind === 'delete' && modal.message.fromMe;
  const everyone = kind === 'school' ? `everyone at ${schoolName}` : 'everyone';

  return frame(<>
    <header className={HEADER}>
      {back}
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground ring-1 ring-inset ring-primary/15"><Icon name={kind === 'school' ? 'school' : 'users'} size={18} /></span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <strong className="truncate text-[16px] font-bold leading-tight">{kind === 'school' ? schoolName : GLOBAL_NAME}</strong>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip tone="neutral" icon="users" className="min-h-5 px-2 text-[11px]">{members === 1 ? '1 member' : `${members} members`}</Chip>
          {canModerate && <Chip tone="success" icon="checkCircle" className="min-h-5 px-2 text-[11px]">You moderate this room</Chip>}
          {chat.reconnecting && <Hint role="status" title={liveTitle(chat.live)}>Reconnecting…</Hint>}
        </div>
      </div>
      <span className="max-sm:hidden">{switcher}</span>
      <NotificationNudgeChip nudge={nudge} />
      {polish && <IconButton label="Search messages" icon="search" className="rounded-full" aria-pressed={searching} disabled={!state.online} onClick={() => setSearching((current) => !current)} />}
      <IconButton label={chat.muted ? 'Unmute notifications' : 'Mute notifications'} icon={chat.muted ? 'bell' : 'bellOff'} className="rounded-full" aria-busy={muting || undefined} disabled={!state.online || muting} onClick={() => void toggleMute()} />
    </header>
    {/* Narrow phones have no room for the switch in the header row, so it gets its own line under it. */}
    <div className={cn(BAR, 'flex justify-center border-b border-foreground/[0.07] py-1.5 sm:hidden')}>{switcher}</div>
    {actionError && <div className="grid gap-2 pt-3 lg:px-4"><Callout tone="danger" icon="alert" role="alert">{actionError}</Callout></div>}
    <MessageLog state={state} chat={chat} name={kind === 'school' ? schoolName : 'everyone'} mode={kind} canModerate={canModerate} searching={searching} onSearchClose={() => setSearching(false)}
      onDelete={(message) => setModal({ kind: 'delete', message })} onEdit={(message) => setModal({ kind: 'edit', message })} />
    <ComposerNudge nudge={nudge} />
    {chat.pause
      ? <PausedComposer pause={chat.pause} state={state} onAppealed={() => { chat.pollNow(); onChange(); }} />
      : <Composer key={kind} chat={chat} name={everyone} online={state.online} filtered people={people} />}

    {modal?.kind === 'delete' && (mine
      ? <ConfirmModal title="Delete for everyone?" description={`It disappears from the ${kind === 'school' ? 'school' : 'global'} chat now.`} confirm="Delete" online={state.online}
          onClose={() => setModal(null)} onConfirm={async () => { await chat.deleteMessage(modal.message.id); setModal(null); }} />
      : <ReasonModal title={`Remove ${senderName(modal.message)}’s message?`} description={`Everyone sees “Removed by ${moderator}” and your reason in its place.`} confirm="Remove" online={state.online}
          onClose={() => setModal(null)} onConfirm={async (reason) => { await chat.deleteMessage(modal.message.id, reason); setModal(null); }} />)}
    {modal?.kind === 'edit' && <EditModal message={modal.message} moderator={moderator} online={state.online} onClose={() => setModal(null)}
      onSave={async (body, reason) => { await chat.editMessage(modal.message.id, body, reason); setModal(null); }} />}
  </>);
}

/* ---------- Message log ---------- */

type LogItem =
  | { kind: 'time'; key: string; day: string | null; time: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: ChatMessage; date: string; time: string; startsRun: boolean; endsRun: boolean; showName: boolean };

/**
 * Messages become runs (the same sender, within RUN_GAP_MS, on one day) with a centred time header over each cluster:
 * "Today 4:07 PM" when the day changes, just "4:30 PM" after a gap inside a day. The first and last bubble of a run
 * get the open corners and the tail; in a room or group the sender's name sits over the first bubble of their run.
 */
function buildItems(messages: ChatMessage[], initialReadSeq: number | null, timeZone: string, today: string, named: boolean): LogItem[] {
  const items: LogItem[] = [];
  const parts = messages.map((message) => instantParts(message.createdAt, timeZone));
  const firstUnread = initialReadSeq === null ? undefined : messages.find((message) => !message.fromMe && message.seq > initialReadSeq)?.seq;
  const gap = (later: ChatMessage, earlier: ChatMessage) => new Date(later.createdAt).getTime() - new Date(earlier.createdAt).getTime() > RUN_GAP_MS;
  messages.forEach((message, index) => {
    const { date, time } = parts[index]!;
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const newDay = !previous || parts[index - 1]!.date !== date;
    const afterGap = !previous || gap(message, previous);
    if (newDay || afterGap) items.push({ kind: 'time', key: `time-${message.seq}`, day: newDay ? dayLabel(date, today) : null, time: formatTime(time) });
    if (message.seq === firstUnread) items.push({ kind: 'unread', key: 'unread' });
    const startsRun = afterGap || senderKey(previous!) !== senderKey(message);
    const endsRun = !next || senderKey(next) !== senderKey(message) || parts[index + 1]!.date !== date || gap(next, message);
    const showName = named && !message.fromMe && startsRun;
    items.push({ kind: 'message', key: `m-${message.seq}`, message, date, time, startsRun, endsRun, showName });
  });
  return items;
}

function MessageLog({ state, chat, name, mode, canModerate = false, onDelete, onEdit, onReport, searching = false, onSearchClose }: {
  state: AppState; chat: ChatThread; name: string; mode: Mode; canModerate?: boolean;
  onDelete: (message: ChatMessage) => void; onEdit?: (message: ChatMessage) => void; onReport?: (seq: number) => void;
  /** Beta: the thread's "Search messages" is open, so the search bar sits over the top of the log. */
  searching?: boolean; onSearchClose?: () => void;
}) {
  const named = mode !== 'peer';
  /** Beta: the viewer's own message already rose in as a pending bubble, so its confirmed copy appears in place. */
  const polish = useBeta(CHAT_POLISH);
  const { messages, outgoing, receipts } = chat;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const forceBottom = useRef(false);
  const newestSeen = useRef<number | null>(null);
  /** Where the oldest loaded message sat before "Load earlier messages", so the reader keeps their place. */
  const prepend = useRef<{ firstSeq: number; offset: number } | null>(null);
  /** The log stops announcing while an older page is prepended, so a screen reader doesn't read the whole page. */
  const [quiet, setQuiet] = useState(false);
  const [jump, setJump] = useState(false);
  const [openActions, setOpenActions] = useState<number | null>(null);
  const [added, setAdded] = useState<Record<number, 'saving' | 'added' | string>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [earlierError, setEarlierError] = useState('');
  /** The bubble a quote tap just scrolled to; its ring pulses for a moment. */
  const [highlight, setHighlight] = useState<number | null>(null);
  const [reactError, setReactError] = useState<{ seq: number; text: string } | null>(null);
  /** Tapbacks and replies need the network and no messaging pause (docs/CHAT.md §15). */
  const canReact = state.online && !chat.pause;
  const items = useMemo(() => buildItems(messages, chat.initialReadSeq, state.timeZone, state.today, named), [messages, chat.initialReadSeq, state.timeZone, state.today, named]);
  /** The viewer's newest confirmed message carries the delivery or read caption (§13). */
  const lastMineSeq = useMemo(() => { for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]!.fromMe) return messages[index]!.seq; return null; }, [messages]);
  const typists = useMemo(() => receipts.filter((receipt) => receipt.typing), [receipts]);
  const typistsKey = typists.map((receipt) => receipt.id).join(',');
  /** Bubbles newer than the thread's first page rise in; the first page (and older pages) appear as they are. */
  const mountedNewest = useRef<number | null>(null);
  if (mountedNewest.current === null && chat.status === 'ready') mountedNewest.current = messages.at(-1)?.seq ?? 0;
  /** Incoming messages below the fold while scrolled up, for the count on the jump pill. */
  const unreadBelow = jump ? messages.filter((message) => !message.fromMe && message.seq > chat.lastReadSeq).length : 0;

  const nearBottom = () => {
    const element = scroller.current;
    return !element || element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
  };
  const toBottom = (smooth = false) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottom.current = true;
    setJump(false);
  };

  // Mark read when new incoming messages are on screen: the page is visible and the log is at the bottom.
  const latest = useRef({ messages, chat });
  // A layout effect, declared first, so the scroll effects below read this render's messages.
  useLayoutEffect(() => { latest.current = { messages, chat }; });
  const maybeRead = useCallback(() => {
    if (document.visibilityState !== 'visible' || !nearBottom()) return;
    const { messages: current, chat: thread } = latest.current;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const message = current[index]!;
      if (message.fromMe) continue;
      if (message.seq > thread.lastReadSeq) void thread.markRead(message.seq);
      return;
    }
  }, []);

  const offsetOf = (seq: number) => {
    const element = scroller.current;
    const row = element?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    return element && row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
  };
  const settleEarlier = () => {
    prepend.current = null;
    // Announcing resumes a moment after the prepended page is in the DOM, once screen readers have seen it land quietly.
    setTimeout(() => setQuiet(false), 300);
  };

  // Keep the reader's place: stick to the bottom only when already there (or after sending); restore
  // the position once an older page is actually prepended (a poll landing first leaves the anchor alone);
  // otherwise offer "New messages".
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const anchor = prepend.current;
    const first = messages[0];
    if (anchor && first && first.seq < anchor.firstSeq) {
      const offset = offsetOf(anchor.firstSeq);
      if (offset !== null) element.scrollTop += offset - anchor.offset;
      settleEarlier();
    } else if (anchor && !chat.loadingEarlier) {
      settleEarlier(); // The request finished with nothing older to show.
    } else if (atBottom.current || forceBottom.current) {
      element.scrollTop = element.scrollHeight;
      atBottom.current = true;
      forceBottom.current = false;
    } else {
      const newest = messages.at(-1);
      if (newest && newestSeen.current !== null && newest.seq > newestSeen.current && !newest.fromMe) setJump(true);
    }
    newestSeen.current = messages.at(-1)?.seq ?? newestSeen.current;
    // Still waiting for the older page: re-measure, in case this update scrolled or reflowed the log.
    if (prepend.current) prepend.current.offset = offsetOf(prepend.current.firstSeq) ?? prepend.current.offset;
    maybeRead();
  }, [messages, outgoing.length, maybeRead, chat.loadingEarlier]);

  // A typing row appearing (or a receipt caption changing) at the bottom keeps the log at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [typistsKey, lastMineSeq, receipts]);

  // The keyboard opening or a banner appearing shrinks the log; stay at the bottom if we were there.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const pin = () => { if (atBottom.current) element.scrollTop = element.scrollHeight; };
    const observer = new ResizeObserver(pin);
    observer.observe(element);
    // A photo has no height until it loads, which would leave the log short of the bottom. `load` does not bubble, hence the capture.
    element.addEventListener('load', pin, true);
    return () => { observer.disconnect(); element.removeEventListener('load', pin, true); };
  }, []);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') maybeRead(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [maybeRead]);

  // A new outgoing message always scrolls into view.
  const outgoingCount = useRef(outgoing.length);
  useLayoutEffect(() => {
    if (outgoing.length > outgoingCount.current) toBottom();
    outgoingCount.current = outgoing.length;
  }, [outgoing.length]);

  const loadEarlier = async () => {
    const first = messages[0];
    if (!first) return;
    setEarlierError('');
    prepend.current = { firstSeq: first.seq, offset: offsetOf(first.seq) ?? 0 };
    setQuiet(true);
    // The layout effect restores the position and clears the anchor when the older page commits.
    try { await chat.loadEarlier(); } catch (err) { setEarlierError(errorMessage(err)); settleEarlier(); }
  };

  const addTask = async (message: ChatMessage) => {
    if (!message.body) return;
    setAdded((current) => ({ ...current, [message.seq]: 'saving' }));
    try {
      await state.saveTask(crypto.randomUUID(), { title: taskTitle(censorSlurs(message.body)), dueDate: null, dueTime: null, classId: null, notes: '', completed: false });
      setAdded((current) => ({ ...current, [message.seq]: 'added' }));
    } catch (err) {
      setAdded((current) => ({ ...current, [message.seq]: errorMessage(err) }));
    }
  };
  /** The message as shown (markup dropped, slurs censored) goes to the clipboard; "Copied." shows for a moment. */
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copy = async (message: ChatMessage) => {
    if (!message.body) return;
    try { await navigator.clipboard.writeText(censorSlurs(plainText(message.body))); } catch { return; }
    setCopied(message.seq);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1_500);
  };

  const react = async (seq: number, emoji: Reaction) => {
    setReactError(null);
    try { await chat.react(seq, emoji); } catch (err) { setReactError({ seq, text: errorMessage(err) }); }
  };
  const reply = (message: ChatMessage) => chat.setReply(quoteOf(message, name));
  /**
   * A tapped quote scrolls its target into view and pulses it. A target older than the loaded pages is fetched one
   * page at a time (up to JUMP_PAGES) until it appears or there is nothing older; each page commits before the next look.
   */
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  const jumpTo = async (seq: number, pages = JUMP_PAGES): Promise<boolean> => {
    const find = () => scroller.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`) ?? null;
    let row = find();
    for (let page = 0; !row && page < pages && latest.current.chat.hasEarlier && !latest.current.chat.loadingEarlier; page += 1) {
      await loadEarlier();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      row = find();
    }
    if (!row) return false;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(seq);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), 1_200);
    return true;
  };
  /**
   * Beta: the sender may rewrite their own message while the edit window is open. A room message a moderator has
   * edited stays as they left it. The window is checked against this device's clock here and by the server on save.
   */
  const canEditOwn = (message: ChatMessage) => polish && canReact && message.fromMe && message.body !== null && message.deletedBy === null
    && withinEditWindow(message.createdAt, Date.now()) && !(message.editedAt && !message.editedBySender);

  const empty = messages.length === 0 && outgoing.length === 0;
  const logLabel = mode === 'global' ? 'Global chat messages' : mode === 'school' ? `School chat messages, ${name}` : mode === 'group' ? `Messages in ${name}` : `Messages with ${name}`;
  return <div className="chat-wallpaper relative flex min-h-0 flex-1 flex-col">
    {polish && searching && <SearchPanel chat={chat} state={state} onClose={() => onSearchClose?.()} onPick={(seq) => jumpTo(seq, SEARCH_JUMP_PAGES)} />}
    {/* The side padding leaves room for the bubble tails, which hang 8 px past their bubble. */}
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2.5 py-3 lg:px-5"
      onScroll={() => { atBottom.current = nearBottom(); if (atBottom.current) { setJump(false); maybeRead(); } }}>
      {chat.hasEarlier && <div className="grid justify-items-center gap-2 pb-3">
        <Button size="sm" variant="ghost" busy={chat.loadingEarlier} disabled={!state.online} onClick={() => void loadEarlier()}>Load earlier messages</Button>
        {earlierError && <Hint tone="danger" role="alert">{earlierError}</Hint>}
      </div>}
      {empty && <div className="grid justify-items-center gap-2 px-4 py-10 text-center">
        <p className="text-[15px] font-bold">No messages yet.</p>
        {mode === 'global'
          ? <Hint className="max-w-[40ch] text-[13px]">Everyone on Quasar can read and post here. Swearing is fine; slurs get censored. Moderators can edit or remove any message.</Hint>
          : mode === 'school'
            ? <Hint className="max-w-[40ch] text-[13px]">Everyone at {name} can read and post here, and nobody from other schools. Swearing is fine; slurs get censored. Moderators can edit or remove any message.</Hint>
          : mode === 'group'
            ? <Hint className="max-w-[40ch] text-[13px]">Only the people in {name} can read this. New members see messages from when they joined. Support sees messages only if someone reports them.</Hint>
            : <Hint className="max-w-[40ch] text-[13px]">Only you and {name} can read this chat. Support sees messages only if one of you reports them.</Hint>}
      </div>}
      <ol role="log" aria-live={quiet ? 'off' : 'polite'} aria-label={logLabel} className="grid grid-cols-[minmax(0,1fr)]">
        {items.map((item) => {
          if (item.kind === 'time') return <li key={item.key} role="none" className="pt-4 pb-1 text-center text-[11.5px] leading-tight text-muted-foreground">{item.day && <strong className="font-semibold">{item.day} </strong>}{item.time}</li>;
          if (item.kind === 'unread') return <li key={item.key} role="none" className="flex items-center gap-2 py-2 text-[11.5px] font-bold text-primary"><span aria-hidden="true" className="h-px flex-1 bg-primary/40" />New messages<span aria-hidden="true" className="h-px flex-1 bg-primary/40" /></li>;
          const { message } = item;
          const status = message.fromMe && message.seq === lastMineSeq ? receiptStatus(message.seq, receiptsFor(message.createdAt, receipts), mode === 'group') : null;
          return <Bubble key={item.key} message={message} date={item.date} time={item.time} startsRun={item.startsRun} endsRun={item.endsRun} showName={item.showName} status={status} online={state.online} mode={mode} canModerate={canModerate}
            fresh={mountedNewest.current !== null && message.seq > mountedNewest.current && !(polish && message.fromMe)}
            open={openActions === message.seq} onOpenChange={(next) => setOpenActions((current) => (next ? message.seq : current === message.seq ? null : current))}
            added={added[message.seq]} copied={copied === message.seq} onAddTask={() => void addTask(message)} onCopy={() => void copy(message)} onDelete={() => onDelete(message)} onEdit={onEdit && (() => onEdit(message))} onReport={onReport && (() => onReport(message.seq))}
            onEditOwn={canEditOwn(message) ? () => chat.setEditing({ id: message.id, seq: message.seq, body: message.body ?? '', hasImage: !!message.image }) : undefined} editing={chat.editing?.seq === message.seq}
            highlighted={highlight === message.seq} canReact={canReact} reactError={reactError?.seq === message.seq ? reactError.text : ''} onReact={(emoji) => void react(message.seq, emoji)} onReply={canReact ? () => reply(message) : undefined} onJump={(target) => void jumpTo(target)} receipts={receipts} />;
        })}
      </ol>
      {/* Outside the live log: a sent message is announced once, when the log gains the confirmed copy. */}
      {outgoing.length > 0 && <ul aria-label="Unsent messages" className="grid grid-cols-[minmax(0,1fr)]">
        {outgoing.map((item) => <PendingBubble key={item.clientId} item={item} reply={item.reply && liveQuote(item.reply, messages, name)} online={state.online} onRetry={chat.retry} onDiscard={() => chat.discard(item.clientId)} />)}
      </ul>}
      {typists.length > 0 && <TypingRow typists={typists} withAvatar={named} />}
    </div>
    {jump && <Button variant="soft" icon="chevronDown" aria-label="Jump to new messages" className="absolute bottom-3 left-1/2 size-9 -translate-x-1/2 rounded-full shadow-float ring-1 ring-foreground/[0.06] hover:bg-primary-soft hover:text-primary-soft-foreground"
      onClick={() => { toBottom(true); maybeRead(); }}>
      {unreadBelow > 0 && <span aria-hidden="true" className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground tabular-nums">{unreadBelow > 99 ? '99+' : unreadBelow}</span>}
    </Button>}
  </div>;
}

/* ---------- Search inside a chat (chat-polish beta) ---------- */

/** A result's excerpt with the searched words in bold, wherever they appear. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let at = lower.indexOf(wanted); at >= 0; at = lower.indexOf(wanted, cursor)) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(<mark key={at} className="rounded-[3px] bg-primary/20 px-px font-semibold text-foreground">{text.slice(at, at + wanted.length)}</mark>);
    cursor = at + wanted.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * The search bar over the top of a thread and its results, newest first. Picking a result closes the list and jumps
 * to the message, loading older pages on the way; the query stays, so the list comes back with a tap in the field.
 * The server searches the stored (censored) text of the messages this viewer may see.
 */
function SearchPanel({ chat, state, onClose, onPick }: { chat: ChatThread; state: AppState; onClose: () => void; onPick: (seq: number) => Promise<boolean> }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searched, setSearched] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const [jumping, setJumping] = useState<number | null>(null);
  const listId = useId();
  const search = chat.search;
  const wanted = query.replace(/\s+/g, ' ').trim();
  const long = Array.from(wanted).length >= CHAT.searchMinLength;
  useEffect(() => {
    setError('');
    if (!long) { setResults(null); setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      search(wanted, controller.signal)
        .then((found) => { if (!controller.signal.aborted) { setResults(found); setSearched(wanted); setBusy(false); } })
        .catch((err) => { if (!controller.signal.aborted) { setError(errorMessage(err)); setBusy(false); } });
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [wanted, long, search]);
  const pick = async (hit: SearchHit) => {
    setJumping(hit.seq); setError('');
    const found = await onPick(hit.seq).catch(() => false);
    setJumping(null);
    if (found) setListOpen(false); else setError('That message is too far back to jump to.');
  };
  const showList = listOpen && long && (results !== null || !!error);
  return <div role="search" aria-label="Search messages" className="absolute inset-x-0 top-0 z-20 grid max-h-[70%] grid-rows-[auto_minmax(0,1fr)]"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div className={cn(BAR, 'flex items-center gap-2 border-b border-foreground/[0.07] py-2 max-lg:mx-0 lg:px-4')}>
      <span className="relative min-w-0 flex-1">
        <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus type="search" enterKeyHint="search" autoComplete="off" aria-label="Search this chat" aria-controls={showList ? listId : undefined} placeholder="Search this chat" maxLength={CHAT.searchMaxLength} disabled={!state.online}
          className="h-10 rounded-full pl-9" value={query} onChange={(event) => { setQuery(event.target.value); setListOpen(true); }} onFocus={() => setListOpen(true)} />
      </span>
      {busy && <Spinner />}
      <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
    </div>
    {showList && <div id={listId} className="min-h-0 overflow-y-auto overscroll-contain rounded-b-2xl bg-popover text-popover-foreground shadow-float ring-1 ring-foreground/[0.06]">
      {error && <Hint tone="danger" role="alert" className="px-4 py-3">{error}</Hint>}
      {results !== null && <p role="status" className="px-4 pt-2.5 pb-1 text-[12px] font-semibold text-muted-foreground">
        {results.length === 0 ? `Nothing matches “${searched}”.` : results.length >= CHAT.searchResults ? `The newest ${CHAT.searchResults} matches` : pluralize(results.length, 'match', 'matches')}
      </p>}
      {results !== null && results.length > 0 && <ul aria-label="Search results" className="grid px-1.5 pb-1.5">
        {results.map((hit) => <li key={hit.seq}>
          <button type="button" disabled={jumping !== null} onClick={() => void pick(hit)} className="grid w-full gap-0.5 rounded-xl px-2.5 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
            <span className="flex items-baseline gap-2 text-[12px] text-muted-foreground">
              <strong className="truncate font-semibold text-foreground/80">{hit.fromMe ? 'You' : hit.senderName}</strong>
              <span className="ml-auto shrink-0 tabular-nums">{chatTime(hit.createdAt, state.timeZone, state.now)}</span>
              {jumping === hit.seq && <Spinner />}
            </span>
            <span className="line-clamp-2 text-[14px] leading-snug [overflow-wrap:anywhere]"><Highlighted text={hit.preview} query={searched} /></span>
          </button>
        </li>)}
      </ul>}
    </div>}
  </div>;
}

/* ---------- Bubbles ---------- */

const BUBBLE = 'relative min-w-0 rounded-[18px] px-3.5 py-[7px] text-[15.5px] leading-[1.3] whitespace-pre-wrap break-words [overflow-wrap:anywhere]';
const MINE = 'bg-primary text-primary-foreground';
/** Theirs sit on the card colour, not muted: muted is the wallpaper's own tone and would sink into it. */
const THEIRS = 'bg-card text-foreground ring-1 ring-inset ring-foreground/[0.06]';
/**
 * In the chat-polish beta the other side's bubbles on dark themes are a solid step away from the page instead of the
 * card colour with a hairline: the tail has no hairline, so a card-coloured tail vanished into the dark wallpaper.
 * Light themes keep the white card, which already stands out; the grey fill was within 1.1:1 of the page there.
 */
const THEIRS_SOLID = 'bg-card text-foreground ring-1 ring-inset ring-foreground/[0.06] dark:bg-secondary dark:ring-0';
function useTheirs(): string {
  return useBeta(CHAT_POLISH) ? THEIRS_SOLID : THEIRS;
}

/**
 * The corners a bubble shares with its neighbours in a run are tightened to 5 px: for the viewer's bubbles the right
 * side, for everyone else's the left. The tail replaces the bottom corner on that side, so the last bubble keeps it open.
 */
function runCorners(mine: boolean, startsRun: boolean, endsRun: boolean): string {
  return cn(mine
    ? [!startsRun && 'rounded-tr-[5px]', !endsRun && 'rounded-br-[5px]']
    : [!startsRun && 'rounded-tl-[5px]', !endsRun && 'rounded-bl-[5px]']);
}

/**
 * The small tail under the last bubble of a run, on the sender's side. It leaves the bubble's straight edge just
 * above the corner, sweeps out to a point 6 px past the edge at the bottom, and returns into the corner's arc.
 */
function Tail({ mine, className }: { mine: boolean; className?: string }) {
  const solid = useBeta(CHAT_POLISH);
  return <svg aria-hidden="true" viewBox="0 0 16 16" className={cn('pointer-events-none absolute bottom-0 size-4', mine ? '-right-1.5 fill-primary' : cn('-left-1.5 -scale-x-100 fill-card', solid && 'dark:fill-secondary'), className)}>
    <path d="M7 0H10C10 7 11.5 12.5 16 16C11.5 16 7.5 14.5 4.7 10.7Z" />
  </svg>;
}

/** "Bob is typing…" as a bubble of bouncing dots at the end of the log (docs/CHAT.md §13). */
function TypingRow({ typists, withAvatar }: { typists: Receipt[]; withAvatar: boolean }) {
  const text = typingText(typists.map((typist) => typist.displayName));
  const first = typists[0]!;
  const theirs = useTheirs();
  return <div role="status" aria-live="polite" className="chat-bubble-in mt-2.5 flex items-end gap-2">
    {withAvatar && <MemberAvatar name={first.displayName} src={first.avatar} size="sm" />}
    <span className={cn(BUBBLE, theirs, 'flex items-center gap-1 py-3')} title={text}>
      {[0, 1, 2].map((dot) => <span key={dot} aria-hidden="true" className="size-2 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${dot * 150}ms` }} />)}
      <span className="sr-only">{text}</span>
      <Tail mine={false} />
    </span>
    {typists.length > 1 && <span aria-hidden="true" className="text-xs text-muted-foreground">{text}</span>}
  </div>;
}

/** The quote inside a reply bubble, the composer's strip and a pending bubble (docs/CHAT.md §15): sender and one line. */
function QuoteCard({ reply, mine, onClick }: { reply: MessageReply; mine: boolean; onClick?: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const text = reply.preview ?? 'Message unavailable';
  // In the chat-polish beta the quote is a plain tinted card: a 2 px side border on a rounded card bends into a crescent.
  const plain = useBeta(CHAT_POLISH);
  const className = cn('mb-1.5 block w-full min-w-40 rounded-xl px-2.5 py-1.5 text-left outline-none', !plain && 'border-l-2',
    mine ? cn('bg-primary-foreground/15', !plain && 'border-primary-foreground/70') : cn(plain ? 'bg-foreground/[0.08]' : 'border-primary bg-foreground/[0.06]'), onClick && 'focus-visible:ring-2 focus-visible:ring-ring');
  const body = <>
    <span className={cn('block text-[12px] font-semibold leading-tight', mine ? 'text-primary-foreground/90' : 'text-primary')}>{quoteName(reply)}</span>
    <span className={cn('block truncate text-[13px] leading-snug', mine ? 'text-primary-foreground/85' : 'text-foreground/80', reply.preview === null && 'italic')}>{text}</span>
  </>;
  return onClick
    ? <button type="button" aria-label={`Quoted ${quoteName(reply)}: ${text}`} onClick={onClick} className={className}>{body}</button>
    : <span aria-label={`Quoted ${quoteName(reply)}: ${text}`} role="note" className={className}>{body}</span>;
}

/**
 * A message's action sheet (docs/CHAT.md §7, §15): the tapback strip, then the rows a message offers, in a popover
 * anchored to its bubble. The rows are buttons with their long-standing accessible names ("Add as task", "Report
 * message", "Edit message", "Delete message" / "Remove message"), plus "Reply to message" and "Copy". They are menu
 * rows, so unlike page buttons they carry no outline.
 */
function MessageActionSheet({ mine, online, canModerate, canReact, reacted, added, hasText = true, polish = false, onReact, onReply, onAddTask, onCopy, onDelete, onEdit, onEditOwn, onReport }: {
  mine: boolean; online: boolean; canModerate: boolean; canReact: boolean; reacted: Reaction | null; added: 'saving' | 'added' | string | undefined;
  /** False for a photo with no caption: "Add as task" and "Copy" have nothing to work on, so they are left out. */
  hasText?: boolean;
  /** Beta: a "More reactions" button opens the rest of REACTIONS under the strip. */
  polish?: boolean;
  /** `onEditOwn` is the sender rewriting their own message in the composer (beta); `onEdit` is a room moderator's edit, with a reason. */
  onReact: (emoji: Reaction) => void; onReply?: () => void; onAddTask: () => void; onCopy: () => void; onDelete: () => void; onEdit?: () => void; onEditOwn?: () => void; onReport?: () => void;
}) {
  const removeLabel = mine ? 'Delete message' : 'Remove message';
  const row = 'h-10 w-full justify-start gap-2.5 rounded-xl px-2.5 text-[14px] font-medium hover:bg-muted [&_svg]:text-muted-foreground';
  /** Open from the start when the viewer's own reaction is one of the extra ones, so they can see it and take it off. */
  const [more, setMore] = useState(() => polish && reacted !== null && !QUICK_REACTIONS.includes(reacted));
  const toggle = cn('rounded-full p-0 leading-none transition-[background-color,transform] hover:bg-muted active:scale-95 aria-pressed:bg-primary-soft aria-pressed:ring-1 aria-pressed:ring-primary/40 data-[state=on]:bg-primary-soft', polish ? 'size-9 min-w-9 text-[20px]' : 'size-10 min-w-10 text-[21px]');
  const reaction = (emoji: Reaction) => <Toggle key={emoji} pressed={reacted === emoji} disabled={!canReact} aria-label={reactionToggleLabel(emoji)} onPressedChange={() => onReact(emoji)} className={toggle}>{emoji}</Toggle>;
  return <>
    <div role="group" aria-label="React" className="mb-1 border-b border-foreground/[0.06] px-0.5 pb-1.5">
      <div className="flex justify-between gap-0.5">
        {QUICK_REACTIONS.map(reaction)}
        {polish && <Toggle pressed={more} disabled={!canReact} aria-label="More reactions" aria-expanded={more} onPressedChange={setMore} className={cn(toggle, 'text-muted-foreground')}><Icon name="plus" size={18} /></Toggle>}
      </div>
      {more && <div role="group" aria-label="More reactions" className="mt-1 grid grid-cols-7 justify-items-center gap-y-0.5">{REACTIONS.slice(QUICK_REACTIONS.length).map(reaction)}</div>}
    </div>
    <div className="grid">
      {onReply && <MenuRow variant="ghost" className={row} aria-label="Reply to message" onClick={onReply}><Icon name="reply" />Reply</MenuRow>}
      {!mine && hasText && <MenuRow variant="ghost" className={row} disabled={added === 'saving'} onClick={onAddTask}>{added === 'saving' ? <Spinner /> : <Icon name="tasks" />}Add as task</MenuRow>}
      {hasText && <MenuRow variant="ghost" className={row} onClick={onCopy}><Icon name="copy" />Copy</MenuRow>}
      {onEditOwn
        ? <MenuRow variant="ghost" className={row} aria-label="Edit message" disabled={!online} onClick={onEditOwn}><Icon name="edit" />Edit</MenuRow>
        : canModerate && onEdit && <MenuRow variant="ghost" className={row} aria-label="Edit message" disabled={!online} onClick={onEdit}><Icon name="edit" />Edit</MenuRow>}
      {!mine && onReport && <MenuRow variant="ghost" className={row} disabled={!online} onClick={onReport}><Icon name="flag" />Report message</MenuRow>}
      {(mine || canModerate) && <MenuRow variant="ghost" className={cn(row, 'text-destructive hover:bg-destructive/10 hover:text-destructive [&_svg]:text-destructive')} aria-label={removeLabel} disabled={!online} onClick={onDelete}><Icon name="trash" />{mine ? 'Delete' : 'Remove'}</MenuRow>}
    </div>
  </>;
}

/** The pointer that is down on a bubble: its long-press timer, where it started, and what the gesture has become. */
type Press = { timer: ReturnType<typeof setTimeout> | null; x: number; y: number; touch: boolean; fired: boolean; swipe: 'idle' | 'active' | 'cancel'; offset: number };

const stopEvent = (event: { stopPropagation: () => void }) => event.stopPropagation();

const PILL = (mine: boolean) => cn('flex h-6 items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 text-[12px] leading-none shadow-sm ring-1 outline-none transition-colors select-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default', mine ? 'bg-primary-soft text-primary-soft-foreground ring-primary/40' : 'bg-card text-foreground ring-foreground/10 hover:bg-muted');

/**
 * Who reacted to a message (chat-polish beta), one row a person in the order they reacted. The viewer's row is a
 * button that takes their tapback off. Names the server left out (a list past its cap, someone the viewer blocked)
 * are summed up in a last line, so the rows and the pills' counts still add up.
 */
function ReactorList({ reactions, reactors, canReact, onRemove }: { reactions: ChatMessage['reactions']; reactors: MessageReactor[]; canReact: boolean; onRemove: (emoji: Reaction) => void }) {
  const total = reactions.reduce((sum, reaction) => sum + reaction.count, 0);
  const hidden = Math.max(0, total - reactors.length);
  const row = 'flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2 py-1 text-left text-[14px]';
  return <ul className="grid max-h-64 overflow-y-auto">
    {reactors.map((reactor, index) => {
      const body = <>
        <MemberAvatar name={reactor.name} src={reactor.avatar} size="sm" />
        <span className="grid min-w-0 flex-1">
          <span className="truncate font-medium">{reactor.me ? 'You' : reactor.name}</span>
          {reactor.me && canReact && <span className="text-[12px] leading-tight text-muted-foreground">Tap to remove</span>}
        </span>
        <span aria-hidden="true" className="text-[17px] leading-none">{reactor.emoji}</span>
        <span className="sr-only">{REACTION_NAMES[reactor.emoji]}</span>
      </>;
      return <li key={index}>
        {reactor.me && canReact
          ? <button type="button" aria-label={`You, ${REACTION_NAMES[reactor.emoji]}. Remove your reaction`} onClick={() => onRemove(reactor.emoji)} className={cn(row, 'outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring')}>{body}</button>
          : <div className={row}>{body}</div>}
      </li>;
    })}
    {hidden > 0 && <li className="px-2 py-1.5 text-[12px] text-muted-foreground">{reactors.length ? `and ${hidden} more` : pluralize(hidden, 'reaction')}</li>}
  </ul>;
}

/** Who read, who received and who is still waiting for one of the viewer's group messages (chat-polish beta). */
function ReaderList({ seq, receipts }: { seq: number; receipts: Receipt[] }) {
  const groups = receiptGroups(seq, receipts);
  const sections: Array<[string, Receipt[]]> = [['Read', groups.read], ['Delivered', groups.delivered], ['Not delivered yet', groups.waiting]];
  return <div className="grid max-h-72 gap-1.5 overflow-y-auto">
    {sections.filter(([, people]) => people.length > 0).map(([title, people]) => <section key={title} aria-label={title}>
      <h3 className="px-2 pt-1 pb-0.5 text-[11px] font-bold tracking-[0.08em] text-muted-foreground uppercase">{title}</h3>
      <ul className="grid">
        {people.map((person) => <li key={person.id} className="flex min-h-9 items-center gap-2.5 px-2 py-1 text-[14px]">
          <MemberAvatar name={person.displayName} src={person.avatar} size="sm" /><span className="truncate font-medium">{person.displayName}</span>
        </li>)}
      </ul>
    </section>)}
  </div>;
}

function Bubble({ message, date, time, startsRun, endsRun, showName, status, online, mode, canModerate, fresh, open, onOpenChange, added, copied, onAddTask, onCopy, onDelete, onEdit, onEditOwn, editing = false, onReport, highlighted, canReact, reactError, onReact, onReply, onJump, receipts }: {
  message: ChatMessage; date: string; time: string; startsRun: boolean; endsRun: boolean; showName: boolean; status: ReturnType<typeof receiptStatus>; online: boolean; mode: Mode; canModerate: boolean; fresh: boolean;
  open: boolean; onOpenChange: (open: boolean) => void; added: 'saving' | 'added' | string | undefined; copied: boolean; onAddTask: () => void; onCopy: () => void; onDelete: () => void; onEdit?: () => void; onReport?: () => void;
  /** Beta: the sender may still rewrite this message (`onEditOwn`), and the composer is rewriting it right now (`editing`). */
  onEditOwn?: () => void; editing?: boolean;
  highlighted: boolean; canReact: boolean; reactError: string; onReact: (emoji: Reaction) => void; onReply?: () => void; onJump: (seq: number) => void; receipts: Receipt[];
}) {
  const mine = message.fromMe;
  const polish = useBeta(CHAT_POLISH);
  const theirs = useTheirs();
  const removed = message.body === null || message.deletedBy !== null;
  const { edited, own, reason } = moderation(message);
  /** What the viewer's tier may read of a removed message, and of an edited one before the edit (src/server/moderation.ts). */
  const kept = message.removed ?? null;
  const before = 'editedFrom' in message ? message.editedFrom : null;
  const [showBefore, setShowBefore] = useState(false);
  const name = senderName(message);
  const withAvatar = mode !== 'peer' && !mine;
  const sheetId = useId();
  const reacted = message.reactions.find((reaction) => reaction.mine)?.emoji ?? null;
  /**
   * The "Message actions" button is a plain button, not a PopoverTrigger: Radix registers a trigger as the popper
   * anchor before the custom PopoverAnchor's effect runs, then remounts the trigger, so the popover would measure
   * a detached node and land at the viewport's corner. The button toggles the sheet and gets focus back on close.
   */
  const trigger = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  /** A tap on the bubble shows (or hides) its own time, as in iMessage; two quick taps toggle a heart instead. */
  const [stamp, setStamp] = useState(false);
  const lastTap = useRef(0);
  /** How far a touch has dragged the bubble to the right (swipe to reply), 0 at rest. */
  const [swipe, setSwipe] = useState(0);
  /**
   * Opening the actions: a long press (any pointer; cancelled by movement, so a scroll never opens it), a right-click,
   * or the "Message actions" button, which stays in the DOM for keyboards and screen readers and shows on hover or
   * focus. A press that fired (or a swipe) swallows the click that follows it, so it does not also toggle the time.
   * A touch that drags right past the dead zone becomes a swipe to reply; `touch-action: pan-y` on the bubble leaves
   * vertical panning to the scroller, which cancels the pointer, and takes double-tap zoom out of the browser's hands.
   */
  const press = useRef<Press>({ timer: null, x: 0, y: 0, touch: false, fired: false, swipe: 'idle', offset: 0 });
  const cancelPress = () => { if (press.current.timer) { clearTimeout(press.current.timer); press.current.timer = null; } };
  useEffect(() => cancelPress, []);
  const endSwipe = (release: boolean) => {
    if (press.current.swipe !== 'active') return;
    press.current.swipe = 'idle';
    press.current.fired = true;
    setSwipe(0);
    if (release && swipeReplies(press.current.offset)) onReply?.();
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (removed || event.button !== 0 || (event.target as HTMLElement).closest('a')) return;
    cancelPress();
    press.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch', fired: false, swipe: 'idle', offset: 0, timer: setTimeout(() => { press.current.timer = null; press.current.fired = true; onOpenChange(true); }, LONG_PRESS_MS) };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (current.timer && Math.hypot(dx, dy) > LONG_PRESS_SLOP) cancelPress();
    if (!current.touch || !onReply || current.swipe === 'cancel') return;
    const offset = swipeOffset(dx, dy);
    if (offset === 'pending') return;
    if (offset === 'cancel') { current.swipe = 'cancel'; setSwipe(0); return; }
    current.swipe = 'active';
    current.offset = offset;
    setSwipe(offset);
  };
  const onPointerUp = () => { cancelPress(); endSwipe(true); };
  const onPointerCancel = () => { cancelPress(); endSwipe(false); };
  const tap = (event: MouseEvent<HTMLDivElement>) => {
    if (press.current.fired) { press.current.fired = false; return; }
    if (removed || (event.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      setStamp((current) => !current); // Undo the first tap's toggle: a double tap is a heart, not a time.
      // Beta: a double tap only ever adds a heart; it never takes one off or swaps out another tapback.
      if (canReact && (!polish || reacted === null)) onReact('❤️');
      return;
    }
    lastTap.current = now;
    setStamp((current) => !current);
  };
  const contextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (removed || (event.target as HTMLElement).closest('a')) return;
    event.preventDefault();
    cancelPress();
    onOpenChange(true);
  };
  const quoteTap = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (press.current.fired) { press.current.fired = false; return; }
    if (message.replyTo) onJump(message.replyTo.seq);
  };
  /**
   * Where focus goes when the sheet closes, decided before Radix's close autofocus runs: 'trigger' hands it back to
   * the "Message actions" button (Escape, a press on a plain surface outside, the button's own toggle, and picks
   * like a tapback or Copy that move focus nowhere, so a keyboard user keeps their place); 'elsewhere' leaves it
   * where the user or the action put it (the composer after Reply or a tap into the field, a dialog the action
   * opened). Null (another bubble's sheet opened, say) also leaves it alone.
   */
  const closeFocus = useRef<'trigger' | 'elsewhere' | null>(null);
  const pick = (action: () => void, focus: 'trigger' | 'elsewhere' = 'trigger') => () => { closeFocus.current = focus; onOpenChange(false); action(); };
  const label = mode !== 'peer' && !mine ? `${name}: ` : '';
  const by = moderation(message).by;
  const editNote = edited ? (own ? 'Edited' : reason ? `Edited by ${by}: ${reason}` : `Edited by ${by}`) : '';
  const addError = !mine && added && added !== 'added' && added !== 'saving' ? added : '';
  /** In the beta, the time a tap shows on any of the viewer's messages comes with who has read that one, not only the newest. */
  const eligible = receiptsFor(message.createdAt, receipts);
  const receipt = status ?? (polish && stamp && mine && !removed && (mode === 'peer' || mode === 'group') && eligible.length ? receiptStatus(message.seq, eligible, mode === 'group') : null);
  const [readers, setReaders] = useState(false);
  const readersButton = useRef<HTMLButtonElement>(null);
  /** The list of who reacted, opened from the pills (beta). */
  const [who, setWho] = useState(false);
  const pills = useRef<HTMLSpanElement>(null);
  /** The pill that opened the list, which gets focus back when it closes. */
  const opener = useRef<HTMLButtonElement | null>(null);
  const reactors: MessageReactor[] = message.reactors ?? [];
  const caption = stamp || editNote || before || receipt || added === 'added' || addError || copied || reactError;
  const reacted_ = message.reactions.length > 0;
  return <li data-seq={message.seq} data-highlighted={highlighted || undefined} className={cn('group/msg flex', mine ? 'justify-end' : 'justify-start', startsRun ? 'mt-2.5' : 'mt-0.5', reacted_ && 'pb-3', fresh && 'chat-bubble-in')}>
    {/* In a room or group, the sender's picture sits beside the last bubble of their run; the others keep the space. */}
    {withAvatar && <span className="mr-2 w-7 shrink-0 self-end">{endsRun && <MemberAvatar name={name} src={senderAvatar(message)} size="sm" />}</span>}
    <div className={cn('flex min-w-0 flex-1 flex-col', mine ? 'items-end' : 'items-start')}>
      {showName && <span className="mb-0.5 px-2 text-[12px] font-semibold text-muted-foreground">{name}{'sender' in message && message.sender.verified && <><Icon name="checkCircle" size={12} className="ml-1 inline-block align-[-1px] text-success" /><span className="sr-only"> (verified)</span></>}{'sender' in message && 'staff' in message.sender && message.sender.staff && <StaffBadge rank={message.sender.staff} />}</span>}
      {removed
        ? <div title={formatDateTime(date, time)} className={cn(BUBBLE, 'max-w-[80%] border border-dashed border-foreground/20 bg-transparent text-muted-foreground lg:max-w-[75%]', kept ? 'grid gap-1.5' : 'italic')}>
          {label && <span className="sr-only">{label}</span>}
          {kept ? <>
            <span className="text-[12px] italic">{removedText(message)}</span>
            {kept.image && <MessageImage src={kept.image} />}
            {kept.body && <div className="text-foreground"><MessageText text={kept.body} original={kept.original} mine={false} /></div>}
          </> : removedText(message)}
        </div>
        : <Popover open={open} onOpenChange={onOpenChange} modal={false}>
          {/* The button sits beside the bubble (flex-row-reverse puts it on the inside for the viewer's own bubbles). */}
          <div className={cn('flex max-w-[calc(80%+2rem)] items-center gap-1 lg:max-w-[calc(75%+2rem)]', mine && 'flex-row-reverse')}>
            <PopoverAnchor asChild>
              <div ref={bubble} title={formatDateTime(date, time)} onClick={tap} onContextMenu={contextMenu} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onPointerLeave={onPointerCancel}
                style={swipe ? { transform: `translateX(${swipe}px)` } : undefined}
                className={cn(BUBBLE, 'chat-bubble min-w-0 touch-pan-y', mine ? MINE : theirs, runCorners(mine, startsRun, endsRun), swipe === 0 && 'transition-transform duration-150', (open || editing) && 'ring-2 ring-ring ring-offset-2 ring-offset-background', highlighted && 'chat-highlight')}>
                {label && <span className="sr-only">{label}</span>}
                {message.replyTo && <QuoteCard reply={message.replyTo} mine={mine} onClick={quoteTap} />}
                {message.image && <MessageImage src={message.image} />}
                <MessageText text={message.body ?? ''} original={message.original} mine={mine} mentions={polish ? message.mentions : null} />
                {endsRun && <Tail mine={mine} />}
                {swipe > 0 && <span aria-hidden="true" style={{ opacity: swipeProgress(swipe) }} className="absolute top-1/2 -left-9 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-muted text-muted-foreground ring-1 ring-foreground/[0.06]"><Icon name="reply" size={15} /></span>}
                {/* Tapbacks hang off the bottom corner opposite the tail, like iMessage. The list item's bottom padding keeps the next run clear. */}
                {reacted_ && <span className={cn('absolute -bottom-3 flex gap-0.5', mine ? 'left-1.5' : 'right-1.5')} onPointerDown={stopEvent} onPointerMove={polish ? stopEvent : undefined} onPointerUp={polish ? stopEvent : undefined} onClick={stopEvent} onContextMenu={stopEvent}>
                  {polish
                    /* Beta: a pill opens the list of who reacted, where the viewer's own row takes their tapback off. Reacting stays on the sheet and the double tap. */
                    ? <Popover open={who} onOpenChange={setWho}>
                      <PopoverAnchor asChild>
                        <span ref={pills} className="flex gap-0.5">
                          {message.reactions.map((reaction) => <button key={reaction.emoji} type="button" aria-label={reactionWhoLabel(reaction, reactors)} title={reactorNames(reaction, reactors) || undefined} aria-haspopup="dialog" aria-expanded={who} onClick={(event) => { opener.current = event.currentTarget; setWho((current) => !current); }}
                            className={cn(PILL(reaction.mine), 'relative before:absolute before:-inset-x-0.5 before:-inset-y-2 before:content-[\'\']')}>
                            <span aria-hidden="true">{reaction.emoji}</span>{reaction.count > 1 && <span aria-hidden="true" className="font-semibold tabular-nums">{reaction.count}</span>}
                          </button>)}
                        </span>
                      </PopoverAnchor>
                      <PopoverContent side="bottom" align={mine ? 'start' : 'end'} sideOffset={6} collisionPadding={12} aria-label="Reactions" className="w-64 rounded-2xl p-1.5 whitespace-normal shadow-float"
                        onInteractOutside={(event) => { if (pills.current?.contains(event.target as Node)) event.preventDefault(); }}
                        onCloseAutoFocus={(event) => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }}>
                        <ReactorList reactions={message.reactions} reactors={reactors} canReact={canReact} onRemove={(emoji) => { setWho(false); onReact(emoji); }} />
                      </PopoverContent>
                    </Popover>
                    : message.reactions.map((reaction) => <button key={reaction.emoji} type="button" aria-label={reactionLabel(reaction)} aria-pressed={reaction.mine} disabled={!canReact} onClick={() => onReact(reaction.emoji)}
                      className={PILL(reaction.mine)}>
                      <span aria-hidden="true">{reaction.emoji}</span>{reaction.count > 1 && <span aria-hidden="true" className="font-semibold tabular-nums">{reaction.count}</span>}
                    </button>)}
                </span>}
              </div>
            </PopoverAnchor>
            <IconButton ref={trigger} label="Message actions" icon="more" size="sm" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? sheetId : undefined} onClick={() => { closeFocus.current = 'trigger'; onOpenChange(!open); }}
              className={cn('shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 aria-expanded:opacity-100 group-hover/msg:opacity-100',
                // Beta: touch screens open the actions with a long press, so the button gives its 44 px back to the bubble and stays for screen readers.
                polish && 'pointer-coarse:sr-only')} />
          </div>
          <PopoverContent id={sheetId} portal={false} side="bottom" align={mine ? 'end' : 'start'} sideOffset={6} collisionPadding={12} aria-label="Message actions" className={cn('rounded-2xl p-1.5 shadow-float', polish ? 'w-[18.5rem]' : 'w-[17rem]')}
            onEscapeKeyDown={() => { closeFocus.current = 'trigger'; }}
            onInteractOutside={(event) => {
              const target = event.target as Node;
              if (trigger.current?.contains(target)) { event.preventDefault(); return; } // The button's own click toggles the sheet.
              if (bubble.current?.contains(target)) press.current.fired = true; // A tap on the bubble only closes it; no time toggle.
              // A press (or a focus move) onto something focusable is the user placing focus; taking it back would close their keyboard.
              closeFocus.current = outsideRestoresFocus(target as Element) ? 'trigger' : 'elsewhere';
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (closeFocus.current === 'trigger') trigger.current?.focus({ preventScroll: true });
              closeFocus.current = null;
            }}>
            <MessageActionSheet mine={mine} online={online} canModerate={canModerate} canReact={canReact} reacted={reacted} added={added} hasText={!polish || !!message.body} polish={polish} onEditOwn={onEditOwn && pick(onEditOwn, 'elsewhere')}
              onReact={(emoji) => pick(() => onReact(emoji))()} onReply={onReply && pick(onReply, 'elsewhere')}
              onAddTask={pick(onAddTask)} onCopy={pick(onCopy)} onDelete={pick(onDelete, 'elsewhere')} onEdit={onEdit && pick(onEdit, 'elsewhere')} onReport={onReport && pick(onReport, 'elsewhere')} />
          </PopoverContent>
        </Popover>}
      {caption && <span className={cn('flex flex-wrap items-center gap-1 px-1.5 text-[12px] text-muted-foreground', reacted_ ? 'mt-2.5' : 'mt-0.5', mine && 'justify-end text-right')}>
        {stamp && <span>{formatTime(time)}</span>}
        {editNote && <span>{stamp && '· '}{editNote}</span>}
        {before && <button type="button" aria-expanded={showBefore} onClick={() => setShowBefore((current) => !current)} className="rounded-sm font-semibold text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{showBefore ? 'Hide original' : 'See original'}</button>}
        {receipt && (polish && mode === 'group'
          /* Beta: a group's "Read by 3" opens the list of who read it, who only received it and who has not yet. */
          ? <Popover open={readers} onOpenChange={setReaders}>
            <PopoverAnchor asChild>
              <button ref={readersButton} type="button" aria-haspopup="dialog" aria-expanded={readers} aria-label={`${receipt.label}. Show who`} onClick={() => setReaders((current) => !current)}
                className="relative -mx-1 flex items-center gap-1 rounded-md px-1 outline-none before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[''] hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring">
                <Icon name={receipt.icon} size={13} className={receipt.read ? 'text-primary' : undefined} /><span className={cn(receipt.read && 'font-semibold text-primary')}>{receipt.label}</span>
              </button>
            </PopoverAnchor>
            <PopoverContent side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label="Read by" className="w-60 rounded-2xl p-1.5 text-left text-foreground shadow-float"
              onInteractOutside={(event) => { if (readersButton.current?.contains(event.target as Node)) event.preventDefault(); }}
              onCloseAutoFocus={(event) => { event.preventDefault(); readersButton.current?.focus({ preventScroll: true }); }}>
              <ReaderList seq={message.seq} receipts={eligible} />
            </PopoverContent>
          </Popover>
          : <><Icon name={receipt.icon} size={13} className={receipt.read ? 'text-primary' : undefined} /><span className={cn(receipt.read && 'font-semibold text-primary')}>{receipt.label}</span></>)}
        {added === 'added' && <span role="status" className="text-success">Added to Tasks.</span>}
        {addError && <span role="alert" className="text-destructive">{addError}</span>}
        {reactError && <span role="alert" className="text-destructive">{reactError}</span>}
        {copied && <span role="status">Copied.</span>}
      </span>}
      {before && showBefore && <div className={cn(BUBBLE, 'mt-1 grid max-w-[80%] gap-1.5 border border-dashed border-foreground/20 bg-transparent lg:max-w-[75%]')}>
        <span className="text-[12px] italic text-muted-foreground">Before the edit</span>
        <MessageText text={before.body} original={before.original} mine={false} />
      </div>}
    </div>
  </li>;
}

/** `reply` is the quote as the live log shows it now (liveQuote), not the snapshot the send carries; a retry still sends the seq. */
function PendingBubble({ item, reply, online, onRetry, onDiscard }: { item: Outgoing; reply: MessageReply | null; online: boolean; onRetry: () => void; onDiscard: () => void }) {
  const failed = item.status === 'failed';
  return <li className="chat-bubble-in mt-2.5 flex flex-col items-end">
    <div className={cn(BUBBLE, MINE, 'max-w-[80%] lg:max-w-[75%]', !failed && 'opacity-60', failed && 'ring-2 ring-destructive ring-offset-2 ring-offset-background')}>
      {reply && <QuoteCard reply={reply} mine />}
      {item.image && <MessageImage src={imageDataUrl(item.image)} />}
      {/* Censored here as the server will store it, so the pending bubble never shows the slur while the send is out. */}
      <MessageText text={censorBody(item.body)} mine /><Tail mine />
    </div>
    {failed
      ? <div className="mt-1.5 grid justify-items-end gap-1.5">
        <Hint tone="danger" role="alert" className="text-right">Not sent.{item.error ? ` ${item.error}` : ''}</Hint>
        <div className="flex gap-1.5">
          {item.retryable && <Button size="sm" icon="refresh" aria-label="Retry sending" disabled={!online} onClick={onRetry}>Retry</Button>}
          <Button size="sm" variant="ghost" onClick={onDiscard}>Discard</Button>
        </div>
      </div>
      : <span className="mt-0.5 flex items-center gap-1 px-1.5 text-[12px] text-muted-foreground"><Icon name="clock" size={12} />Sending…</span>}
  </li>;
}

/* ---------- Composer ---------- */

const FORMATS: Array<{ marker: string; label: string; icon: IconName; key: string; shift?: boolean }> = [
  { marker: '**', label: 'Bold', icon: 'bold', key: 'b' },
  { marker: '_', label: 'Italic', icon: 'italic', key: 'i' },
  { marker: '~~', label: 'Strikethrough', icon: 'strikethrough', key: 'x', shift: true },
  { marker: '`', label: 'Code', icon: 'code', key: 'e' },
];

/**
 * Wraps the textarea's selection in a markdown marker (or unwraps it when it already is), returning the new text and
 * where the selection should land. With nothing selected the markers are inserted with the caret between them.
 */
export function wrapSelection(value: string, start: number, end: number, marker: string): { value: string; start: number; end: number } {
  const before = value.slice(0, start), selected = value.slice(start, end), after = value.slice(end);
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return { value: before.slice(0, -marker.length) + selected + after.slice(marker.length), start: start - marker.length, end: end - marker.length };
  }
  return { value: before + marker + selected + marker + after, start: start + marker.length, end: end + marker.length };
}

/** A message's photo: a thumbnail in the bubble that opens full size. */
function MessageImage({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  /** Beta: a photo that will not load (deleted meanwhile, access taken away, offline) says so instead of showing the browser's broken image. */
  const polish = useBeta(CHAT_POLISH);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (polish && failed) return <span className="flex items-center gap-1.5 py-1 text-[13px] italic opacity-80"><Icon name="alert" size={14} />Photo unavailable</span>;
  return <>
    <button type="button" aria-label="View image" className="block max-w-full rounded-lg focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => { event.stopPropagation(); setOpen(true); }} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}>
      <img src={src} alt="Message attachment" loading="lazy" onError={() => setFailed(true)} className="max-h-72 max-w-full rounded-lg object-contain" />
    </button>
    <Modal open={open} onClose={() => setOpen(false)} title="Image">
      {open && <img src={src} alt="Message attachment, full size" className="max-h-[75dvh] w-full object-contain" />}
    </Modal>
  </>;
}

/** Someone the composer's "@" picker can offer: a group's members, or the people who have posted in a room lately. */
type Mentionable = { id: string; displayName: string; avatar: string | null };

/** The people who posted in the loaded part of a room, newest first, without the viewer: the room's "@" suggestions. */
function recentSenders(messages: ChatMessage[], me: string): Mentionable[] {
  const seen = new Map<string, Mentionable>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!('sender' in message) || message.sender.id === me || seen.has(message.sender.id)) continue;
    seen.set(message.sender.id, { id: message.sender.id, displayName: message.sender.displayName, avatar: message.sender.avatar });
  }
  return [...seen.values()];
}

/**
 * `filtered` shows the slur notice (every chat has the filter): the draft still sends, and the server stores it with
 * the slur censored. `people` (groups and rooms, chat-polish beta) are who typing "@" can mention.
 */
function Composer({ chat, name, online, filtered = false, people }: { chat: ChatThread; name: string; online: boolean; filtered?: boolean; people?: Mentionable[] }) {
  const [draft, setDraft] = useState(chat.initialDraft);
  /** The images the next Send carries, as bare base64. Outside the beta there is never more than one. */
  const [images, setImages] = useState<string[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const polish = useBeta(CHAT_POLISH);
  /** Counts picks, so when a second image arrives while the first is still being resized only the newest one lands (outside the beta). */
  const picks = useRef(0);
  /** Beta: how many images are held or still being prepared, so a burst of picks cannot pass CHAT.imagesPerSend. */
  const held = useRef(0);
  const preparing = useRef(0);
  const addImages = async (files: File[]) => {
    if (!files.length) return;
    setImageError('');
    if (!polish) {
      const ticket = picks.current += 1;
      const current = () => mounted.current && ticket === picks.current;
      setImageBusy(true);
      try {
        const prepared = await chatImage(files[0]!);
        if (current()) { setImages([prepared]); held.current = 1; }
      } catch (error) { if (current()) setImageError(error instanceof Error ? error.message : 'This image could not be opened.'); }
      finally { if (current()) setImageBusy(false); }
      return;
    }
    const take = files.slice(0, Math.max(0, CHAT.imagesPerSend - held.current - preparing.current));
    if (take.length < files.length) setImageError(`You can send up to ${CHAT.imagesPerSend} images at once.`);
    if (!take.length) return;
    preparing.current += take.length;
    setImageBusy(true);
    for (const file of take) {
      try {
        // A GIF goes up whole, so the server can keep it moving.
        const prepared = await chatImage(file, true);
        if (mounted.current) { held.current += 1; setImages((current) => [...current, prepared]); }
      } catch (error) { if (mounted.current) setImageError(error instanceof Error ? error.message : 'This image could not be opened.'); }
      finally { preparing.current -= 1; }
    }
    if (mounted.current && preparing.current === 0) setImageBusy(false);
  };
  const removeImage = (index: number) => { held.current = Math.max(0, held.current - 1); setImages((current) => current.filter((_, at) => at !== index)); };
  const clearImages = () => { held.current = 0; setImages([]); };
  const imagesFull = polish ? images.length >= CHAT.imagesPerSend : imageBusy;
  /** A file is being dragged over the window (beta): the composer says it will take it. */
  const [dropping, setDropping] = useState(false);
  const pick = useRef(addImages);
  useEffect(() => { pick.current = addImages; });
  /** The viewer's own message being rewritten here (beta), or null. While it is, the field holds that message's text. */
  const editing = chat.editing;
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  /**
   * Beta: an image dropped anywhere on the window attaches to this thread's composer, as the "+" button would. The
   * listeners sit on the window so a drop on the log counts too, and so a missed drop never navigates the tab to the file.
   */
  const editingNow = !!editing;
  useEffect(() => {
    if (!polish) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent) => { if (!carriesFiles(event)) return; depth += 1; setDropping(true); };
    const leave = (event: DragEvent) => { if (!carriesFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) setDropping(false); };
    const over = (event: DragEvent) => { if (carriesFiles(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDropping(false);
      const files = imageFilesFrom(event.dataTransfer);
      if (!online) setImageError('You’re offline. Connect to send an image.');
      else if (editingNow) setImageError('Finish editing your message first.');
      else if (files.length) void pick.current(files); else setImageError('Only images can be sent here.');
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave); window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); setDropping(false); };
  }, [polish, online, editingNow]);
  /**
   * Beta: pasting copied images (a screenshot, "Copy image" on a web page) attaches them. A paste that also carries
   * plain text stays a text paste: spreadsheets and word processors put a picture of the copied cells beside the text.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!polish || editing) return;
    const files = imageFilesFrom(event.clipboardData);
    if (!files.length || event.clipboardData.getData('text/plain')) return;
    event.preventDefault();
    void addImages(files);
  };
  /** The "Aa" button pins the formatting toolbar open for keyboard and touch users who cannot select text first. */
  const [tools, setTools] = useState(false);
  /** Where the field's selected text is, for the floating toolbar; null without a selection. */
  const [selection, setSelection] = useState<{ left: number; top: number } | null>(null);
  /** The first FORMAT_HINT_TIMES times the toolbar opens, a line under it explains it (a counter in localStorage, no text). */
  const [hint, setHint] = useState(false);
  const keepToolbar = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  /** More than one line of text: the pill opens up into a rounded box. */
  const [tall, setTall] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const fine = useFinePointer();
  const normalized = normalizeBody(draft);
  const notice = filtered ? slurNotice(normalized) : null;
  const problem = bodyError(normalized, editing ? editing.hasImage : images.length > 0);
  const left = CHAT.maxLength - normalized.length;
  const canSend = online && !imageBusy && problem === null;
  /** An edit saves when the text is valid and differs from what the message says now (the server censors both the same way). */
  const canSave = !!editing && online && !editBusy && problem === null && censorBody(normalized) !== editing.body;

  // Grows with the text up to five lines (max-h-[7.5rem]). The box is border-box, so the borders are added to the
  // content height, or the text would overflow by 2 px and show a scrollbar; the bar only appears past five lines.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    const borders = element.offsetHeight - element.clientHeight;
    const wanted = element.scrollHeight + borders;
    element.style.height = `${Math.min(wanted, 120)}px`;
    element.style.overflowY = wanted > 120 ? 'auto' : 'hidden';
    setTall(wanted > 48);
  }, [draft]);

  /** Where the caret is, for the "@" picker. */
  const [caret, setCaret] = useState(draft.length);
  // While a message is being edited the field holds its text, so the unsent draft and the typing signal are left alone.
  const update = (text: string) => {
    if (polish && text) setImageError('');
    setDraft(text);
    if (editing) { setEditError(''); return; }
    chat.saveDraft(text); chat.signalTyping(normalizeBody(text).length > 0);
  };
  const toolbarOpen = tools || selection !== null;
  useEffect(() => {
    if (!toolbarOpen) { setHint(false); return; }
    let times = 0;
    try { times = Number(localStorage.getItem(FORMAT_HINT_KEY)) || 0; } catch { /* private mode */ }
    if (times >= FORMAT_HINT_TIMES) return;
    setHint(true);
    try { localStorage.setItem(FORMAT_HINT_KEY, String(times + 1)); } catch { /* ignore */ }
  }, [toolbarOpen]);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  /**
   * Reads the field's selection; a collapsed one hides the floating toolbar. The toolbar is only re-placed when the
   * selected range changes: the select event also fires on mouseup inside the toolbar, and moving it then would pull
   * the button out from under the pointer before the click lands.
   */
  const lastRange = useRef<string | null>(null);
  const readSelection = () => {
    const element = field.current;
    if (!element) return;
    setCaret(element.selectionEnd);
    const range = element.selectionStart === element.selectionEnd ? null : `${element.selectionStart}:${element.selectionEnd}`;
    if (range === lastRange.current) return;
    lastRange.current = range;
    const rect = range ? selectionRect(element) : null;
    if (!rect || !form.current) { setSelection(null); return; }
    // The toolbar is positioned within the form, so the field's offset inside it is added to the in-field coordinates.
    const fieldBox = element.getBoundingClientRect(), formBox = form.current.getBoundingClientRect();
    setSelection({ left: fieldBox.left - formBox.left + rect.left + rect.width / 2, top: fieldBox.top - formBox.top + rect.top });
  };
  const onBlur = () => {
    if (!normalized && !editing) chat.signalTyping(false);
    // A toolbar press steals focus for a moment on some browsers; the field gets it back in format().
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => { if (!keepToolbar.current) { lastRange.current = null; setSelection(null); } keepToolbar.current = false; }, 150);
  };
  // Choosing a message to reply to brings the keyboard up, as WhatsApp does; the strip's "Cancel reply" or Escape drops it.
  const chosen = chat.reply;
  useEffect(() => { if (chosen) field.current?.focus({ preventScroll: true }); }, [chosen]);
  // The strip follows the target's live row: a deletion or redaction the log has shown reads "Message unavailable" here too.
  const reply = chosen && liveQuote(chosen, chat.messages, name);

  /**
   * Starting an edit puts the message's text in the field with the caret at its end; the unsent draft is untouched in
   * the thread's memory (update() stops saving while editing) and comes back when the edit ends either way.
   */
  const editingId = editing?.id ?? null;
  const setEditing = chat.setEditing;
  useEffect(() => {
    if (!editing) return;
    setDraft(editing.body); setEditError('');
    requestAnimationFrame(() => { const element = field.current; if (!element) return; element.focus({ preventScroll: true }); element.setSelectionRange(element.value.length, element.value.length); setCaret(element.value.length); });
    // Keyed on the id: only a new target restarts the edit, not each render's copy of it.
  }, [editingId]);
  const endEdit = useCallback(() => {
    setEditing(null); setEditError('');
    setDraft(chat.initialDraft);
    field.current?.focus({ preventScroll: true });
  }, [setEditing, chat.initialDraft]);
  // The message went away while it was being edited (deleted here or elsewhere, removed by a moderator): nothing is left to save.
  const editedRow = editing ? chat.messages.find((message) => message.seq === editing.seq) : undefined;
  const editGone = !!editing && !!editedRow && (editedRow.body === null || editedRow.deletedBy !== null);
  useEffect(() => { if (editGone) endEdit(); }, [editGone, endEdit]);
  const saveEdit = async () => {
    if (!editing || !canSave) return;
    setEditBusy(true); setEditError('');
    try { await chat.editOwn(editing.id, normalized); if (mounted.current) endEdit(); }
    catch (error) { if (mounted.current) setEditError(errorMessage(error)); }
    finally { if (mounted.current) setEditBusy(false); }
  };

  /**
   * Beta, groups and rooms: typing "@" and a few letters lists the people it could mean; picking one writes "@Name"
   * and remembers who was meant, so the send can tell the server (the text alone could match two people of one name).
   */
  const mentioned = useRef(new Map<string, string>());
  const [mentionAt, setMentionAt] = useState(0);
  /** The "@" the list was closed for with Escape; typing a new "@" opens it again. */
  const [mentionClosed, setMentionClosed] = useState<number | null>(null);
  const token = polish && people?.length && !editing ? mentionQuery(draft, caret) : null;
  const matches = token && mentionClosed !== token.start ? mentionMatches(people ?? [], token.query) : [];
  const mentionIndex = Math.min(mentionAt, Math.max(0, matches.length - 1));
  const mentionList = useId();
  const pickMention = (person: Mentionable) => {
    const element = field.current;
    if (!token || !element) return;
    const insert = `${mentionText(person.displayName)} `;
    const next = draft.slice(0, token.start) + insert + draft.slice(caret).replace(/^ /, '');
    const position = token.start + insert.length;
    mentioned.current.set(person.id, person.displayName);
    update(next);
    setMentionAt(0); setCaret(position);
    requestAnimationFrame(() => { element.focus({ preventScroll: true }); element.setSelectionRange(position, position); });
  };

  const submit = () => {
    if (editing) { void saveEdit(); return; }
    if (!canSend) return;
    const ids = [...mentioned.current].filter(([, person]) => mentionsName(normalized, person)).map(([id]) => id);
    // Sent as typed: only the server censors, so it can keep the original for the owner (src/server/moderation.ts).
    // Several images go out as one message each, the text with the last (sendParts); the reply rides the first.
    for (const part of sendParts(normalized, images)) chat.send(part.body, part.image, part.body && ids.length ? ids : undefined);
    mentioned.current.clear();
    clearImages();
    update('');
    field.current?.focus({ preventScroll: true });
  };
  const format = (marker: string) => {
    const element = field.current;
    if (!element) return;
    const next = wrapSelection(element.value, element.selectionStart, element.selectionEnd, marker);
    update(next.value);
    requestAnimationFrame(() => { element.focus({ preventScroll: true }); element.setSelectionRange(next.start, next.end); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMentionAt((mentionIndex + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickMention(matches[mentionIndex]!); return; }
      if (event.key === 'Escape') { event.preventDefault(); setMentionClosed(token!.start); return; }
    }
    if (event.key === 'Escape' && editing) { event.preventDefault(); endEdit(); return; }
    if (event.key === 'Escape' && reply) { event.preventDefault(); chat.setReply(null); return; }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const shortcut = FORMATS.find((entry) => entry.key === event.key.toLowerCase() && !!entry.shift === event.shiftKey);
      if (shortcut) { event.preventDefault(); format(shortcut.marker); return; }
    }
    // Enter sends on every device; Shift+Enter (or Ctrl+Enter) inserts a newline. A composing IME keeps its Enter.
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };
  /**
   * One toolbar node whichever way it shows: in flow above the field when pinned by "Aa", floating over the selected
   * text otherwise. Only its classes change, so a click that lands as the mode flips (the field's select event fires
   * on mouseup too) still reaches the same button.
   */
  const toolbar = (floating: boolean) => <div role="toolbar" aria-label="Formatting" onPointerDown={() => { keepToolbar.current = true; }}
    className={cn('grid gap-1', floating ? 'absolute top-0 left-0 z-20 -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-2xl bg-popover p-1 text-popover-foreground shadow-float ring-1 ring-foreground/10' : 'pl-11')}
    style={floating && selection ? { left: `clamp(5.5rem, ${selection.left}px, calc(100% - 5.5rem))`, top: `${selection.top}px` } : undefined}>
    <div className="flex items-center gap-1">
      {FORMATS.map((entry) => <IconButton key={entry.marker} label={entry.label} icon={entry.icon} size="sm" className="rounded-full" disabled={!online} onMouseDown={(event) => event.preventDefault()}
        title={`${entry.label} (${fine ? 'Ctrl+' : ''}${entry.shift ? 'Shift+' : ''}${entry.key.toUpperCase()})`} onClick={() => format(entry.marker)} />)}
    </div>
    {hint && <Hint className={cn('text-[12px]', floating ? 'max-w-[18rem] px-1 pb-0.5' : '')}>Select text, then pick a style. <code className="font-mono">**bold**</code>, <code className="font-mono">_italic_</code>, <code className="font-mono">~~strike~~</code>, <code className="font-mono">`code`</code> also work.</Hint>}
  </div>;

  const strip = 'ml-11 flex items-center gap-2.5 rounded-xl bg-muted/70 py-1.5 pr-1 pl-3 ring-1 ring-inset ring-foreground/[0.05]';
  return <form ref={form} className={cn(BAR, 'relative grid gap-1.5 border-t border-foreground/[0.07] pt-2 pb-[max(8px,env(safe-area-inset-bottom))] lg:px-4 lg:pb-4')} onSubmit={(event) => { event.preventDefault(); submit(); }}>
    {/* The toolbar floats over the selected text; the "Aa" button pins it above the field instead. One toolbar, one node. */}
    {toolbarOpen && toolbar(selection !== null)}
    {editing && <div role="status" className={strip}>
      <Icon name="edit" size={15} className="shrink-0 text-primary" />
      <span className="grid min-w-0 flex-1">
        <span className="text-[12px] font-semibold leading-tight text-primary">Editing message</span>
        <span className="truncate text-[13px] leading-snug text-muted-foreground">{censorSlurs(plainText(editing.body)).replace(/\s+/g, ' ').trim() || 'Photo'}</span>
      </span>
      <IconButton label="Cancel editing" icon="x" size="sm" className="rounded-full" disabled={editBusy} onClick={endEdit} />
    </div>}
    {editError && <Hint tone="danger" role="alert" className="ml-11">{editError}</Hint>}
    {reply && !editing && <div role="status" className={strip}>
      {!polish && <span aria-hidden="true" className="h-8 w-0.5 shrink-0 rounded-full bg-primary" />}
      <span className="grid min-w-0 flex-1">
        <span className="text-[12px] font-semibold leading-tight text-primary">{quoteName(reply)}</span>
        <span className={cn('truncate text-[13px] leading-snug text-muted-foreground', reply.preview === null && 'italic')}>{reply.preview ?? 'Message unavailable'}</span>
      </span>
      <IconButton label="Cancel reply" icon="x" size="sm" className="rounded-full" onClick={() => chat.setReply(null)} />
    </div>}
    {!editing && images.length === 1 && <div className="relative ml-11 w-fit">
      <img src={imageDataUrl(images[0]!)} alt="Image to send" className="max-h-40 max-w-full rounded-xl object-contain" />
      <IconButton label="Remove image" icon="x" size="sm" className="absolute top-1 right-1 rounded-full bg-card" onClick={() => removeImage(0)} />
    </div>}
    {!editing && images.length > 1 && <ul aria-label={`${images.length} images to send`} className="ml-11 flex flex-wrap gap-2">
      {images.map((image, index) => <li key={`${index}-${image.length}`} className="relative">
        <img src={imageDataUrl(image)} alt={`Image ${index + 1} to send`} className="size-20 rounded-xl object-cover" />
        <IconButton label={`Remove image ${index + 1}`} icon="x" size="sm" className="absolute -top-1.5 -right-1.5 rounded-full bg-card shadow-sm ring-1 ring-foreground/10" onClick={() => removeImage(index)} />
      </li>)}
    </ul>}
    {!editing && images.length > 1 && <Hint className="ml-11 text-[12px]">Each image is sent as its own message{normalized ? ', with your text under the last one' : ''}.</Hint>}
    {imageError && <Hint tone="danger" role="alert" className={cn(polish && 'ml-11')}>{imageError}</Hint>}
    {dropping && <Hint role="status" className="ml-11 rounded-xl border border-dashed border-primary/60 bg-primary-soft px-3 py-2 text-[13px] font-medium text-primary-soft-foreground">{online ? 'Drop the image to attach it.' : 'You’re offline. Images can’t be sent right now.'}</Hint>}
    <input ref={picker} type="file" className="sr-only" aria-label="Choose message image" accept="image/jpeg,image/png,image/webp,image/gif" multiple={polish} disabled={!online || imagesFull || !!editing}
      onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addImages(files); }} />
    <div className="flex items-end gap-2">
      <Button variant="ghost" className="mb-0.5 size-9 shrink-0 rounded-full px-0" aria-label="Attach image" disabled={!online || imagesFull || !!editing} onClick={() => picker.current?.click()}>{imageBusy ? <Spinner /> : polish ? <Icon name="plus" size={20} /> : <span aria-hidden="true">+</span>}</Button>
      <Button variant="ghost" aria-label="Formatting" title="Formatting" aria-pressed={tools} aria-expanded={toolbarOpen} disabled={!online} className="mb-0.5 size-9 shrink-0 rounded-full px-0 text-[13px] font-bold tracking-tight text-muted-foreground aria-pressed:bg-primary-soft aria-pressed:text-primary-soft-foreground" onClick={() => setTools((current) => !current)}>Aa</Button>
      <div className="grid min-w-0 flex-1 gap-1">
        {/* The pill: one line of 16 px text at 40 px tall, the Send circle tucked into its right end. */}
        <div className="relative">
          {/* The "@" picker opens upward from the field. Its rows keep focus in the field (mousedown is cancelled), so typing carries on. */}
          {matches.length > 0 && <ul id={mentionList} role="listbox" aria-label="People to mention" className="absolute right-0 bottom-full left-0 z-20 mb-1.5 grid max-h-64 overflow-y-auto rounded-2xl bg-popover p-1 text-popover-foreground shadow-float ring-1 ring-foreground/10">
            {matches.map((person, index) => <li key={person.id} id={`${mentionList}-${index}`} role="option" aria-selected={index === mentionIndex}
              onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setMentionAt(index)} onClick={() => pickMention(person)}
              className={cn('flex min-h-10 cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1 text-[14px]', index === mentionIndex && 'bg-muted')}>
              <MemberAvatar name={person.displayName} src={person.avatar} size="sm" /><span className="truncate font-medium">{person.displayName}</span>
            </li>)}
          </ul>}
          <Textarea ref={field} aria-label={editing ? 'Edit your message' : `Message ${name}`} rows={1} autoComplete="off" maxLength={COMPOSER_MAX_LENGTH}
            aria-controls={matches.length ? mentionList : undefined} aria-activedescendant={matches.length ? `${mentionList}-${mentionIndex}` : undefined}
            className={cn('field-sizing-fixed max-h-[7.5rem] min-h-10 resize-none border-control-border bg-card py-2 pl-4 pr-11 text-base leading-6 shadow-[inset_0_1px_2px_rgb(0_0_0/0.03)] transition-[border-radius] placeholder:text-muted-foreground/80 md:text-base dark:bg-input/20', tall ? 'rounded-[22px]' : 'rounded-full')}
            placeholder={online ? 'Message' : 'Offline'} disabled={!online || editBusy} enterKeyHint="send" value={draft}
            onChange={(event) => { setCaret(event.target.selectionEnd); setMentionClosed(null); update(event.target.value); }} onKeyDown={onKeyDown} onSelect={readSelection} onKeyUp={readSelection} onBlur={onBlur} onPaste={onPaste} />
          <IconButton type="submit" label={editing ? 'Save edit' : 'Send'} icon={editing ? 'check' : 'arrowUp'} variant="primary" disabled={editing ? !canSave : !canSend} aria-busy={editBusy || undefined} className="absolute right-1 bottom-1 size-8 rounded-full pointer-coarse:min-h-8 pointer-coarse:min-w-8 disabled:bg-muted-foreground/35 disabled:text-background disabled:opacity-100 disabled:shadow-none [&_svg]:size-[18px] [&_svg]:stroke-[2.5]" />
        </div>
        {notice && <Hint role="status" className="px-3">{notice}</Hint>}
        {left <= 100 && <Hint tone={left < 0 ? 'danger' : 'muted'} className="px-3">{left < 0 ? problem : `${left} left`}</Hint>}
      </div>
    </div>
  </form>;
}

/* ---------- Dialogs ---------- */

function ConfirmModal({ title, description, confirm, online, onClose, onConfirm }: { title: string; description: string; confirm: string; online: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setPending(true); setError('');
    try { await onConfirm(); } catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} title={title} description={description}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="danger" busy={pending} disabled={!online} onClick={() => void run()}>{confirm}</Button></>}>
    {error ? <Callout tone="danger" icon="alert" role="alert">{error}</Callout> : null}
  </Modal>;
}

/** Who on Quasar staff is speaking in the room: the role from src/domain/staff.ts, so nobody can pass as the owner. */
function StaffBadge({ rank }: { rank: StaffRank }) {
  return <span className="ml-1.5 inline-flex items-center rounded-full bg-primary-soft px-1.5 align-[1px] text-[10px] font-semibold leading-4 text-primary-soft-foreground ring-1 ring-inset ring-primary/15">{STAFF_LABELS[rank]}</span>;
}

/** A moderator removes someone's room message, with an optional reason everyone sees in its place. */
function ReasonModal({ title, description, confirm, online, onClose, onConfirm }: { title: string; description: string; confirm: string; online: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setPending(true); setError('');
    try { await onConfirm(reason.trim()); } catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={reason.trim().length > 0} title={title} description={description}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="danger" busy={pending} disabled={!online} onClick={() => void run()}>{confirm}</Button></>}>
    <Field label="Reason (optional, shown to everyone)" htmlFor="global-remove-reason"><Input id="global-remove-reason" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Spam, personal info, off topic…" /></Field>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

/** A moderator rewrites a room message. The same body rules and slur filter apply, and the reason shows under the message. */
function EditModal({ message, moderator, online, onClose, onSave }: { message: ChatMessage; moderator: string; online: boolean; onClose: () => void; onSave: (body: string, reason: string) => Promise<void> }) {
  const [draft, setDraft] = useState(message.body ?? '');
  const [reason, setReason] = useState(moderation(message).reason ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const normalized = censorBody(normalizeBody(draft));
  const problem = bodyError(normalized, !!message.image);
  const notice = slurNotice(normalizeBody(draft));
  const changed = normalized !== (message.body ?? '') || reason.trim() !== (moderation(message).reason ?? '');
  const save = async () => {
    if (problem) return;
    setPending(true); setError('');
    // The text as typed: the server censors it and keeps the original for the owner.
    try { await onSave(normalizeBody(draft), reason.trim()); } catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={changed} title={message.fromMe ? 'Edit your message' : `Edit ${senderName(message)}’s message`}
    description={`Everyone sees the new text, “Edited by ${moderator}” and your reason.`}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={!online || !!problem || !changed} onClick={() => void save()}>Save</Button></>}>
    <Field label="Message" htmlFor="global-edit-body" hint={notice ?? undefined} error={draft && problem ? problem : undefined}><Textarea id="global-edit-body" rows={4} maxLength={COMPOSER_MAX_LENGTH} value={draft} onChange={(event) => setDraft(event.target.value)} /></Field>
    <Field label="Reason (optional, shown to everyone)" htmlFor="global-edit-reason"><Input id="global-edit-reason" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Fixed the time, removed a phone number…" /></Field>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

type ReportTarget = { kind: 'peer'; userId: string; mode: 'chat' | 'message' | 'closed'; seq?: number } | { kind: 'group'; groupId: string; seq: number };

/**
 * Report a chat (latest CHAT.evidence messages), one message (the window around it), a closed chat's row, or a
 * group message (the window around it, from everyone in the group, against its sender). Closed rows have no block
 * checkbox, because the chat is already closed.
 */
function ReportModal({ state, name, target, onClose, onSent }: { state: AppState; name: string; target: ReportTarget; onClose: () => void; onSent: (blocked: boolean) => void }) {
  const [category, setCategory] = useState<ReportCategory | ''>('');
  const [note, setNote] = useState('');
  const [block, setBlock] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const crisisId = useId();
  const options = (Object.keys(REPORT_CATEGORIES) as ReportCategory[]).map((value) => ({ value, label: REPORT_CATEGORIES[value].label }));
  const closed = target.kind === 'peer' && target.mode === 'closed';
  const single = target.kind === 'group' || target.mode === 'message';
  const send = async () => {
    if (!category) return;
    setPending(true); setError('');
    try {
      const accountId = state.context.user.id;
      const result = target.kind === 'group'
        ? await api.group.report.mutate({ accountId, groupId: target.groupId, category, note: note.trim(), seq: target.seq, block })
        : await api.chat.report.mutate({ accountId, userId: target.userId, category, note: note.trim(), ...(target.mode === 'message' && target.seq ? { seq: target.seq } : {}), block: !closed && block });
      setPending(false);
      onSent(result.blocked);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={category !== '' || note.trim().length > 0}
    title={single ? 'Report message' : `Report ${name}`}
    description={target.kind === 'group' ? `Support sees your report, this message and the messages around it from everyone in the group. ${name} isn’t told who reported.`
      : single ? `Support sees your report, this message and the messages around it. ${name} isn’t told who reported.` : `Support sees your report and the last ${CHAT.evidence} messages in this chat. ${name} isn’t told who reported.`}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="danger" busy={pending} disabled={!category || !state.online} onClick={() => void send()}>Send report</Button></>}>
    <div className="grid gap-2">
      <span className="text-[13px] font-semibold text-foreground/80" aria-hidden="true">What’s wrong?</span>
      <Segmented<ReportCategory | ''> label="What’s wrong?" value={category} options={options} onChange={setCategory} className="w-full flex-col items-stretch *:pointer-coarse:h-11" />
    </div>
    {/* Announced when chosen, and read again with the note field, so a screen reader user can't miss it. */}
    {category === 'danger' && <div id={crisisId}><Callout tone="info" icon="info" role="status">If someone is in immediate danger, call 911. For crisis support, call or text 988.</Callout></div>}
    <Field label="Anything else? (optional)" htmlFor="chat-report-note"><Textarea id="chat-report-note" aria-describedby={category === 'danger' ? crisisId : undefined} maxLength={2000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
    {!closed && <div className="flex items-center gap-2.5">
      <Checkbox id="chat-report-block" checked={block} onCheckedChange={(value) => setBlock(value === true)} />
      <Label htmlFor="chat-report-block" className="font-medium">Also block {name}</Label>
    </div>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
