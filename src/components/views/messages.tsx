'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { api, errorMessage } from '@/client/api';
import { bodyError, censorBody, censoredLinkParts, CHAT, COMPOSER_MAX_LENGTH, normalizeBody, REPORT_CATEGORIES, type ReportCategory } from '@/domain/chat';
import { censorSlurs, icePrankNotice, mentionsImmigrants, slurNotice } from '@/domain/chat-filter';
import { chatTime, daysBetween, formatDate, formatDateTime, formatTime, instantParts } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { Button, Callout, Chip, EmptyState, Field, Hint, IconButton, Input, Modal, Segmented, Spacer, Textarea } from '../primitives';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { GLOBAL_TARGET, useChatInbox, useChatThread, useChatViewport, type ChatInboxRow, type ChatMessage, type ChatPause, type ChatThread, type GlobalSummary, type Outgoing } from '../use-chat';

type OpenRow = Extract<ChatInboxRow, { state: 'open' }>;
type ClosedRow = Extract<ChatInboxRow, { state: 'closed' }>;

/** `#messages?room=global` opens the global chat (docs/CHAT.md §11). */
const GLOBAL_ROOM = 'global';
const GLOBAL_NAME = 'Global chat';

/** Gap after which a bubble shows its time even inside a run. */
const RUN_GAP_MS = 10 * 60_000;
/** How close to the bottom (px) still counts as "at the bottom" for auto-scroll and read marking. */
const BOTTOM_SLACK = 80;

/* ---------- Small helpers ---------- */

function MemberAvatar({ name, muted }: { name: string; muted?: boolean }) {
  return <span aria-hidden="true" className={cn('grid size-10 shrink-0 place-items-center rounded-full text-sm font-extrabold', muted ? 'bg-muted text-muted-foreground' : 'text-primary-foreground')}
    style={muted ? undefined : { background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 75%, white) 0%, var(--primary) 60%, color-mix(in srgb, var(--primary) 70%, black) 100%)' }}>{(name || '?').slice(0, 1).toUpperCase()}</span>;
}

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

/** Task title from a message: whitespace collapsed, trimmed, first 120 characters. */
function taskTitle(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 120);
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

/** Who sent a message, for runs and name labels: the global room keys by sender, a one-to-one chat by side. */
function senderKey(message: ChatMessage): string {
  return 'sender' in message ? message.sender.id : message.fromMe ? 'me' : 'them';
}
function senderName(message: ChatMessage): string {
  return 'sender' in message ? message.sender.displayName : '';
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
  return 'Message deleted';
}

/**
 * Message text as React text nodes, slurs censored at display time too (messages stored before the filter existed,
 * and slur-shaped words inside links, whose href keeps the real address); only https links (full URL shown) are clickable.
 */
function MessageText({ text: raw, mine }: { text: string; mine: boolean }) {
  // Memoised on the text: the log re-renders every bubble on each poll and menu toggle, and censoring is real work.
  // censoredLinkParts returns one plain run when CHAT.linkify is off.
  const parts = useMemo(() => censoredLinkParts(raw), [raw]);
  return <>{parts.map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer nofollow ugc" className={cn('underline underline-offset-2', mine ? 'text-primary-foreground decoration-primary-foreground/60' : 'text-primary decoration-primary/50')}>{part.text}</a>
    : <span key={index}>{part.text}</span>)}</>;
}

/* ---------- View ---------- */

export function MessagesView({ state }: { state: AppState }) {
  const withId = state.params.get('with');
  const inRoom = state.params.get('room') === GLOBAL_ROOM;
  /** The open conversation's key: a friend's id, "global", or null for the list alone. */
  const openKey = withId ?? (inRoom ? GLOBAL_ROOM : null);
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
        <ChatList state={state} inbox={inbox} selected={openKey} onReport={(row) => { setNotice(''); setReporting(row); }} onReopen={reopen} />
      </div>}
      {withId
        ? <Thread key={`${withId}:${threadGeneration}`} state={state} userId={withId} phone={phone} fallbackName={openRow?.peer.displayName ?? closedRow?.displayName ?? ''} closedRow={closedRow}
            onChange={onThreadChange} onClosed={onThreadClosed} onReportClosed={setReporting} onReopen={reopen} onLeave={backToList} />
        : inRoom
          ? <GlobalThread key={GLOBAL_ROOM} state={state} phone={phone} onChange={onThreadChange} />
          : <div className="hidden min-h-0 place-items-center rounded-3xl bg-card text-sm text-muted-foreground shadow-card ring-1 ring-foreground/[0.06] lg:grid">Pick a chat.</div>}
    </div>
    {reporting && <ReportModal state={state} userId={reporting.userId} name={reporting.displayName} mode="closed" onClose={() => setReporting(null)}
      onSent={() => { setReporting(null); setNotice('Report sent to support.'); reloadInbox(); }} />}
  </div>;
}

/* ---------- Chat list ---------- */

function ChatList({ state, inbox, selected, onReport, onReopen }: { state: AppState; inbox: ReturnType<typeof useChatInbox>; selected: string | null; onReport: (row: ClosedRow) => void; onReopen: (row: ClosedRow) => Promise<void> }) {
  const data = inbox.inbox;
  const recent = (data?.rows ?? []).filter((row) => row.state === 'closed' || row.lastMessage !== null);
  const friends = (data?.rows ?? []).filter((row): row is OpenRow => row.state === 'open' && row.lastMessage === null);
  return <div className="grid gap-4">
    {inbox.loading && <Hint role="status">Loading chats…</Hint>}
    {inbox.error && !data && <Callout tone="danger" icon="alert" role="alert" actions={<Button size="sm" disabled={!state.online} onClick={inbox.reload}>Try again</Button>}>{inbox.error}</Callout>}
    {data && inbox.reconnecting && <Hint role="status">Reconnecting…</Hint>}
    {data?.pause && <Callout tone="warning" icon="lock">{data.pause.until ? `Support paused your messaging until ${pauseDate(data.pause.until, state.timeZone)}. You can still read your chats.` : 'Support paused your messaging. You can still read your chats.'}</Callout>}
    {data && <section className="grid gap-2" aria-labelledby="chat-groups-title">
      <h2 id="chat-groups-title" className="px-1 text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Group chats</h2>
      <ul className="grid gap-1" aria-label="Rooms">
        <GlobalChatRow summary={data.global} state={state} selected={selected === GLOBAL_ROOM} />
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

/** The global room's row. It is always present and sits above the one-to-one chats. */
function GlobalChatRow({ summary, state, selected }: { summary: GlobalSummary; state: AppState; selected: boolean }) {
  const id = useId();
  const unread = summary.unread > 0;
  const described = [`${id}-preview`, summary.lastMessage && `${id}-time`, unread && `${id}-unread`, summary.muted && `${id}-muted`].filter(Boolean).join(' ');
  return <li>
    <button type="button" data-chat-row={GLOBAL_ROOM} aria-label={`Open ${GLOBAL_NAME}`} aria-describedby={described} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { room: GLOBAL_ROOM })}
      className="flex w-full min-w-0 items-center gap-3 rounded-2xl p-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary-soft">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground"><Icon name="users" size={18} /></span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <strong className={cn('truncate text-sm', unread ? 'font-extrabold' : 'font-semibold')}>{GLOBAL_NAME}</strong>
          {summary.muted && <span id={`${id}-muted`} role="img" aria-label="Notifications muted" className="shrink-0 text-muted-foreground"><Icon name="bellOff" size={13} /></span>}
          {summary.lastMessage && <span id={`${id}-time`} className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{chatTime(summary.lastMessage.createdAt, state.timeZone, state.now)}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span id={`${id}-preview`} className={cn('truncate text-[13px]', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{globalPreview(summary)}</span>
          {unread && <span id={`${id}-unread`} role="img" aria-label={summary.unread === 1 ? '1 unread message' : `${summary.unread} unread messages`}
            className={cn('ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[11px] font-bold leading-none tabular-nums', summary.muted ? 'bg-muted-foreground/20 text-muted-foreground' : 'bg-primary text-primary-foreground')}>{summary.unread > 99 ? '99+' : summary.unread}</span>}
        </span>
      </span>
    </button>
  </li>;
}

function OpenChatRow({ row, state, selected }: { row: OpenRow; state: AppState; selected: boolean }) {
  const id = useId();
  const name = row.peer.displayName;
  const unread = row.unread > 0;
  const described = [row.peer.verified && `${id}-verified`, `${id}-preview`, row.lastMessage && `${id}-time`, unread && `${id}-unread`, row.muted && `${id}-muted`].filter(Boolean).join(' ');
  return <li>
    <button type="button" data-chat-row={row.peer.id} aria-label={`Open chat with ${name}`} aria-describedby={described} aria-current={selected ? 'true' : undefined}
      onClick={() => state.navigate('messages', { with: row.peer.id })}
      className="flex w-full min-w-0 items-center gap-3 rounded-2xl p-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary-soft">
      <MemberAvatar name={name} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <strong className={cn('truncate text-sm', unread ? 'font-extrabold' : 'font-semibold')}>{name}</strong>
          {row.peer.verified && <span id={`${id}-verified`} role="img" aria-label="Verified" className="shrink-0 text-success"><Icon name="checkCircle" size={14} /></span>}
          {row.muted && <span id={`${id}-muted`} role="img" aria-label="Notifications muted" className="shrink-0 text-muted-foreground"><Icon name="bellOff" size={13} /></span>}
          {row.lastMessage && <span id={`${id}-time`} className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{chatTime(row.lastMessage.createdAt, state.timeZone, state.now)}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span id={`${id}-preview`} className={cn('truncate text-[13px]', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{previewText(row)}</span>
          {unread && <span id={`${id}-unread`} role="img" aria-label={row.unread === 1 ? '1 unread message' : `${row.unread} unread messages`}
            className={cn('ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[11px] font-bold leading-none tabular-nums', row.muted ? 'bg-muted-foreground/20 text-muted-foreground' : 'bg-primary text-primary-foreground')}>{row.unread > 99 ? '99+' : row.unread}</span>}
        </span>
      </span>
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

/** A closed chat: no history, no link, only Report and (when the viewer can) a reopen control. It looks the same however the chat closed. */
function ClosedChatRow({ row, online, onReport, onReopen }: { row: ClosedRow; online: boolean; onReport: () => void; onReopen: () => Promise<void> }) {
  return <li className="flex min-w-0 items-center gap-3 rounded-2xl p-3">
    <MemberAvatar name={row.displayName} muted />
    <span className="grid min-w-0 flex-1 gap-0.5">
      <strong className="truncate text-sm font-semibold">{row.displayName}</strong>
      <span className="text-[13px] text-muted-foreground">Chat closed</span>
    </span>
    <ReopenButton row={row} online={online} onReopen={onReopen} />
    <Button size="sm" variant="ghost" aria-label={`Report ${row.displayName}`} disabled={!online} onClick={onReport}>Report</Button>
  </li>;
}

/* ---------- Thread ---------- */

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
  const back = <IconButton label="Back to chats" icon="arrowLeft" className="lg:hidden" onClick={() => state.navigate('messages')} />;

  // On phones the list (and the row that opened this chat) unmounts, so focus moves to the thread itself once.
  const section = useRef<HTMLElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!phone || focused.current) return;
    focused.current = true;
    if (!section.current?.contains(document.activeElement)) section.current?.focus({ preventScroll: true });
  }, [phone]);

  // A closed chat refreshes the list, which says whether a closed row (and so Report) exists.
  useEffect(() => { if (chat.status === 'closed') onClosed(); }, [chat.status, onClosed]);

  const frame = (children: ReactNode) => <section ref={section} tabIndex={-1} aria-label={name ? `Chat with ${name}` : 'Chat'} className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none lg:rounded-3xl lg:bg-card lg:shadow-card lg:ring-1 lg:ring-foreground/[0.06]">{children}</section>;

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

  if (!chat.peer) {
    return frame(<>
      <div className="flex items-center gap-2 lg:px-4 lg:pt-3">{back}{fallbackName && <strong className="truncate text-[15px] font-bold">{fallbackName}</strong>}</div>
      <div className="grid gap-3 py-4 lg:px-4">
        {chat.status === 'error' && chat.error
          ? <Callout tone="danger" icon="alert" role="alert" actions={<Button size="sm" disabled={!state.online} onClick={chat.pollNow}>Try again</Button>}>{chat.error}</Callout>
          : state.online && <Hint role="status">Loading messages…</Hint>}
      </div>
    </>);
  }

  const peer = chat.peer;
  const toggleMute = async () => {
    setMuting(true); setActionError('');
    try { await chat.setMuted(!chat.muted); } catch (err) { setActionError(errorMessage(err)); } finally { setMuting(false); }
  };

  return frame(<>
    <header className="flex items-center gap-1.5 border-b border-foreground/[0.06] pb-2 lg:px-4 lg:pt-3">
      {back}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <button type="button" aria-label={`Open ${name}’s profile`} onClick={() => state.navigate('people', { member: userId })}
          className="w-fit max-w-full truncate rounded-md text-left text-[15.5px] font-bold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{name}</button>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {peer.verified ? <Chip tone="success" icon="checkCircle">Verified</Chip> : <Chip tone="outline">Not verified</Chip>}
          {peer.fullName && <Hint className="truncate">{peer.fullName}</Hint>}
          {chat.reconnecting && <Hint role="status">Reconnecting…</Hint>}
        </div>
      </div>
      <IconButton label={chat.muted ? 'Unmute notifications' : 'Mute notifications'} icon={chat.muted ? 'bell' : 'bellOff'} aria-busy={muting || undefined} disabled={!state.online || muting} onClick={() => void toggleMute()} />
      {chat.messages.length > 0 && <Button size="sm" variant="ghost" disabled={!state.online} onClick={() => { setReported(false); setModal({ kind: 'report' }); }}>Report</Button>}
      <Button size="sm" variant="ghost" disabled={!state.online} onClick={() => setModal({ kind: 'block' })}>Block</Button>
    </header>
    {(actionError || reported) && <div className="grid gap-2 pt-3 lg:px-4">
      {actionError && <Callout tone="danger" icon="alert" role="alert">{actionError}</Callout>}
      {reported && <Callout tone="success" icon="check" role="status">Report sent to support.</Callout>}
    </div>}
    <MessageLog state={state} chat={chat} name={name} mode="peer" onDelete={(message) => setModal({ kind: 'delete', messageId: message.id })} onReport={(seq) => { setReported(false); setModal({ kind: 'report', seq }); }} />
    {chat.pause
      ? <div className="border-t border-foreground/[0.06] pt-3 pb-[max(8px,env(safe-area-inset-bottom))] lg:px-4 lg:pb-4"><Hint role="status" className="text-[13px]">{pauseText(chat.pause, state.timeZone)}</Hint></div>
      : <Composer key={userId} chat={chat} name={name} online={state.online} filtered />}

    {modal?.kind === 'delete' && <ConfirmModal title="Delete for both of you?" description={`It disappears from this chat now. Support can still see it for ${CHAT.deletedTextDays} days if this chat is reported.`} confirm="Delete" online={state.online}
      onClose={() => setModal(null)} onConfirm={async () => { await chat.deleteMessage(modal.messageId); setModal(null); }} />}
    {modal?.kind === 'block' && <ConfirmModal title={`Block ${name}?`} description="You won’t see each other in People, their Global chat messages are hidden from you, and this chat closes." confirm="Block" online={state.online}
      onClose={() => setModal(null)} onConfirm={async () => {
        await api.community.block.mutate({ accountId: state.context.user.id, userId, blocked: true });
        setModal(null);
        onLeave(`${name} is blocked.`);
      }} />}
    {modal?.kind === 'report' && <ReportModal state={state} userId={userId} name={name} mode={modal.seq ? 'message' : 'chat'} seq={modal.seq} onClose={() => setModal(null)}
      onSent={(blocked) => { setModal(null); if (blocked) onLeave(`Report sent. ${name} is blocked.`); else setReported(true); }} />}
  </>);
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
  const back = <IconButton label="Back to chats" icon="arrowLeft" className="lg:hidden" onClick={() => state.navigate('messages')} />;

  const section = useRef<HTMLElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!phone || focused.current) return;
    focused.current = true;
    if (!section.current?.contains(document.activeElement)) section.current?.focus({ preventScroll: true });
  }, [phone]);

  const frame = (children: ReactNode) => <section ref={section} tabIndex={-1} aria-label={GLOBAL_NAME} className="flex min-h-0 flex-1 flex-col overflow-hidden outline-none lg:rounded-3xl lg:bg-card lg:shadow-card lg:ring-1 lg:ring-foreground/[0.06]">{children}</section>;

  if (chat.status !== 'ready' || !chat.room) {
    return frame(<>
      <div className="flex items-center gap-2 lg:px-4 lg:pt-3">{back}<strong className="truncate text-[15px] font-bold">{GLOBAL_NAME}</strong></div>
      <div className="grid gap-3 py-4 lg:px-4">
        {chat.status === 'error' && chat.error
          ? <Callout tone="danger" icon="alert" role="alert" actions={<Button size="sm" disabled={!state.online} onClick={chat.pollNow}>Try again</Button>}>{chat.error}</Callout>
          : state.online && <Hint role="status">Loading messages…</Hint>}
      </div>
    </>);
  }

  const members = chat.room.members;
  const toggleMute = async () => {
    setMuting(true); setActionError('');
    try { await chat.setMuted(!chat.muted); } catch (err) { setActionError(errorMessage(err)); } finally { setMuting(false); }
  };
  const mine = modal?.kind === 'delete' && modal.message.fromMe;

  return frame(<>
    <header className="flex items-center gap-1.5 border-b border-foreground/[0.06] pb-2 lg:px-4 lg:pt-3">
      {back}
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
      ? <div className="border-t border-foreground/[0.06] pt-3 pb-[max(8px,env(safe-area-inset-bottom))] lg:px-4 lg:pb-4"><Hint role="status" className="text-[13px]">{pauseText(chat.pause, state.timeZone)}</Hint></div>
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

function buildItems(messages: ChatMessage[], initialReadSeq: number | null, timeZone: string, today: string, global: boolean): LogItem[] {
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
    // In the room, the name sits over the first bubble of someone else's run.
    const showName = global && !message.fromMe && (!previous || newDay || senderKey(previous) !== senderKey(message) || gap(message, previous));
    items.push({ kind: 'message', key: `m-${message.seq}`, message, date, time, showTime, showName });
    // The ICE prank (§11): a joke line under any message that mentions immigrants. Nothing is reported anywhere.
    if (message.body && mentionsImmigrants(message.body)) items.push({ kind: 'notice', key: `ice-${message.seq}`, text: icePrankNotice() });
  });
  return items;
}

function MessageLog({ state, chat, name, mode, canModerate = false, onDelete, onEdit, onReport }: {
  state: AppState; chat: ChatThread; name: string; mode: 'peer' | 'global'; canModerate?: boolean;
  onDelete: (message: ChatMessage) => void; onEdit?: (message: ChatMessage) => void; onReport?: (seq: number) => void;
}) {
  const global = mode === 'global';
  const { messages, outgoing } = chat;
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
  const items = useMemo(() => buildItems(messages, chat.initialReadSeq, state.timeZone, state.today, global), [messages, chat.initialReadSeq, state.timeZone, state.today, global]);

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
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 lg:px-4"
      onScroll={() => { atBottom.current = nearBottom(); if (atBottom.current) { setJump(false); maybeRead(); } }}>
      {chat.hasEarlier && <div className="grid justify-items-center gap-2 pb-3">
        <Button size="sm" variant="ghost" busy={chat.loadingEarlier} disabled={!state.online} onClick={() => void loadEarlier()}>Load earlier messages</Button>
        {earlierError && <Hint tone="danger" role="alert">{earlierError}</Hint>}
      </div>}
      {empty && <div className="grid justify-items-center gap-2 px-4 py-10 text-center">
        <p className="text-[15px] font-bold">No messages yet.</p>
        {global
          ? <Hint className="max-w-[40ch] text-[13px]">Everyone on Quasar can read and post here. Swearing is fine; slurs get censored. The owner can edit or remove any message.</Hint>
          : <Hint className="max-w-[40ch] text-[13px]">Only you and {name} can read this chat. Support sees messages only if one of you reports them.</Hint>}
      </div>}
      <ol role="log" aria-live={quiet ? 'off' : 'polite'} aria-label={global ? 'Global chat messages' : `Messages with ${name}`} className="grid grid-cols-[minmax(0,1fr)] gap-1">
        {items.map((item) => {
          if (item.kind === 'day') return <li key={item.key} role="none" className="flex justify-center py-2"><span className="rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-semibold text-muted-foreground">{item.label}</span></li>;
          if (item.kind === 'unread') return <li key={item.key} role="none" className="flex items-center gap-2 py-2 text-[11.5px] font-bold text-primary"><span aria-hidden="true" className="h-px flex-1 bg-primary/40" />New messages<span aria-hidden="true" className="h-px flex-1 bg-primary/40" /></li>;
          if (item.kind === 'notice') return <li key={item.key} className="flex justify-center px-2 py-1"><span className="max-w-[48ch] rounded-xl bg-warning-soft px-3 py-1.5 text-center text-[12.5px] font-medium text-foreground/80 ring-1 ring-inset ring-foreground/[0.06]">{item.text}</span></li>;
          const { message } = item;
          return <Bubble key={item.key} message={message} date={item.date} time={item.time} showTime={item.showTime} showName={item.showName} online={state.online} mode={mode} canModerate={canModerate}
            open={openActions === message.seq} onToggle={() => setOpenActions((current) => (current === message.seq ? null : message.seq))}
            added={added[message.seq]} onAddTask={() => void addTask(message)} onDelete={() => onDelete(message)} onEdit={onEdit && (() => onEdit(message))} onReport={onReport && (() => onReport(message.seq))} />;
        })}
      </ol>
      {/* Outside the live log: a sent message is announced once, when the log gains the confirmed copy. */}
      {outgoing.length > 0 && <ul aria-label="Unsent messages" className="mt-1 grid grid-cols-[minmax(0,1fr)] gap-1">
        {outgoing.map((item) => <PendingBubble key={item.clientId} item={item} online={state.online} onRetry={chat.retry} onDiscard={() => chat.discard(item.clientId)} />)}
      </ul>}
    </div>
    {jump && <Button size="sm" variant="primary" icon="arrowDown" aria-label="Jump to new messages" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-float"
      onClick={() => { toBottom(true); maybeRead(); }}>New messages</Button>}
  </div>;
}

const BUBBLE = 'min-w-0 rounded-2xl px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere]';
const MINE = 'bg-primary text-primary-foreground';
const THEIRS = 'bg-muted text-foreground ring-1 ring-inset ring-foreground/[0.04]';

function Bubble({ message, date, time, showTime, showName, online, mode, canModerate, open, onToggle, added, onAddTask, onDelete, onEdit, onReport }: {
  message: ChatMessage; date: string; time: string; showTime: boolean; showName: boolean; online: boolean; mode: 'peer' | 'global'; canModerate: boolean;
  open: boolean; onToggle: () => void; added: 'saving' | 'added' | string | undefined; onAddTask: () => void; onDelete: () => void; onEdit?: () => void; onReport?: () => void;
}) {
  const actionsId = useId();
  const mine = message.fromMe;
  const removed = message.body === null || message.deletedBy !== null;
  const { edited, reason } = moderation(message);
  const name = senderName(message);
  // Tapping or clicking the bubble toggles its actions on every device. This is not gated on the
  // pointer type: iPadOS reports a fine pointer whenever a keyboard case, trackpad or Pencil is
  // around, and Safari never focuses a tapped button, so hover- and focus-only reveals would leave
  // touch users with no way in. A click that selected text or landed on a link is left alone.
  const tap = (event: MouseEvent<HTMLDivElement>) => {
    if (removed || (event.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
    onToggle();
  };
  const label = mode === 'global' && !mine ? `${name}: ` : '';
  const editNote = edited ? (reason ? `Edited by the owner: ${reason}` : 'Edited by the owner') : '';
  return <li data-seq={message.seq} className={cn('group/msg flex flex-col', mine ? 'items-end' : 'items-start')}>
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
      {!mine && onReport && <Button size="sm" variant="ghost" icon="alert" disabled={!online} onClick={onReport}>Report message</Button>}
      {canModerate && onEdit && <Button size="sm" variant="ghost" icon="edit" aria-label="Edit message" disabled={!online} onClick={onEdit}>Edit</Button>}
      {(mine || canModerate) && <Button size="sm" variant="ghost" icon="trash" aria-label={mine ? 'Delete message' : 'Remove message'} disabled={!online} onClick={onDelete}>{mine ? 'Delete' : 'Remove'}</Button>}
      {!mine && added && added !== 'added' && added !== 'saving' && <Hint tone="danger" role="alert">{added}</Hint>}
    </div>}
    {(showTime || editNote) && <span className="mt-0.5 px-1 text-xs text-muted-foreground">{showTime && formatTime(time)}{showTime && editNote && ' · '}{editNote}</span>}
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

/** `filtered` shows the slur notice (every chat has the filter): the draft still sends, and the server stores it with the slur censored. */
function Composer({ chat, name, online, filtered = false }: { chat: ChatThread; name: string; online: boolean; filtered?: boolean }) {
  const [draft, setDraft] = useState(chat.initialDraft);
  const field = useRef<HTMLTextAreaElement>(null);
  const fine = useFinePointer();
  const normalized = normalizeBody(draft);
  const notice = filtered ? slurNotice(normalized) : null;
  const problem = bodyError(normalized);
  const left = CHAT.maxLength - normalized.length;
  const canSend = online && problem === null;

  // Grows with the text up to five lines (max-h-[7.5rem]).
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [draft]);

  const update = (text: string) => { setDraft(text); chat.saveDraft(text); };
  const submit = () => {
    if (!canSend) return;
    // Censored locally too, so the pending bubble never shows the slur while the send is out. Links stay whole, as the server stores them.
    chat.send(censorBody(normalized));
    update('');
    field.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends only with a mouse or trackpad; on touch it inserts a newline and the Send button sends.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229 || !finePointer()) return;
    event.preventDefault();
    submit();
  };

  return <form className="flex items-end gap-2 border-t border-foreground/[0.06] pt-2 pb-[max(8px,env(safe-area-inset-bottom))] lg:px-4 lg:pb-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <div className="grid min-w-0 flex-1 gap-1">
      <Textarea ref={field} aria-label={`Message ${name}`} rows={1} className="max-h-[7.5rem] min-h-10 resize-none text-base md:text-base" autoComplete="off" maxLength={COMPOSER_MAX_LENGTH}
        placeholder={online ? 'Message' : 'Offline'} disabled={!online} enterKeyHint={fine ? 'send' : 'enter'} value={draft}
        onChange={(event) => update(event.target.value)} onKeyDown={onKeyDown} />
      {notice && <Hint role="status" className="px-1">{notice}</Hint>}
      {left <= 100 && <Hint tone={left < 0 ? 'danger' : 'muted'} className="px-1">{left < 0 ? problem : `${left} left`}</Hint>}
    </div>
    <IconButton type="submit" label="Send" icon="send" variant="primary" disabled={!canSend} className="size-10 shrink-0 rounded-full" />
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

/**
 * Report a chat (latest CHAT.evidence messages), one message (the window around it), or a closed chat's row.
 * Closed rows have no block checkbox, because the chat is already closed.
 */
function ReportModal({ state, userId, name, mode, seq, onClose, onSent }: {
  state: AppState; userId: string; name: string; mode: 'chat' | 'message' | 'closed'; seq?: number;
  onClose: () => void; onSent: (blocked: boolean) => void;
}) {
  const [category, setCategory] = useState<ReportCategory | ''>('');
  const [note, setNote] = useState('');
  const [block, setBlock] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const crisisId = useId();
  const options = (Object.keys(REPORT_CATEGORIES) as ReportCategory[]).map((value) => ({ value, label: REPORT_CATEGORIES[value].label }));
  const send = async () => {
    if (!category) return;
    setPending(true); setError('');
    try {
      const result = await api.chat.report.mutate({ accountId: state.context.user.id, userId, category, note: note.trim(), ...(mode === 'message' && seq ? { seq } : {}), block: mode !== 'closed' && block });
      setPending(false);
      onSent(result.blocked);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={category !== '' || note.trim().length > 0}
    title={mode === 'message' ? 'Report message' : `Report ${name}`}
    description={mode === 'message' ? `Support sees your report, this message and the messages around it. ${name} isn’t told who reported.` : `Support sees your report and the last ${CHAT.evidence} messages in this chat. ${name} isn’t told who reported.`}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="danger" busy={pending} disabled={!category || !state.online} onClick={() => void send()}>Send report</Button></>}>
    <div className="grid gap-2">
      <span className="text-[13px] font-semibold text-foreground/80" aria-hidden="true">What’s wrong?</span>
      <Segmented<ReportCategory | ''> label="What’s wrong?" value={category} options={options} onChange={setCategory} className="w-full flex-col items-stretch *:pointer-coarse:h-11" />
    </div>
    {/* Announced when chosen, and read again with the note field, so a screen reader user can't miss it. */}
    {category === 'danger' && <div id={crisisId}><Callout tone="info" icon="info" role="status">If someone is in immediate danger, call 911. For crisis support, call or text 988.</Callout></div>}
    <Field label="Anything else? (optional)" htmlFor="chat-report-note"><Textarea id="chat-report-note" aria-describedby={category === 'danger' ? crisisId : undefined} maxLength={2000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
    {mode !== 'closed' && <div className="flex items-center gap-2.5">
      <Checkbox id="chat-report-block" checked={block} onCheckedChange={(value) => setBlock(value === true)} />
      <Label htmlFor="chat-report-block" className="font-medium">Also block {name}</Label>
    </div>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
