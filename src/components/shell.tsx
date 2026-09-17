'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { signIn } from 'next-auth/react';
import type { WorkspaceContext, View } from './app-state';
import { VIEWS } from './app-state';
import { Icon, type IconName } from './icon';
import { AppearanceToggle, ThemePicker } from './theme-picker';
import { NotificationSettings } from './notification-settings';
import { Button, Callout, IconButton, Sheet } from './ui';
import type { SyncState, WorkspaceSession } from './use-workspace';

const VIEW_ICONS: Record<View, IconName> = { today: 'home', schedule: 'calendar', tasks: 'tasks', classes: 'book', school: 'school' };

export function Brand({ compact }: { compact?: boolean }) {
  return <a className="brand" href="#today" aria-label="Quasar home">
    <span className="brand-mark"><Icon name="star" size={compact ? 16 : 18} strokeWidth={2.2} /></span>
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
    case 'offline': return sync.ready === false ? 'Offline · saved on this device' : 'Offline · saved on this device';
    case 'saved': return 'Saved';
  }
}

export function StatusPill({ sync, online, onRetry, onConflicts, compact }: { sync: SyncState; online: boolean; onRetry: () => void; onConflicts: () => void; compact?: boolean }) {
  const tone = sync.kind === 'saved' ? 'success' : sync.kind === 'failed' || sync.kind === 'conflict' ? 'danger' : sync.kind === 'offline' ? 'neutral' : 'accent';
  const icon: IconName = sync.kind === 'saved' ? 'checkCircle' : sync.kind === 'offline' ? 'cloudOff' : sync.kind === 'failed' ? 'alert' : sync.kind === 'conflict' ? 'alert' : sync.kind === 'pending' ? 'cloud' : 'refresh';
  const label = statusLabel(sync);
  const clickable = sync.kind === 'conflict' || sync.kind === 'failed' || (sync.kind === 'pending' && online);
  const inner = <>
    {sync.kind === 'saving' || sync.kind === 'syncing' ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} aria-hidden="true" /> : <Icon name={icon} size={13} strokeWidth={2.2} />}
    <span className={compact ? 'status-text' : undefined}>{label}</span>
  </>;
  if (clickable) {
    return <button type="button" className={`status-pill status-${tone}`} aria-label={label} role="status" aria-live="polite" title={sync.kind === 'conflict' ? 'Review the changes that need a choice' : 'Retry now'} onClick={sync.kind === 'conflict' ? onConflicts : onRetry}>{inner}</button>;
  }
  return <span className={`status-pill status-${tone}`} aria-label={label} role="status" aria-live="polite">{inner}</span>;
}

/* ---------- Navigation ---------- */

function NavLinks({ view, taskCount, className }: { view: View; taskCount: number; className: string }) {
  return <>{VIEWS.map((entry) => <a key={entry.id} href={`#${entry.id}`} className={className} aria-label={entry.label} title={entry.label} aria-current={entry.id === view ? 'page' : undefined}>
    <Icon name={VIEW_ICONS[entry.id]} size={className === 'side-link' ? 18 : 22} strokeWidth={entry.id === view ? 2.2 : 1.9} />
    <span>{entry.label}</span>
    {entry.id === 'tasks' && taskCount > 0 && <span className="nav-badge" aria-label={`${taskCount} open tasks`}>{taskCount > 99 ? '99+' : taskCount}</span>}
  </a>)}</>;
}

/* ---------- Shell ---------- */

export function Shell({ session, context, view, taskCount, children }: { session: WorkspaceSession; context: WorkspaceContext; view: View; taskCount: number; children: ReactNode }) {
  const [account, setAccount] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    try { setSidebarCollapsed(localStorage.getItem('quasar.navigationCollapsed') === 'true'); } catch { /* Storage may be unavailable. */ }
  }, []);
  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try { localStorage.setItem('quasar.navigationCollapsed', String(next)); } catch { /* Keep the preference for this session. */ }
  };
  const { sync, online, snapshot } = session;
  const initials = (context.user.displayName || context.user.email || 'Q').slice(0, 1).toUpperCase();
  const conflictsAnchor = () => { document.getElementById('conflicts')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return <div className={`app${sidebarCollapsed ? ' app-nav-collapsed' : ''}`}>
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="app-sidebar" id="app-navigation">
      <IconButton className="app-sidebar-toggle" size="sm" icon={sidebarCollapsed ? 'chevronRight' : 'chevronLeft'} label={sidebarCollapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="app-navigation" onClick={toggleSidebar} />
      <div className="px-2 pb-4"><Brand compact={sidebarCollapsed} /></div>
      <nav aria-label="Main"><NavLinks view={view} taskCount={taskCount} className="side-link" /></nav>
      <div className="mt-auto grid gap-3">
        <StatusPill sync={sync} online={online} onRetry={() => void session.synchronize()} onConflicts={conflictsAnchor} />
        <button type="button" className="account-button" aria-label={context.user.displayName || 'Your account'} title={context.user.displayName || 'Your account'} onClick={() => setAccount(true)} aria-haspopup="dialog">
          <span className="avatar">{initials}</span>
          <span className="min-w-0 text-left grid"><strong className="truncate text-sm">{context.user.displayName || 'Your account'}</strong><small className="truncate hint">{context.school?.name ?? context.user.email}</small></span>
          <Icon name="more" size={16} className="text-text-3 ml-auto" />
        </button>
      </div>
    </aside>
    <div className="app-main" id="main">
      <div className="app-topbar">
        <Brand />
        <div className="flex items-center gap-2">
          <StatusPill sync={sync} online={online} compact onRetry={() => void session.synchronize()} onConflicts={conflictsAnchor} />
          <button type="button" className="avatar avatar-button" onClick={() => setAccount(true)} aria-label="Account" aria-haspopup="dialog">{initials}</button>
        </div>
      </div>
      <div className="grid gap-3 mb-4 empty:hidden">
        {session.error && <Callout tone="danger" icon="alert" role="alert" actions={<><Button size="sm" onClick={() => void session.initialize()} disabled={session.loading}>Try again</Button><Button size="sm" variant="ghost" onClick={session.dismissError}>Dismiss</Button></>}>{session.error}</Callout>}
        {!online && <Callout tone="neutral" icon="cloudOff" role="status">You’re offline. Schedule and task changes stay saved on this device until you reconnect.{!context.school && ' Connect to finish school setup.'}</Callout>}
        {online && session.offlineReady === false && <Callout tone="neutral" icon="info" actions={<Button size="sm" onClick={() => void session.prepareOffline()}>Retry offline setup</Button>}>Offline reopening is not ready yet. Keep this page open until setup finishes.</Callout>}
        {sync.kind === 'failed' && online && <Callout tone="warning" icon="alert" role="alert" title="Some changes could not sync" actions={<Button size="sm" busy={session.syncing} onClick={() => void session.synchronize()}>Retry now</Button>}>{sync.message} Your changes are saved on this device.</Callout>}
      </div>
      {children}
    </div>
    <nav className="tabbar" aria-label="Main"><NavLinks view={view} taskCount={taskCount} className="tab-link" /></nav>

    <Sheet open={account} onClose={() => setAccount(false)} title="Account">
      <div className="flex items-center gap-3">
        <span className="avatar avatar-lg">{initials}</span>
        <div className="min-w-0"><strong className="block truncate">{context.user.displayName || 'Your account'}</strong><span className="hint block truncate">{context.user.fullName}</span><span className="hint block truncate">{context.user.email}</span></div>
      </div>
      <div className="panel p-3 grid gap-1 text-sm">
        <div className="flex justify-between gap-3"><span className="text-text-2">School</span><strong className="text-right">{context.school?.name ?? 'Not chosen yet'}</strong></div>
        <div className="flex justify-between gap-3"><span className="text-text-2">Sync</span><span className="text-right">{statusLabel(sync)}</span></div>
        <div className="flex justify-between gap-3"><span className="text-text-2">Offline copy</span><span className="text-right">{session.offlineReady === true ? 'Ready on this device' : session.offlineReady === false ? 'Not ready' : 'Preparing…'}</span></div>
      </div>
      <ThemePicker />
      <hr className="divider" />
      <NotificationSettings accountId={context.user.id} online={online} />
      <hr className="divider" />
      <div className="grid gap-2">
        {context.isAdmin && <Button icon="inbox" onClick={() => { window.location.assign('/admin'); }}>Open support admin</Button>}
        <Button icon="logout" variant="secondary" disabled={session.logout.pending || !online || session.syncing || session.writing} title={!online ? 'Connect to the internet to sign out safely.' : undefined} onClick={() => { setAccount(false); session.requestLogout(); }}>Sign out</Button>
        {!online && <p className="hint">Signing out removes this account’s saved data from this device, so it needs a connection to make sure everything is uploaded first.</p>}
        {snapshot && snapshot.pending > 0 && online && <p className="hint">{snapshot.pending === 1 ? '1 change is' : `${snapshot.pending} changes are`} still waiting to sync. You will be asked what to do with them.</p>}
      </div>
    </Sheet>

    <Sheet open={session.logout.asking} onClose={session.cancelLogout} title="Sync before signing out?" description="Signing out removes this account’s saved data from this device."
      footer={<><Button variant="ghost" disabled={session.logout.pending} onClick={session.cancelLogout}>Cancel</Button><span className="spacer" /><Button variant="danger" disabled={session.logout.pending || !online || session.syncing} onClick={() => void session.finishLogout(true)}>Discard and sign out</Button><Button variant="primary" busy={session.logout.pending} disabled={!online || session.syncing || (snapshot?.conflicts.length ?? 0) > 0} onClick={() => void session.finishLogout(false)}>Sync and sign out</Button></>}>
      <p className="text-sm">{snapshot?.pending === 1 ? '1 change is' : `${snapshot?.pending ?? 0} changes are`} still waiting to sync.</p>
      {(snapshot?.conflicts.length ?? 0) > 0 && <Callout tone="warning" icon="alert">Some changes need a choice first. Resolve them, or discard everything waiting.</Callout>}
      {session.error && <p className="callout callout-danger" role="alert">{session.error}</p>}
    </Sheet>
  </div>;
}

/* ---------- Loading / disconnected ---------- */

export function CenteredNotice({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="welcome"><div className="card card-pad grid gap-3 w-full max-w-[420px] text-center justify-items-center">
    <Brand />
    <h1 className="text-[20px]">{title}</h1>
    {children && <p className="text-sm text-text-2">{children}</p>}
    {action}
  </div></div>;
}

/* ---------- Welcome ---------- */

export function Welcome({ message }: { message?: string }) {
  return <main className="welcome">
    <div className="welcome-card fade-in">
      <div className="grid gap-5 justify-items-start">
        <div className="flex items-center justify-between w-full"><Brand /><AppearanceToggle /></div>
        <div className="grid gap-2">
          <h1 className="text-[34px] leading-[1.1]">Your next class and what’s due, at a glance.</h1>
          <p className="text-text-2 text-[15px] max-w-[42ch]">Quasar follows your school’s rotation, including odd days, lunch waves and closures, and keeps working offline.</p>
        </div>
        {message && <Callout tone="warning" icon="info" role="status">{message}</Callout>}
        <Button variant="primary" size="lg" className="google-button" onClick={() => void signIn('google', { callbackUrl: '/' })}>
          <span className="google-g" aria-hidden="true">G</span>Continue with Google
        </Button>
        <ul className="grid gap-2 text-sm text-text-2">
          <li className="flex gap-2 items-start"><Icon name="clock" size={16} className="mt-0.5 text-accent" />What’s happening now, what’s next and how long is left.</li>
          <li className="flex gap-2 items-start"><Icon name="layers" size={16} className="mt-0.5 text-accent" />Any rotation: A/B days, numbered cycles or a plain weekly bell schedule.</li>
          <li className="flex gap-2 items-start"><Icon name="cloudOff" size={16} className="mt-0.5 text-accent" />Edits save on your device first and upload when you’re back online.</li>
        </ul>
      </div>
      <WelcomeArt />
    </div>
  </main>;
}

function WelcomeArt() {
  return <div className="welcome-art" aria-hidden="true">
    <div className="mock-card">
      <div className="flex items-center justify-between"><span className="eyebrow" style={{ color: 'rgb(255 255 255 / .8)' }}>Right now</span><span className="text-xs font-semibold" style={{ color: 'rgb(255 255 255 / .9)' }}>Ends in 14 min</span></div>
      <strong className="text-[24px] leading-tight">Chemistry</strong>
      <span className="text-sm" style={{ color: 'rgb(255 255 255 / .85)' }}>10:50–11:40 AM · Period C · Room 214</span>
      <div className="progress"><span style={{ width: '72%' }} /></div>
      <span className="text-sm" style={{ color: 'rgb(255 255 255 / .85)' }}>Then <strong className="text-white">Lunch</strong> at 11:45 AM</span>
    </div>
    <div className="mock-list">
      {[['11:45', 'Lunch', ''], ['12:15', 'US History', 'Room 305'], ['1:10', 'Algebra II', 'Room 101']].map(([time, name, room]) => <div key={time} className="mock-row"><span className="tabular text-text-2 text-sm w-12">{time}</span><span className="color-bar" style={{ background: 'var(--accent)', minHeight: 26 }} /><span className="grid"><strong className="text-sm">{name}</strong>{room && <small className="hint">{room}</small>}</span></div>)}
    </div>
    <div className="mock-task"><span className="task-check-fake" /><span className="text-sm">Lab report · due tomorrow</span></div>
  </div>;
}
