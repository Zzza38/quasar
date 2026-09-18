'use client';

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { signIn } from 'next-auth/react';
import { GoogleLogo } from './google-logo';
import { PanelLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceContext, View } from './app-state';
import { VIEWS } from './app-state';
import { Icon, Spinner, type IconName } from './icon';
import { AppearanceToggle, ThemePicker } from './theme-picker';
import { NotificationSettings } from './notification-settings';
import { Button, Callout, Hint, Modal, Panel, Spacer } from './primitives';
import { Avatar, AvatarFallback } from './ui/avatar';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';
import { Separator } from './ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger } from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import type { SyncState, WorkspaceSession } from './use-workspace';

const VIEW_ICONS: Record<View, IconName> = { today: 'home', schedule: 'calendar', tasks: 'tasks', classes: 'book', school: 'school' };
const NAV_KEY = 'quasar.navigationCollapsed';

export function Brand({ compact, className }: { compact?: boolean; className?: string }) {
  return <a className={cn('inline-flex items-center gap-2.5 text-[17px] font-bold tracking-tight text-foreground no-underline hover:no-underline', className)} href="#today" aria-label="Quasar home">
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"><Icon name="star" size={16} strokeWidth={2.2} /></span>
    {!compact && <span>Quasar</span>}
  </a>;
}

/* ---------- Sync status ---------- */

export function statusLabel(sync: SyncState): string {
  switch (sync.kind) {
    case 'saving': return 'Saving…';
    case 'syncing': return 'Syncing…';
    case 'conflict': return sync.count === 1 ? '1 change needs a choice' : `${sync.count} changes need a choice`;
    case 'failed': return 'Sync failed · saved on this device';
    case 'pending': return sync.count === 1 ? '1 change waiting to sync' : `${sync.count} changes waiting to sync`;
    case 'offline': return 'Offline · saved on this device';
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
  const classes = cn('h-auto max-w-full gap-1.5 whitespace-nowrap px-2.5 py-1.5 text-xs font-semibold', STATUS_TONES[tone], clickable && 'cursor-pointer hover:brightness-95', className);
  const inner = <>
    {sync.kind === 'saving' || sync.kind === 'syncing' ? <Spinner size={12} /> : <Icon name={icon} size={13} strokeWidth={2.2} />}
    <span className={cn('truncate', labelClassName)}>{label}</span>
  </>;
  if (clickable) {
    return <Badge asChild variant="secondary" className={classes}>
      <button type="button" aria-label={label} role="status" aria-live="polite" title={sync.kind === 'conflict' ? 'Review the changes that need a choice' : 'Retry now'} onClick={sync.kind === 'conflict' ? onConflicts : onRetry}>{inner}</button>
    </Badge>;
  }
  return <Badge variant="secondary" className={classes} aria-label={label} role="status" aria-live="polite">{inner}</Badge>;
}

/* ---------- Navigation ---------- */

function TabBar({ view, taskCount }: { view: View; taskCount: number }) {
  return <nav className="tabbar fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t bg-background/90 backdrop-blur-md lg:hidden" style={{ height: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }} aria-label="Main">
    {VIEWS.map((entry) => {
      const active = entry.id === view;
      return <a key={entry.id} href={`#${entry.id}`} aria-label={entry.label} title={entry.label} aria-current={active ? 'page' : undefined}
        className={cn('relative flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold no-underline transition-colors hover:no-underline', active ? 'text-primary' : 'text-muted-foreground')}>
        <Icon name={VIEW_ICONS[entry.id]} size={22} strokeWidth={active ? 2.2 : 1.9} />
        <span>{entry.label}</span>
        {entry.id === 'tasks' && taskCount > 0 && <span className="absolute left-[calc(50%+6px)] top-2 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] leading-none text-primary-foreground" aria-label={`${taskCount} open tasks`}>{taskCount > 99 ? '99+' : taskCount}</span>}
      </a>;
    })}
  </nav>;
}

function useNavigationOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try { setOpen(localStorage.getItem(NAV_KEY) !== 'true'); } catch { /* Storage may be unavailable. */ }
  }, []);
  const update = useCallback((next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(NAV_KEY, String(!next)); } catch { /* Keep the preference for this session. */ }
  }, []);
  return [open, update];
}

/* ---------- Shell ---------- */

export function Shell({ session, context, view, taskCount, children, gradeSettings }: { session: WorkspaceSession; context: WorkspaceContext; view: View; taskCount: number; children: ReactNode; gradeSettings?: ReactNode }) {
  const [account, setAccount] = useState(false);
  const [navOpen, setNavOpen] = useNavigationOpen();
  const { sync, online, snapshot } = session;
  const displayName = context.user.displayName || 'Your account';
  const initials = (context.user.displayName || context.user.email || 'Q').slice(0, 1).toUpperCase();
  const conflictsAnchor = () => { document.getElementById('conflicts')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const retry = () => void session.synchronize();

  // The tooltip provider lives here rather than in the server layout: a client
  // boundary directly under <body> made the prerendered page fail to hydrate.
  return <TooltipProvider><SidebarProvider open={navOpen} onOpenChange={setNavOpen} className="app" style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.5rem' } as CSSProperties}>
    <a className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg" href="#main">Skip to content</a>

    <Sidebar collapsible="icon" className="app-sidebar">
      <SidebarHeader className="flex-row items-center justify-between gap-2 px-3 pt-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
        {navOpen ? <>
          <Brand />
          <SidebarTrigger aria-label="Collapse navigation sidebar" aria-expanded title="Collapse navigation" className="text-muted-foreground" />
        </> : <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" aria-label="Open sidebar" aria-expanded={false} onClick={() => setNavOpen(true)}
              className="group/sidebar-open relative size-10 rounded-lg p-0 text-foreground hover:bg-muted">
              <span data-slot="sidebar-logo" className="flex group-hover/sidebar-open:hidden group-focus-visible/sidebar-open:hidden"><Icon name="star" size={22} className="size-[22px]" /></span>
              <span data-slot="sidebar-open-icon" className="hidden group-hover/sidebar-open:flex group-focus-visible/sidebar-open:flex"><PanelLeft aria-hidden="true" className="size-5" /></span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="rounded-full border bg-popover px-3 py-1.5 font-medium text-popover-foreground shadow-sm [&_svg]:hidden">Open sidebar</TooltipContent>
        </Tooltip>}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1" aria-label="Main">
              {VIEWS.map((entry) => {
                const active = entry.id === view;
                return <SidebarMenuItem key={entry.id}>
                  <SidebarMenuButton asChild isActive={active} tooltip={entry.label} className="h-10 gap-3 rounded-lg px-3 font-medium text-muted-foreground data-active:bg-primary-soft data-active:text-primary-soft-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:text-foreground group-data-[collapsible=icon]:data-active:bg-muted group-data-[collapsible=icon]:data-active:text-foreground group-data-[collapsible=icon]:[&_svg]:size-5">
                    <a href={`#${entry.id}`} aria-label={entry.label} aria-current={active ? 'page' : undefined}>
                      <Icon name={VIEW_ICONS[entry.id]} size={18} strokeWidth={active ? 2.2 : 1.9} />
                      <span className="group-data-[collapsible=icon]:hidden">{entry.label}</span>
                    </a>
                  </SidebarMenuButton>
                  {entry.id === 'tasks' && taskCount > 0 && <SidebarMenuBadge className="top-2.5 right-2.5 h-5 min-w-5 rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground" aria-label={`${taskCount} open tasks`}>{taskCount > 99 ? '99+' : taskCount}</SidebarMenuBadge>}
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
            <SidebarMenuButton size="lg" tooltip={displayName} onClick={() => setAccount(true)} aria-haspopup="dialog" className="h-12 rounded-xl border bg-card px-2 hover:bg-muted group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent">
              <Avatar><AvatarFallback className="bg-primary-soft font-bold text-primary-soft-foreground">{initials}</AvatarFallback></Avatar>
              <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden"><strong className="truncate text-sm">{displayName}</strong><span className="truncate text-xs text-muted-foreground">{context.school?.name ?? context.user.email}</span></span>
              <Icon name="more" size={16} className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset className="min-w-0">
      <header className="app-topbar sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-background/90 px-4 backdrop-blur-md lg:hidden">
        <Brand />
        <div className="flex items-center gap-2">
          <StatusPill sync={sync} online={online} onRetry={retry} onConflicts={conflictsAnchor} labelClassName="hidden min-[480px]:inline" />
          <button type="button" className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => setAccount(true)} aria-label="Account" aria-haspopup="dialog">
            <Avatar><AvatarFallback className="bg-primary-soft font-bold text-primary-soft-foreground">{initials}</AvatarFallback></Avatar>
          </button>
        </div>
      </header>
      <div className="app-main mx-auto w-full max-w-[1120px] px-4 pt-4 pb-[calc(var(--nav-h)+24px)] lg:px-8 lg:pt-6 lg:pb-10" id="main">
        <div className="mb-4 grid gap-3 empty:hidden">
          {session.error && <Callout tone="danger" icon="alert" role="alert" actions={<><Button size="sm" onClick={() => void session.initialize()} disabled={session.loading}>Try again</Button><Button size="sm" variant="ghost" onClick={session.dismissError}>Dismiss</Button></>}>{session.error}</Callout>}
          {!online && <Callout tone="neutral" icon="cloudOff" role="status">You’re offline. Schedule and task changes stay saved on this device until you reconnect.{!context.school && ' Connect to finish school setup.'}</Callout>}
          {online && session.offlineReady === false && <Callout tone="neutral" icon="info" actions={<Button size="sm" onClick={() => void session.prepareOffline()}>Retry offline setup</Button>}>Offline reopening is not ready yet. Keep this page open until setup finishes.</Callout>}
          {sync.kind === 'failed' && online && <Callout tone="warning" icon="alert" role="alert" title="Some changes could not sync" actions={<Button size="sm" busy={session.syncing} onClick={retry}>Retry now</Button>}>{sync.message} Your changes are saved on this device.</Callout>}
        </div>
        {children}
      </div>
      <TabBar view={view} taskCount={taskCount} />
    </SidebarInset>

    <Sheet open={account} onOpenChange={setAccount}>
      <SheetContent side="right" className="w-full gap-0 p-0 text-foreground sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-[17px]">Account</SheetTitle>
          <SheetDescription className="sr-only">Your profile, appearance, reminders and sign-out.</SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-5 overflow-y-auto px-5 py-5">
          <div className="flex items-center gap-3">
            <Avatar size="lg" className="size-12"><AvatarFallback className="bg-primary-soft text-lg font-bold text-primary-soft-foreground">{initials}</AvatarFallback></Avatar>
            <div className="min-w-0"><strong className="block truncate">{displayName}</strong><Hint className="truncate">{context.user.fullName}</Hint><Hint className="truncate">{context.user.email}</Hint></div>
          </div>
          <Panel className="grid gap-1.5 p-3 text-sm">
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">School</span><strong className="text-right">{context.school?.name ?? 'Not chosen yet'}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Sync</span><span className="text-right">{statusLabel(sync)}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Offline copy</span><span className="text-right">{session.offlineReady === true ? 'Ready on this device' : session.offlineReady === false ? 'Not ready' : 'Preparing…'}</span></div>
          </Panel>
          {gradeSettings}
          <ThemePicker />
          <Separator />
          <NotificationSettings accountId={context.user.id} online={online} />
          <Separator />
          <div className="grid gap-2">
            {context.isAdmin && <Button icon="inbox" onClick={() => { window.location.assign('/admin'); }}>Open support admin</Button>}
            <Button icon="logout" variant="secondary" disabled={session.logout.pending || !online || session.syncing || session.writing} title={!online ? 'Connect to the internet to sign out safely.' : undefined} onClick={() => { setAccount(false); session.requestLogout(); }}>Sign out</Button>
            {!online && <Hint>Signing out removes this account’s saved data from this device, so it needs a connection to make sure everything is uploaded first.</Hint>}
            {snapshot && snapshot.pending > 0 && online && <Hint>{snapshot.pending === 1 ? '1 change is' : `${snapshot.pending} changes are`} still waiting to sync. You will be asked what to do with them.</Hint>}
          </div>
        </div>
      </SheetContent>
    </Sheet>

    <Modal open={session.logout.asking} onClose={session.cancelLogout} title="Sync before signing out?" description="Signing out removes this account’s saved data from this device."
      footer={<><Button variant="ghost" disabled={session.logout.pending} onClick={session.cancelLogout}>Cancel</Button><Spacer /><Button variant="danger" disabled={session.logout.pending || !online || session.syncing} onClick={() => void session.finishLogout(true)}>Discard and sign out</Button><Button variant="primary" busy={session.logout.pending} disabled={!online || session.syncing || (snapshot?.conflicts.length ?? 0) > 0} onClick={() => void session.finishLogout(false)}>Sync and sign out</Button></>}>
      <p className="text-sm">{snapshot?.pending === 1 ? '1 change is' : `${snapshot?.pending ?? 0} changes are`} still waiting to sync.</p>
      {(snapshot?.conflicts.length ?? 0) > 0 && <Callout tone="warning" icon="alert">Some changes need a choice first. Resolve them, or discard everything waiting.</Callout>}
      {session.error && <Callout tone="danger" role="alert">{session.error}</Callout>}
    </Modal>
  </SidebarProvider></TooltipProvider>;
}

/* ---------- Loading / disconnected ---------- */

export function CenteredNotice({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="welcome-bg grid min-h-dvh place-items-center px-4 py-6">
    <Card className="w-full max-w-[420px]"><CardContent className="grid justify-items-center gap-3 text-center">
      <Brand />
      <h1 className="text-xl">{title}</h1>
      {children && <p className="text-sm text-muted-foreground">{children}</p>}
      {action}
    </CardContent></Card>
  </div>;
}

/* ---------- Welcome ---------- */

export function Welcome({ message }: { message?: string }) {
  return <main className="welcome-bg grid min-h-dvh place-items-center p-3 sm:px-4 sm:py-6">
    <Card className="w-full max-w-[1000px] animate-in fade-in-0 slide-in-from-bottom-1 duration-200 sm:py-8 md:py-12">
      <CardContent className="grid gap-8 sm:px-8 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:items-center md:px-12">
        <div className="grid justify-items-start gap-5">
          <div className="flex w-full items-center justify-between"><Brand /><AppearanceToggle /></div>
          <div className="grid gap-2">
            <h1 className="text-[34px] leading-[1.1]">Your next class and what’s due, at a glance.</h1>
            <p className="max-w-[42ch] text-[15px] text-muted-foreground">Quasar follows your school’s rotation, including odd days, lunch waves and closures, and keeps working offline.</p>
          </div>
          {message && <Callout tone="warning" icon="info" role="status">{message}</Callout>}
          <Button variant="primary" size="lg" className="gap-3" onClick={() => void signIn('google', { callbackUrl: '/' })}>
            <GoogleLogo />Continue with Google
          </Button>
          <ul className="grid gap-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2"><Icon name="clock" size={16} className="mt-0.5 text-primary" />What’s happening now, what’s next and how long is left.</li>
            <li className="flex items-start gap-2"><Icon name="layers" size={16} className="mt-0.5 text-primary" />Any rotation: A/B days, numbered cycles or a plain weekly bell schedule.</li>
            <li className="flex items-start gap-2"><Icon name="cloudOff" size={16} className="mt-0.5 text-primary" />Edits save on your device first and upload when you’re back online.</li>
          </ul>
        </div>
        <WelcomeArt />
      </CardContent>
    </Card>
  </main>;
}

function WelcomeArt() {
  return <div className="grid gap-3 rounded-2xl bg-muted p-5" aria-hidden="true">
    <div className="grid gap-2.5 rounded-xl p-4 text-white" style={{ background: 'linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 70%, #111))' }}>
      <div className="flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/80">Right now</span><span className="text-xs font-semibold text-white/90">Ends in 14 min</span></div>
      <strong className="text-2xl leading-tight">Chemistry</strong>
      <span className="text-sm text-white/85">10:50–11:40 AM · Period C · Room 214</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/25"><span className="block h-full w-[72%] rounded-full bg-white" /></div>
      <span className="text-sm text-white/85">Then <strong className="text-white">Lunch</strong> at 11:45 AM</span>
    </div>
    <div className="grid gap-1 rounded-xl border bg-card p-2.5">
      {[['11:45', 'Lunch', ''], ['12:15', 'US History', 'Room 305'], ['1:10', 'Algebra II', 'Room 101']].map(([time, name, room]) => <div key={time} className="flex items-center gap-2.5 px-2 py-1.5"><span className="w-12 text-sm tabular-nums text-muted-foreground">{time}</span><span className="w-1 min-h-[26px] self-stretch rounded-full bg-primary" /><span className="grid"><strong className="text-sm">{name}</strong>{room && <Hint>{room}</Hint>}</span></div>)}
    </div>
    <div className="flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5"><span className="size-[18px] rounded-md border-2 border-input" /><span className="text-sm">Lab report · due tomorrow</span></div>
  </div>;
}
