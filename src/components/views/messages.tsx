'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { api, errorMessage } from '@/client/api';
import { bodyError, censorBody, CHAT, COMPOSER_MAX_LENGTH, normalizeBody, REPORT_CATEGORIES, type ReportCategory } from '@/domain/chat';
import { censorSlurs, icePrankNotice, mentionsImmigrants, slurNotice } from '@/domain/chat-filter';
import { parseMarkdown, plainText, type Block, type Inline } from '@/domain/markdown';
import { chatTime, daysBetween, formatDate, formatDateTime, formatTime, instantParts, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import type { AppState } from '../app-state';
import { AppealModal } from '../appeal';
import { Icon, type IconName } from '../icon';
import { AvatarStack, MemberAvatar } from '../member-avatar';
import { Button, Callout, Chip, EmptyState, Field, Hint, IconButton, Input, Modal, Segmented, Spacer, Textarea } from '../primitives';
import { Checkbox } from '../ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Label } from '../ui/label';
import { GLOBAL_TARGET, useChatInbox, useChatThread, useChatViewport, type ChatInboxRow, type ChatMessage, type ChatPause, type ChatThread, type GlobalSummary, type GroupInfo, type GroupSummary, type Outgoing, type Receipt } from '../use-chat';

type OpenRow = Extract<ChatInboxRow, { state: 'open' }>;
type ClosedRow = Extract<ChatInboxRow, { state: 'closed' }>;
type Friend = OpenRow['peer'];
type Mode = 'peer' | 'group' | 'global';

/** `#messages?room=global` opens the global chat (docs/CHAT.md §11); `?group=<id>` a friend group (§12). */
const GLOBAL_ROOM = 'global';
const GLOBAL_NAME = 'Global chat';
const groupKey = (groupId: string) => `group:${groupId}`;

/** Gap after which a bubble shows its time even inside a run. */
const RUN_GAP_MS = 10 * 60_000;
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
/** The owner's edit or removal note on a global message, if any. */
function moderation(message: ChatMessage): { edited: boolean; reason: string | null } {
  if (!('sender' in message)) return { edited: false, reason: null };
  return { edited: message.editedAt !== null, reason: message.reason };
}
function removedText(message: ChatMessage): string {
  const { reason } = moderation(message);
  if (message.deletedBy === 'support') return 'Hidden by support';
  if (message.deletedBy === 'owner') return reason ? `Removed by the owner: ${reason}` : 'Removed by the owner';
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

/** "Bob is typing…", "Bob and Cara are typing…", "Bob, Cara and 2 others are typing…" */
export function typingText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length - 2 === 1 ? 'other' : 'others'} are typing…`;
}

/* ---------- Message text: the markdown subset, censored at display time ---------- */

function renderInline(nodes: Inline[], mine: boolean, keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      // Censored at display time too (messages stored before the filter, slur-shaped words in links), href kept real.
      case 'text': return <span key={key}>{censorSlurs(node.text)}</span>;
      case 'link': return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow ugc" className={cn('underline underline-offset-2', mine ? 'text-primary-foreground decoration-primary-foreground/60' : 'text-primary decoration-primary/50')}>{censorSlurs(node.text)}</a>;
      case 'code': return <code key={key} className={cn('rounded-md px-1 py-px font-mono text-[0.9em]', mine ? 'bg-black/20' : 'bg-foreground/[0.08]')}>{censorSlurs(node.text)}</code>;
      case 'strong': return <strong key={key} className="font-bold">{renderInline(node.children, mine, key)}</strong>;
      case 'em': return <em key={key}>{renderInline(node.children, mine, key)}</em>;
      case 'strike': return <s key={key} className="opacity-80">{renderInline(node.children, mine, key)}</s>;
    }
  });
}

function renderLines(lines: Inline[][], mine: boolean, keyPrefix: string): ReactNode[] {
  return lines.flatMap((line, index) => [index > 0 ? <br key={`${keyPrefix}-br-${index}`} /> : null, ...renderInline(line, mine, `${keyPrefix}-${index}`)]);
}

function renderBlock(block: Block, index: number, mine: boolean): ReactNode {
  const key = `b${index}`;
  switch (block.kind) {
    case 'paragraph': return <p key={key} className="m-0">{renderLines(block.lines, mine, key)}</p>;
    case 'code': return <pre key={key} className={cn('my-1 overflow-x-auto whitespace-pre-wrap rounded-lg px-2.5 py-1.5 font-mono text-[13px] leading-snug', mine ? 'bg-black/20' : 'bg-foreground/[0.08]')}>{censorSlurs(block.text)}</pre>;
    case 'quote': return <blockquote key={key} className={cn('my-1 border-l-2 pl-2.5', mine ? 'border-primary-foreground/50 text-primary-foreground/90' : 'border-foreground/30 text-foreground/80')}>{renderLines(block.lines, mine, key)}</blockquote>;
    case 'list': return block.ordered
      ? <ol key={key} start={block.start} className="my-1 list-decimal pl-5">{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, mine, `${key}-${itemIndex}`)}</li>)}</ol>
      : <ul key={key} className="my-1 list-disc pl-5">{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, mine, `${key}-${itemIndex}`)}</li>)}</ul>;
  }
}

/**
 * Message text as React nodes: the markdown subset of docs/CHAT.md §13 rendered without any HTML, slurs censored at
 * display time (see renderInline), and only https links (full URL shown) clickable. Memoised on the text: the log
 * re-renders every bubble on each poll and menu toggle, and parsing and censoring are real work.
 */
function MessageText({ text, mine }: { text: string; mine: boolean }) {
  return useMemo(() => <div className="grid gap-1.5">{parseMarkdown(text).map((block, index) => renderBlock(block, index, mine))}</div>, [text, mine]);
}

/* ---------- View ---------- */

export function MessagesView({ state }: { state: AppState }) {
  const withId = state.params.get('with');
  const groupId = state.params.get('group');
  const inRoom = state.params.get('room') === GLOBAL_ROOM;
  /** The open conversation's key: a friend's id, "group:<id>", "global", or null for the list alone. */
  const openKey = withId ?? (groupId ? groupKey(groupId) : inRoom ? GLOBAL_ROOM : null);
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

  return <div className="flex min-h-0 flex-1 flex-col gap-4 animate-in fade-in-0 duration-300">
    {/* A phone thread keeps the page heading for screen readers only. */}
    <header className={cn('grid gap-1', openKey && 'max-lg:sr-only')}><h1 ref={heading} tabIndex={-1} className="outline-none">Messages</h1></header>
    {!state.online && <Callout tone="neutral" icon="cloudOff" role="status">You’re offline. Messages load when you reconnect.</Callout>}
    {notice && <Callout tone="success" icon="check" role="status">{notice}</Callout>}
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-5">
      {listMounted && <div className={cn('min-h-0 lg:overflow-y-auto lg:pr-1', openKey && 'max-lg:hidden')}>
        <ChatList state={state} inbox={inbox} selected={openKey} onReport={(row) => { setNotice(''); setReporting(row); }} onReopen={reopen} onNewGroup={() => setCreating(true)} />
      </div>}
      {withId
        ? <Thread key={`${withId}:${threadGeneration}`} state={state} userId={withId} phone={phone} fallbackName={openRow?.peer.displayName ?? closedRow?.displayName ?? ''} closedRow={closedRow}
            onChange={onThreadChange} onClosed={onThreadClosed} onReportClosed={setReporting} onReopen={reopen} onLeave={backToList} />
        : groupId
          ? <GroupThread key={groupId} state={state} groupId={groupId} phone={phone} friends={friends} onChange={onThreadChange} onLeave={backToList} />
          : inRoom
            ? <GlobalThread key={GLOBAL_ROOM} state={state} phone={phone} onChange={onThreadChange} />
            : <div className="hidden min-h-0 place-items-center rounded-3xl bg-card text-sm text-muted-foreground shadow-card ring-1 ring-foreground/[0.06] lg:grid">Pick a chat.</div>}
    </div>
    {reporting && <ReportModal state={state} name={reporting.displayName} target={{ kind: 'peer', userId: reporting.userId, mode: 'closed' }} onClose={() => setReporting(null)}
      onSent={() => { setReporting(null); setNotice('Report sent to support.'); reloadInbox(); }} />}
    {creating && <NewGroupModal state={state} friends={friends} onClose={() => setCreating(false)}
      onCreated={(group) => { setCreating(false); noticeFor.current = groupKey(group.id); setNotice(`Group “${group.name}” created.`); reloadInbox(); state.navigate('messages', { group: group.id }); }} />}
  </div>;
}

/* ---------- Chat list ---------- */

function ChatList({ state, inbox, selected, onReport, onReopen, onNewGroup }: { state: AppState; inbox: ReturnType<typeof useChatInbox>; selected: string | null; onReport: (row: ClosedRow) => void; onReopen: (row: ClosedRow) => Promise<void>; onNewGroup: () => void }) {
  const data = inbox.inbox;
  const recent = (data?.rows ?? []).filter((row) => row.state === 'closed' || row.lastMessage !== null);
  const friends = (data?.rows ?? []).filter((row): row is OpenRow => row.state === 'open' && row.lastMessage === null);
  const hasFriends = (data?.rows ?? []).some((row) => row.state === 'open');
  const [appealing, setAppealing] = useState(false);
  return <div className="grid gap-4">
    {inbox.loading && <Hint role="status">Loading chats…</Hint>}
    {inbox.error && !data && <Callout tone="danger" icon="alert" role="alert" actions={<Button size="sm" disabled={!state.online} onClick={inbox.reload}>Try again</Button>}>{inbox.error}</Callout>}
    {data && inbox.reconnecting && <Hint role="status">Reconnecting…</Hint>}
    {data?.pause && <Callout tone="warning" icon="lock" title={pauseText(data.pause, state.timeZone)}
      actions={data.pause.appealed ? <Chip tone="neutral" icon="clock">Appeal sent</Chip> : <Button size="sm" disabled={!state.online} onClick={() => setAppealing(true)}>Appeal</Button>}>
      Reason: {data.pause.reason} You can still read your chats.
    </Callout>}
    {appealing && data?.pause && <AppealModal accountId={state.context.user.id} kind="pause" what="your messaging pause" onClose={() => setAppealing(false)} onSent={async () => { setAppealing(false); inbox.reload(); await state.refresh(); }} />}
    {data && <section className="grid gap-2" aria-labelledby="chat-groups-title">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id="chat-groups-title" className="text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Groups</h2>
        <Button size="sm" variant="ghost" icon="plus" disabled={!state.online || !hasFriends} title={hasFriends ? undefined : 'Add friends first'} onClick={onNewGroup}>New group</Button>
      </div>
      <ul className="grid gap-1" aria-label="Groups">
        <GlobalChatRow summary={data.global} state={state} selected={selected === GLOBAL_ROOM} />
        {data.groups.map((group) => <GroupChatRow key={group.id} group={group} state={state} selected={selected === groupKey(group.id)} />)}
      </ul>
    </section>}
    {data && data.rows.length === 0 && <EmptyState icon="users" title="No friends to message yet" action={<Button variant="primary" icon="users" onClick={() => state.navigate('people')}>Find friends</Button>}>Chats open once a schoolmate accepts your friend request.</EmptyState>}
    {recent.length > 0 && <section className="grid gap-2" aria-labelledby="chat-recent-title">
      <h2 id="chat-recent-title" className="px-1 text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Recent</h2>
      <ul className="grid gap-1" aria-label="Chats">
        {recent.map((row) => row.state === 'open'
          ? <OpenChatRow key={row.peer.id} row={row} state={state} selected={selected === row.peer.id} />
          : <ClosedChatRow key={row.userId} row={row} online={state.online} onReport={() => onReport(row)} onReopen={() => onReopen(row)} />)}
      </ul>
    </section>}
    {friends.length > 0 && <section className="grid gap-2" aria-labelledby="chat-friends-title">
      <h2 id="chat-friends-title" className="px-1 text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Friends</h2>
      <ul className="grid gap-1" aria-label="Start a chat">
        {friends.map((row) => <OpenChatRow key={row.peer.id} row={row} state={state} selected={selected === row.peer.id} />)}
      </ul>
    </section>}
  </div>;
}

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
  if (last.preview === null) return last.deletedBy === 'owner' ? 'Removed by the owner' : 'Message deleted';
  return `${last.fromMe ? 'You' : last.senderName}: ${censorSlurs(last.preview)}`;
}

function groupPreview(group: GroupSummary): string {
  const last = group.lastMessage;
  if (!last) return pluralize(group.memberCount, 'member');
  if (last.preview === null) return last.deletedBy === 'support' ? 'Hidden by support' : last.deletedBy === 'admin' ? 'Removed by the group admin' : 'Message deleted';
  return `${last.fromMe ? 'You' : last.senderName}: ${censorSlurs(last.preview)}`;
}

/** The parts every list row shares: bold name while unread, mute icon, time, preview and the unread pill. */
function RowBody({ id, name, unread, muted, time, preview, verified, extra }: { id: string; name: string; unread: number; muted: boolean; time: string | null; preview: string; verified?: boolean; extra?: ReactNode }) {
  return <span className="grid min-w-0 flex-1 gap-0.5">
    <span className="flex min-w-0 items-center gap-1.5">
      <strong className={cn('truncate text-sm', unread > 0 ? 'font-extrabold' : 'font-semibold')}>{name}</strong>
      {verified && <span id={`${id}-verified`} role="img" aria-label="Verified" className="shrink-0 text-success"><Icon name="checkCircle" size={14} /></span>}
      {extra}
      {muted && <span id={`${id}-muted`} role="img" aria-label="Notifications muted" className="shrink-0 text-muted-foreground"><Icon name="bellOff" size={13} /></span>}
      {time && <span id={`${id}-time`} className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{time}</span>}
    </span>
    <span className="flex min-w-0 items-center gap-2">
      <span id={`${id}-preview`} className={cn('truncate text-[13px]', unread > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{preview}</span>
      {unread > 0 && <span id={`${id}-unread`} role="img" aria-label={unread === 1 ? '1 unread message' : `${unread} unread messages`}
        className={cn('ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[11px] font-bold leading-none tabular-nums', muted ? 'bg-muted-foreground/20 text-muted-foreground' : 'bg-primary text-primary-foreground')}>{unread > 99 ? '99+' : unread}</span>}
    </span>
  </span>;
}

const ROW = 'flex w-full min-w-0 items-center gap-3 rounded-2xl p-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary-soft';
const describedBy = (id: string, parts: Array<string | false | null | undefined>) => parts.filter(Boolean).map((part) => `${id}-${part}`).join(' ');

/** The global room's row. It is always present and sits above the friend groups. */
function GlobalChatRow({ summary, state, selected }: { summary: GlobalSummary; state: AppState; selected: boolean }) {
  const id = useId();
  return <li>
    <button type="button" data-chat-row={GLOBAL_ROOM} aria-label={`Open ${GLOBAL_NAME}`} aria-describedby={describedBy(id, ['preview', summary.lastMessage && 'time', summary.unread > 0 && 'unread', summary.muted && 'muted'])} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { room: GLOBAL_ROOM })} className={ROW}>
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground"><Icon name="users" size={18} /></span>
      <RowBody id={id} name={GLOBAL_NAME} unread={summary.unread} muted={summary.muted} time={summary.lastMessage ? chatTime(summary.lastMessage.createdAt, state.timeZone, state.now) : null} preview={globalPreview(summary)} />
    </button>
  </li>;
}

function GroupChatRow({ group, state, selected }: { group: GroupSummary; state: AppState; selected: boolean }) {
  const id = useId();
  return <li>
    <button type="button" data-chat-row={groupKey(group.id)} aria-label={`Open group ${group.name}`} aria-describedby={describedBy(id, ['preview', group.lastMessage && 'time', group.unread > 0 && 'unread', group.muted && 'muted'])} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { group: group.id })} className={ROW}>
      <AvatarStack members={group.members} size="sm" max={2} className="w-10 justify-center" />
      <RowBody id={id} name={group.name} unread={group.unread} muted={group.muted} time={group.lastMessage ? chatTime(group.lastMessage.createdAt, state.timeZone, state.now) : null} preview={groupPreview(group)} />
    </button>
  </li>;
}

function OpenChatRow({ row, state, selected }: { row: OpenRow; state: AppState; selected: boolean }) {
  const id = useId();
  const name = row.peer.displayName;
  return <li>
    <button type="button" data-chat-row={row.peer.id} aria-label={`Open chat with ${name}`} aria-describedby={describedBy(id, [row.peer.verified && 'verified', 'preview', row.lastMessage && 'time', row.unread > 0 && 'unread', row.muted && 'muted'])} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { with: row.peer.id })} className={ROW}>
      <MemberAvatar name={name} src={row.peer.avatar} />
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
  return <li className="flex min-w-0 items-center gap-3 rounded-2xl p-3">
    <MemberAvatar name={row.displayName} muted />
    <span className="grid min-w-0 flex-1 gap-0.5">
      <strong className="truncate text-sm font-semibold">{row.displayName}</strong>
      <span className="text-[13px] text-muted-foreground">Chat closed</span>
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

const FRAME = 'flex min-h-0 flex-1 flex-col overflow-hidden outline-none lg:rounded-3xl lg:bg-card lg:shadow-card lg:ring-1 lg:ring-foreground/[0.06]';

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
  return <IconButton label="Back to chats" icon="arrowLeft" className="lg:hidden" onClick={() => state.navigate('messages')} />;
}

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

/** The composer's replacement while support has paused the student: the reason and an appeal (docs/CHAT.md §14). */
function PausedComposer({ pause, state, onAppealed }: { pause: ChatPause; state: AppState; onAppealed: () => void }) {
  const [appealing, setAppealing] = useState(false);
  return <div className="grid gap-2 border-t border-foreground/[0.06] pt-3 pb-[max(8px,env(safe-area-inset-bottom))] lg:px-4 lg:pb-4">
    <Hint role="status" className="text-[13px]">{pauseText(pause, state.timeZone)} Reason: {pause.reason}</Hint>
    <div>{pause.appealed ? <Chip tone="neutral" icon="clock">Appeal sent. Support will review it.</Chip> : <Button size="sm" disabled={!state.online} onClick={() => setAppealing(true)}>Appeal</Button>}</div>
    {appealing && <AppealModal accountId={state.context.user.id} kind="pause" what="your messaging pause" onClose={() => setAppealing(false)} onSent={async () => { setAppealing(false); onAppealed(); await state.refresh(); }} />}
  </div>;
}

/* ---------- One-to-one thread ---------- */

type ThreadModal = { kind: 'delete'; messageId: string } | { kind: 'block' } | { kind: 'report'; seq?: number } | null;

function Thread({ state, userId, phone, fallbackName, closedRow, onChange, onClosed, onReportClosed, onReopen, onLeave }: {
  state: AppState; userId: string; phone: boolean; fallbackName: string; closedRow: ClosedRow | null;
  onChange: () => void; onClosed: () => void; onReportClosed: (row: ClosedRow) => void; onReopen: (row: ClosedRow) => Promise<void>; onLeave: (notice: string) => void;
}) {
  const chat = useChatThread(state, { kind: 'peer', userId }, { onChange });
  const name = chat.peer?.displayName ?? fallbackName;
  const [modal, setModal] = useState<ThreadModal>(null);
  const [actionError, setActionError] = useState('');
  const [reported, setReported] = useState(false);
  const [muting, setMuting] = useState(false);
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
    <header className="flex items-center gap-2.5 border-b border-foreground/[0.06] pb-2 lg:px-4 lg:pt-3">
      {back}
      <MemberAvatar name={name} src={peer.avatar} size="md" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <button type="button" aria-label={`Open ${name}’s profile`} onClick={() => state.navigate('people', { member: userId })}
          className="w-fit max-w-full truncate rounded-md text-left text-[15.5px] font-bold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{name}</button>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {peer.verified ? <Chip tone="success" icon="checkCircle">Verified</Chip> : <Chip tone="outline">Not verified</Chip>}
          {peer.fullName && <Hint className="truncate">{peer.fullName}</Hint>}
          {chat.muted && <span role="img" aria-label="Notifications muted" className="text-muted-foreground"><Icon name="bellOff" size={14} /></span>}
          {chat.reconnecting && <Hint role="status">Reconnecting…</Hint>}
        </div>
      </div>
      {/* Report and Block live in the menu: they matter, but they are not what a chat is for. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><IconButton label="More options" icon="more" aria-busy={muting || undefined} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => state.navigate('people', { member: userId })}><Icon name="users" />View profile</DropdownMenuItem>
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
    <MessageLog state={state} chat={chat} name={name} mode="peer" onDelete={(message) => setModal({ kind: 'delete', messageId: message.id })} onReport={(seq) => { setReported(false); setModal({ kind: 'report', seq }); }} />
    {chat.pause
      ? <PausedComposer pause={chat.pause} state={state} onAppealed={chat.pollNow} />
      : <Composer key={userId} chat={chat} name={name} online={state.online} filtered />}

    {modal?.kind === 'delete' && <ConfirmModal title="Delete for both of you?" description={`It disappears from this chat now. Support can still see it for ${CHAT.deletedTextDays} days if this chat is reported.`} confirm="Delete" online={state.online}
      onClose={() => setModal(null)} onConfirm={async () => { await chat.deleteMessage(modal.messageId); setModal(null); }} />}
    {modal?.kind === 'block' && <ConfirmModal title={`Block ${name}?`} description="You won’t see each other in People, their Global chat and group messages are hidden from you, and this chat closes." confirm="Block" online={state.online}
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

function GroupThread({ state, groupId, phone, friends, onChange, onLeave }: { state: AppState; groupId: string; phone: boolean; friends: Friend[]; onChange: () => void; onLeave: (notice: string) => void }) {
  const chat = useChatThread(state, { kind: 'group', groupId }, { onChange });
  const [modal, setModal] = useState<GroupModal>(null);
  const [actionError, setActionError] = useState('');
  const [reported, setReported] = useState(false);
  const [muting, setMuting] = useState(false);
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
    <header className="flex items-center gap-2.5 border-b border-foreground/[0.06] pb-2 lg:px-4 lg:pt-3">
      {back}
      <AvatarStack members={others} size="sm" max={3} className="w-12 justify-center" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <button type="button" aria-label={`Open the members of ${name}`} onClick={() => setModal({ kind: 'members' })}
          className="w-fit max-w-full truncate rounded-md text-left text-[15.5px] font-bold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{name}</button>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip tone="neutral" icon="users">{pluralize(group.members.length, 'member')}</Chip>
          {admin && <Chip tone="accent" icon="crown">You’re the admin</Chip>}
          {chat.muted && <span role="img" aria-label="Notifications muted" className="text-muted-foreground"><Icon name="bellOff" size={14} /></span>}
          {chat.reconnecting && <Hint role="status">Reconnecting…</Hint>}
        </div>
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><IconButton label="More options" icon="more" aria-busy={muting || undefined} /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => setModal({ kind: 'members' })}><Icon name="users" />{admin ? 'Members and adding people' : 'Members'}</DropdownMenuItem>
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
    <MessageLog state={state} chat={chat} name={name} mode="group" canModerate={admin}
      onDelete={(message) => setModal({ kind: 'delete', message })} onReport={(seq) => { const message = chat.messages.find((entry) => entry.seq === seq); if (message) { setReported(false); setModal({ kind: 'report', message }); } }} />
    {chat.pause
      ? <PausedComposer pause={chat.pause} state={state} onAppealed={chat.pollNow} />
      : <Composer key={groupId} chat={chat} name={name} online={state.online} filtered />}

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

/* ---------- Global chat thread ---------- */

type GlobalModal = { kind: 'delete'; message: ChatMessage } | { kind: 'edit'; message: ChatMessage } | null;

/**
 * The global room (§11). No block, report or "closed" state: it is public, and the owner moderates it
 * directly with Edit and Delete on any message, each with a reason everyone can read.
 */
function GlobalThread({ state, phone, onChange }: { state: AppState; phone: boolean; onChange: () => void }) {
  const chat = useChatThread(state, GLOBAL_TARGET, { onChange });
  const [modal, setModal] = useState<GlobalModal>(null);
  const [actionError, setActionError] = useState('');
  const [muting, setMuting] = useState(false);
  const canModerate = chat.room?.canModerate ?? false;
  const back = <BackButton state={state} />;
  const section = useThreadFocus(phone);
  const frame = (children: ReactNode) => <section ref={section} tabIndex={-1} aria-label={GLOBAL_NAME} className={FRAME}>{children}</section>;

  if (chat.status !== 'ready' || !chat.room) return frame(<ThreadLoading state={state} chat={chat} back={back} title={<strong className="truncate text-[15px] font-bold">{GLOBAL_NAME}</strong>} />);

  const members = chat.room.members;
  const toggleMute = async () => {
    setMuting(true); setActionError('');
    try { await chat.setMuted(!chat.muted); } catch (err) { setActionError(errorMessage(err)); } finally { setMuting(false); }
  };
  const mine = modal?.kind === 'delete' && modal.message.fromMe;

  return frame(<>
    <header className="flex items-center gap-2.5 border-b border-foreground/[0.06] pb-2 lg:px-4 lg:pt-3">
      {back}
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground"><Icon name="users" size={18} /></span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <strong className="truncate text-[15.5px] font-bold">{GLOBAL_NAME}</strong>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip tone="neutral" icon="users">{members === 1 ? '1 member' : `${members} members`}</Chip>
          {canModerate && <Chip tone="success" icon="checkCircle">You moderate this room</Chip>}
          {chat.reconnecting && <Hint role="status">Reconnecting…</Hint>}
        </div>
      </div>
      <IconButton label={chat.muted ? 'Unmute notifications' : 'Mute notifications'} icon={chat.muted ? 'bell' : 'bellOff'} aria-busy={muting || undefined} disabled={!state.online || muting} onClick={() => void toggleMute()} />
    </header>
    {actionError && <div className="grid gap-2 pt-3 lg:px-4"><Callout tone="danger" icon="alert" role="alert">{actionError}</Callout></div>}
    <MessageLog state={state} chat={chat} name="everyone" mode="global" canModerate={canModerate}
      onDelete={(message) => setModal({ kind: 'delete', message })} onEdit={(message) => setModal({ kind: 'edit', message })} />
    {chat.pause
      ? <PausedComposer pause={chat.pause} state={state} onAppealed={chat.pollNow} />
      : <Composer key={GLOBAL_ROOM} chat={chat} name="everyone" online={state.online} filtered />}

    {modal?.kind === 'delete' && (mine
      ? <ConfirmModal title="Delete for everyone?" description="It disappears from the global chat now." confirm="Delete" online={state.online}
          onClose={() => setModal(null)} onConfirm={async () => { await chat.deleteMessage(modal.message.id); setModal(null); }} />
      : <ReasonModal title={`Remove ${senderName(modal.message)}’s message?`} description="Everyone sees “Removed by the owner” and your reason in its place." confirm="Remove" online={state.online}
          onClose={() => setModal(null)} onConfirm={async (reason) => { await chat.deleteMessage(modal.message.id, reason); setModal(null); }} />)}
    {modal?.kind === 'edit' && <EditModal message={modal.message} online={state.online} onClose={() => setModal(null)}
      onSave={async (body, reason) => { await chat.editMessage(modal.message.id, body, reason); setModal(null); }} />}
  </>);
}

/* ---------- Message log ---------- */

type LogItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'message'; key: string; message: ChatMessage; date: string; time: string; showTime: boolean; showName: boolean };

function buildItems(messages: ChatMessage[], initialReadSeq: number | null, timeZone: string, today: string, named: boolean): LogItem[] {
  const items: LogItem[] = [];
  const parts = messages.map((message) => instantParts(message.createdAt, timeZone));
  const firstUnread = initialReadSeq === null ? undefined : messages.find((message) => !message.fromMe && message.seq > initialReadSeq)?.seq;
  messages.forEach((message, index) => {
    const { date, time } = parts[index]!;
    const newDay = index === 0 || parts[index - 1]!.date !== date;
    if (newDay) items.push({ kind: 'day', key: `day-${date}`, label: dayLabel(date, today) });
    if (message.seq === firstUnread) items.push({ kind: 'unread', key: 'unread' });
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const gap = (later: ChatMessage, earlier: ChatMessage) => new Date(later.createdAt).getTime() - new Date(earlier.createdAt).getTime() > RUN_GAP_MS;
    // The time sits under the last bubble of a run: next is from someone else, another day, or over 10 minutes later.
    const showTime = !next || senderKey(next) !== senderKey(message) || parts[index + 1]!.date !== date || gap(next, message);
    // In a room or group, the name (and picture) sits over the first bubble of someone else's run.
    const showName = named && !message.fromMe && (!previous || newDay || senderKey(previous) !== senderKey(message) || gap(message, previous));
    items.push({ kind: 'message', key: `m-${message.seq}`, message, date, time, showTime, showName });
    // The ICE prank (§11): a joke line under any message that mentions immigrants. Nothing is reported anywhere.
    if (message.body && mentionsImmigrants(message.body)) items.push({ kind: 'notice', key: `ice-${message.seq}`, text: icePrankNotice() });
  });
  return items;
}

function MessageLog({ state, chat, name, mode, canModerate = false, onDelete, onEdit, onReport }: {
  state: AppState; chat: ChatThread; name: string; mode: Mode; canModerate?: boolean;
  onDelete: (message: ChatMessage) => void; onEdit?: (message: ChatMessage) => void; onReport?: (seq: number) => void;
}) {
  const named = mode !== 'peer';
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
  const [earlierError, setEarlierError] = useState('');
  const items = useMemo(() => buildItems(messages, chat.initialReadSeq, state.timeZone, state.today, named), [messages, chat.initialReadSeq, state.timeZone, state.today, named]);
  /** The viewer's newest confirmed message carries the delivery or read caption (§13). */
  const lastMineSeq = useMemo(() => { for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]!.fromMe) return messages[index]!.seq; return null; }, [messages]);
  const typists = useMemo(() => receipts.filter((receipt) => receipt.typing), [receipts]);
  const typistsKey = typists.map((receipt) => receipt.id).join(',');

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
    const observer = new ResizeObserver(() => { if (atBottom.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
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

  const empty = messages.length === 0 && outgoing.length === 0;
  const logLabel = mode === 'global' ? 'Global chat messages' : mode === 'group' ? `Messages in ${name}` : `Messages with ${name}`;
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 lg:px-4"
      onScroll={() => { atBottom.current = nearBottom(); if (atBottom.current) { setJump(false); maybeRead(); } }}>
      {chat.hasEarlier && <div className="grid justify-items-center gap-2 pb-3">
        <Button size="sm" variant="ghost" busy={chat.loadingEarlier} disabled={!state.online} onClick={() => void loadEarlier()}>Load earlier messages</Button>
        {earlierError && <Hint tone="danger" role="alert">{earlierError}</Hint>}
      </div>}
      {empty && <div className="grid justify-items-center gap-2 px-4 py-10 text-center">
        <p className="text-[15px] font-bold">No messages yet.</p>
        {mode === 'global'
          ? <Hint className="max-w-[40ch] text-[13px]">Everyone on Quasar can read and post here. Swearing is fine; slurs get censored. The owner can edit or remove any message.</Hint>
          : mode === 'group'
            ? <Hint className="max-w-[40ch] text-[13px]">Only the people in {name} can read this. New members see messages from when they joined. Support sees messages only if someone reports them.</Hint>
            : <Hint className="max-w-[40ch] text-[13px]">Only you and {name} can read this chat. Support sees messages only if one of you reports them.</Hint>}
      </div>}
      <ol role="log" aria-live={quiet ? 'off' : 'polite'} aria-label={logLabel} className="grid grid-cols-[minmax(0,1fr)] gap-1">
        {items.map((item) => {
          if (item.kind === 'day') return <li key={item.key} role="none" className="flex justify-center py-2"><span className="rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-semibold text-muted-foreground">{item.label}</span></li>;
          if (item.kind === 'unread') return <li key={item.key} role="none" className="flex items-center gap-2 py-2 text-[11.5px] font-bold text-primary"><span aria-hidden="true" className="h-px flex-1 bg-primary/40" />New messages<span aria-hidden="true" className="h-px flex-1 bg-primary/40" /></li>;
          if (item.kind === 'notice') return <li key={item.key} className="flex justify-center px-2 py-1"><span className="max-w-[48ch] rounded-xl bg-warning-soft px-3 py-1.5 text-center text-[12.5px] font-medium text-foreground/80 ring-1 ring-inset ring-foreground/[0.06]">{item.text}</span></li>;
          const { message } = item;
          const status = message.fromMe && message.seq === lastMineSeq ? receiptStatus(message.seq, receipts, mode === 'group') : null;
          return <Bubble key={item.key} message={message} date={item.date} time={item.time} showTime={item.showTime} showName={item.showName} status={status} online={state.online} mode={mode} canModerate={canModerate}
            open={openActions === message.seq} onToggle={() => setOpenActions((current) => (current === message.seq ? null : message.seq))}
            added={added[message.seq]} onAddTask={() => void addTask(message)} onDelete={() => onDelete(message)} onEdit={onEdit && (() => onEdit(message))} onReport={onReport && (() => onReport(message.seq))} />;
        })}
      </ol>
      {/* Outside the live log: a sent message is announced once, when the log gains the confirmed copy. */}
      {outgoing.length > 0 && <ul aria-label="Unsent messages" className="mt-1 grid grid-cols-[minmax(0,1fr)] gap-1">
        {outgoing.map((item) => <PendingBubble key={item.clientId} item={item} online={state.online} onRetry={chat.retry} onDiscard={() => chat.discard(item.clientId)} />)}
      </ul>}
      {typists.length > 0 && <TypingRow typists={typists} withAvatar={named} />}
    </div>
    {jump && <Button size="sm" variant="primary" icon="arrowDown" aria-label="Jump to new messages" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-float"
      onClick={() => { toBottom(true); maybeRead(); }}>New messages</Button>}
  </div>;
}

const BUBBLE = 'min-w-0 rounded-2xl px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere]';
const MINE = 'bg-primary text-primary-foreground';
const THEIRS = 'bg-muted text-foreground ring-1 ring-inset ring-foreground/[0.04]';

/** "Bob is typing…" as a bubble of bouncing dots at the end of the log (docs/CHAT.md §13). */
function TypingRow({ typists, withAvatar }: { typists: Receipt[]; withAvatar: boolean }) {
  const text = typingText(typists.map((typist) => typist.displayName));
  const first = typists[0]!;
  return <div role="status" aria-live="polite" className="mt-1 flex items-end gap-2 px-0.5">
    {withAvatar && <MemberAvatar name={first.displayName} src={first.avatar} size="sm" />}
    <span className={cn(BUBBLE, THEIRS, 'flex items-center gap-1 py-2.5')} title={text}>
      {[0, 1, 2].map((dot) => <span key={dot} aria-hidden="true" className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70" style={{ animationDelay: `${dot * 150}ms` }} />)}
      <span className="sr-only">{text}</span>
    </span>
    {typists.length > 1 && <span aria-hidden="true" className="text-xs text-muted-foreground">{text}</span>}
  </div>;
}

function Bubble({ message, date, time, showTime, showName, status, online, mode, canModerate, open, onToggle, added, onAddTask, onDelete, onEdit, onReport }: {
  message: ChatMessage; date: string; time: string; showTime: boolean; showName: boolean; status: ReturnType<typeof receiptStatus>; online: boolean; mode: Mode; canModerate: boolean;
  open: boolean; onToggle: () => void; added: 'saving' | 'added' | string | undefined; onAddTask: () => void; onDelete: () => void; onEdit?: () => void; onReport?: () => void;
}) {
  const actionsId = useId();
  const mine = message.fromMe;
  const removed = message.body === null || message.deletedBy !== null;
  const { edited, reason } = moderation(message);
  const name = senderName(message);
  const withAvatar = mode !== 'peer' && !mine;
  // Tapping or clicking the bubble toggles its actions on every device. This is not gated on the
  // pointer type: iPadOS reports a fine pointer whenever a keyboard case, trackpad or Pencil is
  // around, and Safari never focuses a tapped button, so hover- and focus-only reveals would leave
  // touch users with no way in. A click that selected text or landed on a link is left alone.
  const tap = (event: MouseEvent<HTMLDivElement>) => {
    if (removed || (event.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
    onToggle();
  };
  const label = mode !== 'peer' && !mine ? `${name}: ` : '';
  const editNote = edited ? (reason ? `Edited by the owner: ${reason}` : 'Edited by the owner') : '';
  const removeLabel = mine ? 'Delete message' : 'Remove message';
  return <li data-seq={message.seq} className={cn('group/msg flex', mine ? 'justify-end' : 'justify-start')}>
    {/* In a room or group, the sender's picture sits beside the first bubble of their run; later bubbles keep the space. */}
    {withAvatar && <span className="mr-2 w-7 shrink-0 self-end">{showName && <MemberAvatar name={name} src={senderAvatar(message)} size="sm" />}</span>}
    <div className={cn('flex min-w-0 flex-1 flex-col', mine ? 'items-end' : 'items-start')}>
      {showName && <span className="mb-0.5 px-1 text-[12px] font-bold text-muted-foreground">{name}{'sender' in message && message.sender.verified && <><Icon name="checkCircle" size={12} className="ml-1 inline-block align-[-1px] text-success" /><span className="sr-only"> (verified)</span></>}</span>}
      {/* The bubble keeps 80% of the row; the actions button sits beside it rather than eating into it. */}
      <div className={cn('flex items-center gap-1', removed ? 'max-w-[80%]' : 'max-w-[calc(80%+2.25rem)] pointer-coarse:max-w-[calc(80%+3rem)]', mine && 'flex-row-reverse')}>
        {removed
          ? <div title={formatDateTime(date, time)} className={cn(BUBBLE, 'border border-dashed border-foreground/20 bg-transparent italic text-muted-foreground')}>{label && <span className="sr-only">{label}</span>}{removedText(message)}</div>
          : <div title={formatDateTime(date, time)} onClick={tap} className={cn(BUBBLE, mine ? MINE : THEIRS)}>{label && <span className="sr-only">{label}</span>}<MessageText text={message.body ?? ''} mine={mine} /></div>}
        {!removed && <IconButton label="Message actions" icon="more" size="sm" aria-expanded={open} aria-controls={open ? actionsId : undefined} onClick={onToggle}
          className="shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity no-hover:opacity-50 focus-visible:opacity-100 aria-expanded:opacity-100 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100" />}
      </div>
      {open && !removed && <div id={actionsId} className={cn('mt-1 flex flex-wrap items-center gap-1.5', mine && 'justify-end')}>
        {!mine && (added === 'added'
          ? <Hint role="status" className="px-2 text-[13px] text-success">Added to Tasks.</Hint>
          : <Button size="sm" variant="ghost" icon="tasks" busy={added === 'saving'} onClick={onAddTask}>Add as task</Button>)}
        {!mine && onReport && <Button size="sm" variant="ghost" icon="flag" disabled={!online} onClick={onReport}>Report message</Button>}
        {canModerate && onEdit && <Button size="sm" variant="ghost" icon="edit" aria-label="Edit message" disabled={!online} onClick={onEdit}>Edit</Button>}
        {(mine || canModerate) && <Button size="sm" variant="ghost" icon="trash" aria-label={removeLabel} disabled={!online} onClick={onDelete}>{mine ? 'Delete' : 'Remove'}</Button>}
        {!mine && added && added !== 'added' && added !== 'saving' && <Hint tone="danger" role="alert">{added}</Hint>}
      </div>}
      {(showTime || editNote || status) && <span className="mt-0.5 flex items-center gap-1 px-1 text-xs text-muted-foreground">
        {showTime && formatTime(time)}{showTime && editNote && ' · '}{editNote}
        {status && <>{(showTime || editNote) && <span aria-hidden="true">·</span>}<Icon name={status.icon} size={13} className={status.read ? 'text-primary' : undefined} /><span className={cn(status.read && 'font-semibold text-primary')}>{status.label}</span></>}
      </span>}
    </div>
  </li>;
}

function PendingBubble({ item, online, onRetry, onDiscard }: { item: Outgoing; online: boolean; onRetry: () => void; onDiscard: () => void }) {
  const failed = item.status === 'failed';
  return <li className="flex flex-col items-end">
    <div className={cn(BUBBLE, MINE, 'max-w-[80%]', !failed && 'opacity-60', failed && 'ring-2 ring-destructive ring-offset-2 ring-offset-background')}><MessageText text={item.body} mine /></div>
    {failed
      ? <div className="mt-1 grid justify-items-end gap-1.5">
        <Hint tone="danger" role="alert" className="text-right">Not sent.{item.error ? ` ${item.error}` : ''}</Hint>
        <div className="flex gap-1.5">
          {item.retryable && <Button size="sm" icon="refresh" aria-label="Retry sending" disabled={!online} onClick={onRetry}>Retry</Button>}
          <Button size="sm" variant="ghost" onClick={onDiscard}>Discard</Button>
        </div>
      </div>
      : <span className="mt-0.5 flex items-center gap-1 px-1 text-xs text-muted-foreground"><Icon name="clock" size={12} />Sending…</span>}
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

/** `filtered` shows the slur notice (every chat has the filter): the draft still sends, and the server stores it with the slur censored. */
function Composer({ chat, name, online, filtered = false }: { chat: ChatThread; name: string; online: boolean; filtered?: boolean }) {
  const [draft, setDraft] = useState(chat.initialDraft);
  const [tools, setTools] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const fine = useFinePointer();
  const normalized = normalizeBody(draft);
  const notice = filtered ? slurNotice(normalized) : null;
  const problem = bodyError(normalized);
  const left = CHAT.maxLength - normalized.length;
  const canSend = online && problem === null;

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
  }, [draft]);

  const update = (text: string) => { setDraft(text); chat.saveDraft(text); chat.signalTyping(normalizeBody(text).length > 0); };
  const submit = () => {
    if (!canSend) return;
    // Censored locally too, so the pending bubble never shows the slur while the send is out. Links stay whole, as the server stores them.
    chat.send(censorBody(normalized));
    update('');
    field.current?.focus();
  };
  const format = (marker: string) => {
    const element = field.current;
    if (!element) return;
    const next = wrapSelection(element.value, element.selectionStart, element.selectionEnd, marker);
    update(next.value);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(next.start, next.end); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const shortcut = FORMATS.find((entry) => entry.key === event.key.toLowerCase() && !!entry.shift === event.shiftKey);
      if (shortcut) { event.preventDefault(); format(shortcut.marker); return; }
    }
    // Enter sends only with a mouse or trackpad; on touch it inserts a newline and the Send button sends.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229 || !finePointer()) return;
    event.preventDefault();
    submit();
  };

  return <form className="grid gap-1.5 border-t border-foreground/[0.06] pt-2 pb-[max(8px,env(safe-area-inset-bottom))] lg:px-4 lg:pb-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    {tools && <div className="flex flex-wrap items-center justify-center gap-2" role="toolbar" aria-label="Formatting">
      {FORMATS.map((entry) => <IconButton key={entry.marker} label={entry.label} icon={entry.icon} size="sm" disabled={!online} title={`${entry.label} (${fine ? 'Ctrl' : ''}${fine ? '+' : ''}${entry.shift ? 'Shift+' : ''}${entry.key.toUpperCase()})`} onClick={() => format(entry.marker)} />)}
    </div>}
    <div className="flex items-end gap-2">
      <IconButton label="Formatting" icon="textFormat" aria-pressed={tools} aria-expanded={tools} disabled={!online} className="size-10 shrink-0 rounded-full aria-pressed:bg-primary-soft aria-pressed:text-primary-soft-foreground" onClick={() => setTools((current) => !current)} />
      <div className="grid min-w-0 flex-1 gap-1">
        <Textarea ref={field} aria-label={`Message ${name}`} rows={1} className="max-h-[7.5rem] min-h-10 resize-none py-2 text-base leading-6 md:text-base" autoComplete="off" maxLength={COMPOSER_MAX_LENGTH}
          placeholder={online ? 'Message' : 'Offline'} disabled={!online} enterKeyHint={fine ? 'send' : 'enter'} value={draft}
          onChange={(event) => update(event.target.value)} onKeyDown={onKeyDown} onBlur={() => { if (!normalized) chat.signalTyping(false); }} />
        {notice && <Hint role="status" className="px-1">{notice}</Hint>}
        {left <= 100 && <Hint tone={left < 0 ? 'danger' : 'muted'} className="px-1">{left < 0 ? problem : `${left} left`}</Hint>}
      </div>
      <IconButton type="submit" label="Send" icon="send" variant="primary" disabled={!canSend} className="size-10 shrink-0 rounded-full" />
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

/** The owner removes someone's room message, with an optional reason everyone sees in its place. */
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

/** The owner rewrites a room message. The same body rules and slur filter apply, and the reason shows under the message. */
function EditModal({ message, online, onClose, onSave }: { message: ChatMessage; online: boolean; onClose: () => void; onSave: (body: string, reason: string) => Promise<void> }) {
  const [draft, setDraft] = useState(message.body ?? '');
  const [reason, setReason] = useState(moderation(message).reason ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const normalized = censorBody(normalizeBody(draft));
  const problem = bodyError(normalized);
  const notice = slurNotice(normalizeBody(draft));
  const changed = normalized !== (message.body ?? '') || reason.trim() !== (moderation(message).reason ?? '');
  const save = async () => {
    if (problem) return;
    setPending(true); setError('');
    try { await onSave(normalized, reason.trim()); } catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={changed} title={message.fromMe ? 'Edit your message' : `Edit ${senderName(message)}’s message`}
    description="Everyone sees the new text, “Edited by the owner” and your reason."
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
