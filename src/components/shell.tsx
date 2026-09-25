'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { PanelLeft } from 'lucide-react';
import { cn, scrollToId } from '@/lib/utils';
import type { WorkspaceContext, View } from './app-state';
import { VIEWS } from './app-state';
import { viewPath } from '@/lib/routes';
import { SITE_TITLE } from '@/server/site';
import { Icon, Spinner, type IconName } from './icon';
import { ThemePicker } from './theme-picker';
import { NotificationSettings } from './notification-settings';
import { Button, Callout, Eyebrow, Hint, Modal, Spacer } from './primitives';
import { Avatar, AvatarFallback } from './ui/avatar';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger } from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import type { SyncState, WorkspaceSession } from './use-workspace';
import { OPEN_ACCOUNT_EVENT } from './setup-checklist';

const VIEW_ICONS: Record<View, IconName> = { today: 'home', schedule: 'calendar', tasks: 'tasks', classes: 'book', school: 'school', people: 'users', messages: 'message' };
const NAV_KEY = 'quasar.navigationCollapsed';
/** Ids of the hidden count descriptions the Tasks, People and Messages links point at with aria-describedby. */
const COUNT_IDS: Partial<Record<View, string>> = { tasks: 'nav-task-count', people: 'nav-request-count', messages: 'nav-chat-count' };
/** The pill every nav badge uses: the dock, the top-bar Messages link. */
const BADGE_PILL = 'grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground ring-2 ring-card';

function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Tapping the tab you are already on scrolls back to the top, as in most phone apps. */
function scrollTopIfActive(active: boolean) {
  if (active) window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/** A plain left click on a view link changes the view in place; modified clicks and middle clicks keep the browser's own behavior (a new tab). */
function followsInPage(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The Quasar mark: a flat Q that takes the current text colour, with the sparkle in the theme's primary colour. */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false" className={cn('shrink-0 select-none', className)} style={{ width: size, height: size }}>
    <g fill="none" stroke="currentColor" strokeWidth="9.5"><circle cx="30" cy="30" r="21" /><path d="M42 42 L54.5 54.5" /></g>
    <circle cx="54.5" cy="54.5" r="4.75" fill="currentColor" />
    <path d="M30 16.5 C31.4 25.8 34.2 28.6 43.5 30 C34.2 31.4 31.4 34.2 30 43.5 C28.6 34.2 25.8 31.4 16.5 30 C25.8 28.6 28.6 25.8 30 16.5 Z" fill="var(--primary)" />
  </svg>;
}

/** The stacked lockup (mark above the wordmark); swaps to a light wordmark in dark mode. */
export function BrandLockup({ height = 120, className }: { height?: number; className?: string }) {
  return <span aria-label="Quasar" role="img" className={cn('inline-block shrink-0 select-none', className)} style={{ height, aspectRatio: '940 / 920' }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/brand/quasar-full.svg" alt="" aria-hidden="true" draggable={false} className="h-full w-full dark:hidden" />
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/brand/quasar-full-dark.svg" alt="" aria-hidden="true" draggable={false} className="hidden h-full w-full dark:block" />
  </span>;
}

export function Brand({ compact, className, href = '/', onClick }: { compact?: boolean; className?: string; href?: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return <a className={cn('inline-flex items-center gap-2.5 text-[17px] font-extrabold tracking-tight text-foreground no-underline hover:no-underline', className)} href={href} onClick={onClick} aria-label="Quasar home">
    <BrandMark />
    {!compact && <span>Quasar</span>}
  </a>;
}

/** Gradient initial avatar shared by the sidebar, top bar and account sheet. */
function UserAvatar({ initials, size = 'default', className }: { initials: string; size?: 'default' | 'lg'; className?: string }) {
  return <Avatar size={size} className={cn('ring-0', className)}>
    <AvatarFallback className="font-extrabold text-primary-foreground" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 75%, white) 0%, var(--primary) 60%, color-mix(in srgb, var(--primary) 70%, black) 100%)' }}>{initials}</AvatarFallback>
  </Avatar>;
}

/* ---------- Sync status ---------- */

export function statusLabel(sync: SyncState): string {
  switch (sync.kind) {
    case 'saving': return 'Saving…';
    case 'syncing': return 'Syncing…';
    case 'conflict': return sync.count === 1 ? '1 change needs a choice' : `${sync.count} changes need a choice`;
    case 'failed': return 'Sync failed · saved on this device';
    case 'pending': return sync.count === 1 ? '1 change waiting to sync' : `${sync.count} changes waiting to sync`;
    case 'offline': return sync.pending === 1 ? 'Offline · 1 change waiting to sync' : sync.pending > 1 ? `Offline · ${sync.pending} changes waiting to sync` : 'Offline · saved on this device';
    case 'saved': return 'Saved';
  }
}

const STATUS_TONES = {
  success: 'bg-success-soft text-success',
  danger: 'bg-destructive/10 text-destructive',
  neutral: 'bg-secondary text-secondary-foreground',
  accent: 'bg-primary-soft text-primary-soft-foreground',
} as const;

export function StatusPill({ sync, online, onRetry, onConflicts, labelClassName, className }: { sync: SyncState; online: boolean; onRetry: () => void; onConflicts: () => void; labelClassName?: string; className?: string }) {
  const tone = sync.kind === 'saved' ? 'success' : sync.kind === 'failed' || sync.kind === 'conflict' ? 'danger' : sync.kind === 'offline' ? 'neutral' : 'accent';
  const icon: IconName = sync.kind === 'saved' ? 'checkCircle' : sync.kind === 'offline' ? 'cloudOff' : sync.kind === 'failed' || sync.kind === 'conflict' ? 'alert' : sync.kind === 'pending' ? 'cloud' : 'refresh';
  const label = statusLabel(sync);
  const clickable = sync.kind === 'conflict' || sync.kind === 'failed' || (sync.kind === 'pending' && online);
  const classes = cn('h-auto max-w-full gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-bold', STATUS_TONES[tone], clickable && 'cursor-pointer hover:brightness-95', className);
  const inner = <>
    {sync.kind === 'saving' || sync.kind === 'syncing' ? <Spinner size={12} /> : <Icon name={icon} size={13} strokeWidth={2.4} />}
    <span className={cn('truncate', labelClassName)}>{label}</span>
  </>;
  // Announcements come from the one live region in Shell (the pill renders twice and remounts when it
  // becomes clickable), so the pill itself stays quiet: a plain button when it acts, a silent status otherwise.
  if (clickable) {
    return <Badge asChild variant="secondary" className={classes}>
      <button type="button" aria-label={`${label}. ${sync.kind === 'conflict' ? 'Review' : 'Retry now'}`} title={sync.kind === 'conflict' ? 'Review the changes that need a choice' : 'Retry now'} onClick={sync.kind === 'conflict' ? onConflicts : onRetry}>{inner}</button>
    </Badge>;
  }
  return <Badge variant="secondary" className={classes} aria-label={label} role="status" aria-live="off">{inner}</Badge>;
}

/* ---------- Navigation ---------- */

interface NavCounts { taskCount: number; requestCount: number; chatCount: number }

/** The count a nav entry's badge shows, or 0 for none. */
function badgeCount(id: View, { taskCount, requestCount, chatCount }: NavCounts): number {
  return id === 'tasks' ? taskCount : id === 'people' ? requestCount : id === 'messages' ? chatCount : 0;
}

/** The six-tab phone dock. Messages lives in the top bar instead (`dock: false`). */
function TabBar({ view, counts, navigate }: { view: View; counts: NavCounts; navigate: (view: View) => void }) {
  return <nav className="tabbar fixed inset-x-0 bottom-0 z-30 lg:hidden" style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }} aria-label="Main">
    <div className="glass mx-3 grid auto-cols-fr grid-flow-col rounded-[22px] p-1.5 shadow-float ring-1 ring-foreground/[0.08]">
      {VIEWS.filter((entry) => entry.dock !== false).map((entry) => {
        const active = entry.id === view;
        const count = badgeCount(entry.id, counts);
        return <a key={entry.id} href={`#${entry.id}`} aria-label={entry.label} aria-describedby={count > 0 ? COUNT_IDS[entry.id] : undefined} title={entry.label} aria-current={active ? 'page' : undefined}
          onClick={() => scrollTopIfActive(active)}
          className={cn('relative flex flex-col items-center justify-center gap-0.5 rounded-2xl py-1.5 text-[10.5px] font-bold no-underline transition-colors hover:no-underline', active ? 'bg-primary-soft text-primary-soft-foreground' : 'text-muted-foreground')}>
          <Icon name={VIEW_ICONS[entry.id]} size={21} strokeWidth={active ? 2.4 : 2} />
          <span>{entry.label}</span>
          {count > 0 && <span aria-hidden="true" className={cn('absolute left-[calc(50%+6px)] top-0.5', BADGE_PILL)}>{badgeText(count)}</span>}
        </a>;
      })}
    </div>
  </nav>;
}

function useNavigationOpen(): [boolean, (open: boolean) => void] {
  // The server renders the sidebar open (it cannot see this device's preference); the saved choice is applied in a
  // layout effect, before the first interactive frame, so the HTML and its hydration agree.
  const [open, setOpen] = useState(true);
  useLayoutEffect(() => {
    try { setOpen(localStorage.getItem(NAV_KEY) !== 'true'); } catch { /* Storage may be unavailable. */ }
  }, []);
  const update = useCallback((next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(NAV_KEY, String(!next)); } catch { /* Keep the preference for this session. */ }
  }, []);
  return [open, update];
}

/* ---------- Shell ---------- */

export interface ShellProps {
  session: WorkspaceSession;
  context: WorkspaceContext;
  view: View;
  navigate: (view: View) => void;
  taskCount: number;
  /** Unread chats for the Messages badges; null while offline, which hides both badges. */
  chatUnread: number | null;
  /** A phone chat thread: no dock, and the main area becomes a fixed-height column sized by `--chat-h`. */
  immersive: boolean;
  /** The account-wide "Message notifications" switch. */
  chatPush: boolean;
  onChatPush: (enabled: boolean) => Promise<void>;
  children: ReactNode;
  gradeSettings?: ReactNode;
}

export function Shell({ session, context, view, navigate, taskCount, chatUnread, immersive, chatPush, onChatPush, children, gradeSettings }: ShellProps) {
  const home = (event: MouseEvent<HTMLAnchorElement>) => { if (!followsInPage(event)) return; event.preventDefault(); if (view === 'today') scrollTopIfActive(true); else navigate('today'); };
  const [account, setAccount] = useState(false);
  useEffect(() => {
    const open = () => setAccount(true);
    window.addEventListener(OPEN_ACCOUNT_EVENT, open);
    return () => window.removeEventListener(OPEN_ACCOUNT_EVENT, open);
  }, []);
  const [navOpen, setNavOpen] = useNavigationOpen();
  const { sync, online, snapshot } = session;
  const requestCount = context.community?.incomingRequests ?? 0;
  // Offline (null) hides the chat badges so a stale count never looks current.
  const chatCount = online ? chatUnread ?? 0 : 0;
  const counts: NavCounts = { taskCount, requestCount, chatCount };
  const onMessages = view === 'messages';
  const chatCountId = chatCount > 0 ? COUNT_IDS.messages : undefined;
  const displayName = context.user.displayName || 'Your account';
  const initials = (context.user.displayName || context.user.email || 'Q').slice(0, 1).toUpperCase();
  const conflictsAnchor = () => scrollToId('conflicts', true);
  const retry = () => void session.synchronize();
  // Keep the workspace tab named Quasar. After a view change (not the first render), move focus to the
  // view's heading so screen readers announce the page. A dialog or field the view focused itself wins.
  const shownView = useRef<View | null>(null);
  useEffect(() => {
    document.title = 'Quasar';
    const previous = shownView.current;
    shownView.current = view;
    if (!previous || previous === view) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.closest('#main, [role="dialog"], [role="alertdialog"]')) return;
    const main = document.getElementById('main');
    const target = main?.querySelector<HTMLElement>('h1') ?? main;
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.classList.add('outline-none');
    target.focus({ preventScroll: true });
  }, [view]);
  useEffect(() => () => { document.title = window.location.pathname === '/' ? SITE_TITLE : 'Quasar'; }, []);

  const skipToMain = (event: MouseEvent<HTMLAnchorElement>) => {
    // #main is not a route; changing the hash would open Today.
    event.preventDefault();
    document.getElementById('main')?.focus();
  };

  // The tooltip provider lives here rather than in the server layout: a client
  // boundary directly under <body> made the prerendered page fail to hydrate.
  return <TooltipProvider><SidebarProvider open={navOpen} onOpenChange={setNavOpen} className="app app-canvas" style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.5rem' } as CSSProperties}>
    <a className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg" href="#main" onClick={skipToMain}>Skip to content</a>
    {/* The single live region for sync status: the visible pills are hidden at one breakpoint or the other. */}
    <span role="status" aria-live="polite" className="sr-only">{statusLabel(sync)}</span>
    {taskCount > 0 && <span id={COUNT_IDS.tasks} hidden>{taskCount === 1 ? '1 open task' : `${taskCount} open tasks`}</span>}
    {requestCount > 0 && <span id={COUNT_IDS.people} hidden>{requestCount === 1 ? '1 friend request' : `${requestCount} friend requests`}</span>}
    {chatCount > 0 && <span id={COUNT_IDS.messages} hidden>{chatCount === 1 ? '1 unread chat' : `${chatCount} unread chats`}</span>}

    <Sidebar collapsible="icon" className="app-sidebar">
      <SidebarHeader className="flex-row items-center justify-between gap-2 px-3 pt-4 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
        {navOpen ? <>
          <Brand onClick={home} />
          <SidebarTrigger aria-label="Collapse navigation sidebar" aria-expanded title="Collapse navigation" className="rounded-lg text-muted-foreground hover:bg-sidebar-accent" />
        </> : <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" aria-label="Open sidebar" aria-expanded={false} onClick={() => setNavOpen(true)}
              className="group/sidebar-open relative size-10 rounded-xl p-0 text-foreground hover:bg-sidebar-accent">
              <span data-slot="sidebar-logo" className="flex group-hover/sidebar-open:hidden group-focus-visible/sidebar-open:hidden"><BrandMark size={30} /></span>
              <span data-slot="sidebar-open-icon" className="hidden group-hover/sidebar-open:flex group-focus-visible/sidebar-open:flex"><PanelLeft aria-hidden="true" className="size-5" /></span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="rounded-full border bg-popover px-3 py-1.5 font-semibold text-popover-foreground shadow-float">Open sidebar</TooltipContent>
        </Tooltip>}
      </SidebarHeader>
      <SidebarContent className="pt-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1" aria-label="Main">
              {VIEWS.map((entry) => {
                const active = entry.id === view;
                const count = badgeCount(entry.id, counts);
                return <SidebarMenuItem key={entry.id}>
                  <SidebarMenuButton asChild isActive={active} tooltip={entry.label} className="h-10 gap-3 rounded-xl px-3 text-[14px] font-semibold text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-active:bg-primary-soft data-active:text-primary-soft-foreground data-active:hover:bg-primary-soft data-active:hover:text-primary-soft-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:text-foreground group-data-[collapsible=icon]:[&_svg]:size-5">
                    <a href={`#${entry.id}`} aria-label={entry.label} aria-describedby={count > 0 ? COUNT_IDS[entry.id] : undefined} aria-current={active ? 'page' : undefined} onClick={() => scrollTopIfActive(active)}>
                      <Icon name={VIEW_ICONS[entry.id]} size={18} strokeWidth={active ? 2.4 : 2} />
                      <span className="group-data-[collapsible=icon]:hidden">{entry.label}</span>
                    </a>
                  </SidebarMenuButton>
                  {count > 0 && <SidebarMenuBadge aria-hidden="true" className="top-1/2! right-2.5 h-5 min-w-5 -translate-y-1/2 rounded-full bg-primary px-1.5 text-[11px] leading-none font-bold text-primary-foreground! tabular-nums">{badgeText(count)}</SidebarMenuBadge>}
                </SidebarMenuItem>;
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3 px-3 pb-4 group-data-[collapsible=icon]:px-2">
        <div className="flex group-data-[collapsible=icon]:justify-center">
          <StatusPill sync={sync} online={online} onRetry={retry} onConflicts={conflictsAnchor} labelClassName="group-data-[collapsible=icon]:hidden" className="group-data-[collapsible=icon]:px-1.5" />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip={displayName} onClick={() => setAccount(true)} aria-haspopup="dialog" className="h-14 rounded-2xl bg-card px-2.5 shadow-card ring-1 ring-foreground/[0.06] hover:bg-muted group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-full group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none group-data-[collapsible=icon]:ring-0">
              <UserAvatar initials={initials} />
              <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden"><strong className="truncate text-[13.5px] font-bold">{displayName}</strong><span className="truncate text-xs text-muted-foreground">{context.school?.name ?? context.user.email}</span></span>
              <Icon name="settings" size={16} className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset className="min-w-0 bg-transparent">
      <header className="app-topbar glass sticky top-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center justify-between gap-3 border-b border-foreground/[0.06] pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] lg:hidden">
        <Brand onClick={home} />
        <div className="flex items-center gap-2">
          <StatusPill sync={sync} online={online} onRetry={retry} onConflicts={conflictsAnchor} labelClassName="hidden min-[480px]:inline" />
          {/* Messages is not in the six-tab dock on phones; this link reaches it from every view. No title:
              it would become the accessible description whenever there is no unread count. */}
          <a href="#messages" aria-label="Messages" aria-describedby={chatCountId} aria-current={onMessages ? 'page' : undefined} onClick={() => scrollTopIfActive(onMessages && !immersive)}
            className={cn('relative grid size-10 shrink-0 place-items-center rounded-full no-underline outline-none transition-colors hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background', onMessages ? 'bg-primary-soft text-primary-soft-foreground' : 'text-foreground hover:bg-muted')}>
            <Icon name="message" size={21} strokeWidth={onMessages ? 2.4 : 2} />
            {chatCount > 0 && <span aria-hidden="true" className={cn('absolute -right-0.5 -top-0.5', BADGE_PILL)}>{badgeText(chatCount)}</span>}
          </a>
          <button type="button" className="grid size-10 shrink-0 place-items-center rounded-full outline-none pointer-coarse:size-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" onClick={() => setAccount(true)} aria-label="Account" aria-haspopup="dialog">
            <UserAvatar initials={initials} />
          </button>
        </div>
      </header>
      {/* On Messages the desktop main area is a viewport-high column so only the list and the log scroll.
          A phone thread (immersive) is a fixed-height column sized to the visual viewport by useChatViewport. */}
      <div className={cn('app-main mx-auto w-full max-w-[1120px] px-4 pt-5 outline-none lg:px-8 lg:pt-8',
        immersive ? 'flex flex-col pb-0 max-lg:h-[var(--chat-h,calc(100dvh_-_3.5rem))]' : 'pb-[calc(var(--nav-h)+28px)]',
        onMessages ? 'lg:flex lg:h-dvh lg:flex-col lg:pb-8' : 'lg:pb-12')} id="main" tabIndex={-1}>
        <div className="mb-4 grid shrink-0 gap-3 empty:hidden">
          {session.error && <Callout tone="danger" icon="alert" role="alert" actions={<><Button size="sm" onClick={() => void session.initialize()} disabled={session.loading}>Try again</Button><Button size="sm" variant="ghost" onClick={session.dismissError}>Dismiss</Button></>}>{session.error}</Callout>}
          {/* Messages shows its own offline callout; two stacked banners would crowd a phone thread. */}
          {!online && !onMessages && <Callout tone="neutral" icon="cloudOff" role="status">You’re offline. Schedule and task changes stay saved on this device until you reconnect.{!context.school && ' Connect to finish school setup.'}</Callout>}
          {online && session.offlineReady === false && session.offlineSupported && <Callout tone="neutral" icon="info" actions={<Button size="sm" onClick={() => void session.prepareOffline()}>Try again</Button>}>Quasar couldn’t save itself to this device, so it may not open without signal.</Callout>}
          {sync.kind === 'failed' && online && <Callout tone="warning" icon="alert" role="alert" title="Some changes could not sync" actions={<Button size="sm" busy={session.syncing} onClick={retry}>Retry now</Button>}>{sync.message} Your changes are saved on this device.</Callout>}
        </div>
        {children}
      </div>
      {!immersive && <TabBar view={view} counts={counts} navigate={navigate} />}
    </SidebarInset>

    <Sheet open={account} onOpenChange={setAccount}>
      {/* data-[side=right]: prefixes so these beat the sheet's own w-3/4 and sm:max-w-sm (full width on phones). */}
      <SheetContent side="right" className="gap-0 border-l-0 p-0 text-foreground shadow-pop data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-[17px] font-bold">Account</SheetTitle>
          <SheetDescription className="sr-only">Your profile, appearance, notifications and sign-out.</SheetDescription>
        </SheetHeader>
        {/* auto-rows-max: the summary hides its overflow, so without it the rows would share the fixed height and clip instead of scrolling. */}
        <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] content-start gap-6 overflow-y-auto px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-3.5">
            <UserAvatar initials={initials} size="lg" className="size-14 text-xl" />
            <div className="min-w-0"><strong className="block truncate text-[16px] font-bold">{displayName}</strong><Hint className="truncate">{context.user.fullName}</Hint><Hint className="truncate">{context.user.email}</Hint></div>
          </div>
          <dl className="grid shrink-0 overflow-hidden rounded-2xl bg-muted/80 text-sm ring-1 ring-inset ring-foreground/[0.04] *:flex *:items-center *:justify-between *:gap-3 *:px-4 *:py-2.5 *:not-first:border-t *:not-first:border-foreground/[0.05]">
            <div><dt className="text-muted-foreground">School</dt><dd className="text-right font-semibold">{context.school?.name ?? 'Not chosen yet'}</dd></div>
            {context.school && <div><dt className="text-muted-foreground">Verification</dt><dd className="text-right font-semibold">{context.community?.verification.status === 'verified' ? 'Verified' : context.community?.verification.status === 'pending' ? 'Under review' : 'Not verified'}</dd></div>}
            <div><dt className="text-muted-foreground">Sync</dt><dd className="text-right font-semibold">{statusLabel(sync)}</dd></div>
            <div><dt className="text-muted-foreground">Works offline</dt><dd className="text-right font-semibold">{session.offlineReady === true ? 'Yes, on this device' : session.offlineReady === null ? 'Getting ready…' : session.offlineSupported ? 'Not yet' : 'Not in this browser'}</dd></div>
            {session.storagePersistent === false && <div><dt className="text-muted-foreground">Device storage</dt><dd className="text-right font-semibold">The browser may clear it if space runs low</dd></div>}
          </dl>
          {gradeSettings && <div className="grid gap-3"><Eyebrow>School</Eyebrow>{gradeSettings}</div>}
          <div className="grid gap-3"><Eyebrow>Look</Eyebrow><ThemePicker /></div>
          <div className="grid gap-3"><Eyebrow>Notifications</Eyebrow><NotificationSettings accountId={context.user.id} online={online} chatPush={chatPush} onChatPush={onChatPush} /></div>
          <div className="grid gap-2 border-t pt-5">
            <Button icon="info" onClick={() => { window.location.assign('/help'); }}>Help and FAQ</Button>
            {context.isAdmin && <Button icon="inbox" onClick={() => { window.location.assign('/admin'); }}>Open support admin</Button>}
            <Button icon="logout" variant="secondary" disabled={session.logout.pending || !online || session.writing} title={!online ? 'Connect to the internet to sign out safely.' : undefined} onClick={() => { setAccount(false); session.requestLogout(); }}>Sign out</Button>
            {!online && <Hint>Signing out removes this account’s saved data from this device, so it needs a connection to make sure everything is uploaded first.</Hint>}
            {snapshot && snapshot.pending > 0 && online && <Hint>{snapshot.pending === 1 ? '1 change is' : `${snapshot.pending} changes are`} still waiting to sync. You will be asked what to do with them.</Hint>}
          </div>
        </div>
      </SheetContent>
    </Sheet>

    <LogoutDialog session={session} />
  </SidebarProvider></TooltipProvider>;
}

/**
 * "Sync before signing out?" for a sign-out requested while changes are waiting. Every signed-in
 * screen renders it (the shell and each setup step), so requestLogout never sets a flag nothing shows.
 */
export function LogoutDialog({ session }: { session: WorkspaceSession }) {
  const { online, snapshot } = session;
  return <Modal open={session.logout.asking} onClose={session.cancelLogout} busy={session.logout.pending} title="Sync before signing out?" description="Signing out removes this account’s saved data from this device."
    footer={<><Button variant="ghost" disabled={session.logout.pending} onClick={session.cancelLogout}>Cancel</Button><Spacer /><Button variant="danger" disabled={session.logout.pending || !online} onClick={() => void session.finishLogout(true)}>Discard and sign out</Button><Button variant="primary" busy={session.logout.pending} disabled={!online || (snapshot?.conflicts.length ?? 0) > 0} onClick={() => void session.finishLogout(false)}>Sync and sign out</Button></>}>
    <p className="text-sm">{snapshot?.pending === 1 ? '1 change is' : `${snapshot?.pending ?? 0} changes are`} still waiting to sync.</p>
    {(snapshot?.conflicts.length ?? 0) > 0 && <Callout tone="warning" icon="alert">Some changes need a choice first. Resolve them, or discard everything waiting.</Callout>}
    {session.error && <Callout tone="danger" role="alert">{session.error}</Callout>}
  </Modal>;
}

/* ---------- Loading / disconnected ---------- */

export function CenteredNotice({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="welcome-bg grid min-h-dvh place-items-center px-4 py-6">
    <Card className="w-full max-w-[420px] rounded-3xl shadow-float animate-in fade-in-0 zoom-in-95 duration-300"><CardContent className="grid justify-items-center gap-4 py-4 text-center">
      <BrandLockup height={112} />
      <div className="grid gap-1.5">
        <h1 className="text-xl">{title}</h1>
        {children && <p className="text-sm text-muted-foreground">{children}</p>}
      </div>
      {action}
    </CardContent></Card>
  </div>;
}
