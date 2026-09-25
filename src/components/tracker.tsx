'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '@/client/api';
import { serviceWorkerEnabled } from '@/client/service-worker-support';
import { effectiveSchedule, scheduleForGrade, emptyPersonalSchedule, personalScheduleSchema, type PersonalSchedule } from '@/domain/schedule';
import type { Task } from '@/domain/task';
import { todayIn } from '@/lib/format';
import { VIEWS, personalSaver, taskItems, type AppState, type View } from './app-state';
import { DeviceConflicts, SchoolReview } from './conflicts';
import { Onboarding, SignOutButton } from './onboarding';
import { ClassesStep } from './onboarding-classes';
import { FeedStep } from './onboarding-feed';
import { classesStep, feedStep } from './setup-state';
import { Icon } from './icon';
import { CenteredNotice, LogoutDialog, Shell } from './shell';
import { Welcome } from './landing';
import { Button, Callout } from './primitives';
import { useWorkspace, type InitialBoot } from './use-workspace';
import { routeFromLocation, viewPath, type Route } from '@/lib/routes';
import { ClassesView } from './views/classes';
import { ScheduleView } from './views/schedule';
import { SchoolView } from './views/school';
import { TasksView } from './views/tasks';
import { TodayView } from './views/today';
import { PeopleView } from './views/people';
import { MessagesView } from './views/messages';
import { CHAT_ACTIVITY_EVENT, clearChatMemory, resumeChatSends } from './use-chat';
import { GradePicker } from './grade-picker';

/* ---------- Path routing: Today at "/", every other view at "/<view>", rendered by the server ---------- */

type RouteState = { view: View; params: URLSearchParams };
const toState = (route: Route): RouteState => ({ view: route.view, params: new URLSearchParams(route.query) });
const sameRoute = (a: RouteState, b: RouteState) => a.view === b.view && a.params.toString() === b.params.toString();

/**
 * `initial` is the route the server rendered (src/app/page.tsx, src/app/[view]/page.tsx). The browser's address is
 * re-read once the page is interactive: the offline shell is cached under "/" whatever path it was opened at, and an
 * old `#view` bookmark is rewritten to its path. Navigation uses the history API without reloading; Next's router
 * only observes it.
 */
function usePathRoute(initial?: Route) {
  const [route, setRoute] = useState<RouteState>(() => initial ? toState(initial) : typeof window === 'undefined' ? { view: 'today', params: new URLSearchParams() } : toState(routeFromLocation(window.location)));
  const shownView = useRef(route.view);
  useEffect(() => {
    const sync = () => {
      const current = routeFromLocation(window.location);
      if (current.legacyHash) window.history.replaceState(window.history.state, '', viewPath(current.view, new URLSearchParams(current.query)));
      const next = toState(current);
      setRoute((shown) => sameRoute(shown, next) ? shown : next);
    };
    sync();
    // Back/forward, and a hash change to an in-page anchor (which leaves the route as it is).
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync); };
  }, []);
  // Every way of changing view (tab bar, sidebar, links, back/forward, navigate) opens the new view at the top.
  // Scrolling after it renders avoids clamping to the old page's height; param-only changes keep their position.
  useLayoutEffect(() => {
    if (shownView.current === route.view) return;
    shownView.current = route.view;
    window.scrollTo({ top: 0 });
  }, [route.view]);
  const navigate = useCallback((view: View, params?: Record<string, string>, options?: { replace?: boolean }) => {
    const next = viewPath(view, params);
    const current = `${window.location.pathname}${window.location.search}`;
    // Stripping a one-shot param must not leave it in history, or Back would re-trigger it.
    if (options?.replace) window.history.replaceState(window.history.state, '', next);
    else if (current !== next) window.history.pushState(null, '', next);
    setRoute({ view, params: new URLSearchParams(params) });
    if (view === shownView.current) window.scrollTo({ top: 0 });
  }, []);
  return { ...route, navigate };
}

function useNow(intervalMs = 30_000, renderedAt?: number): Date {
  // The server-rendered page and its hydration must agree on "now", so both start from the server's clock; the
  // browser's own clock takes over as soon as the page is interactive.
  const [now, setNow] = useState(() => renderedAt ? new Date(renderedAt) : new Date());
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') setNow(new Date()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [intervalMs]);
  return now;
}

/** A server-stamped unread-chat count, tied to the account it was computed for. */
type ChatUnread = { accountId: string; count: number; at: number };

/**
 * The Messages badge count. Three sources offer counts (the workspace context, chat.inbox and chat.read),
 * each stamped by the server when it computed them; the latest stamp wins whatever order responses
 * arrive in, and an equal stamp keeps the current value.
 */
function useChatUnread(accountId: string | undefined, community: { unreadChats?: number; unreadAt?: string } | null | undefined) {
  const [latest, setLatest] = useState<ChatUnread | null>(null);
  const offer = useCallback((owner: string, count: number, at: string) => {
    const stamp = Date.parse(at);
    if (!Number.isFinite(stamp) || !Number.isFinite(count)) return;
    setLatest((current) => current && current.accountId === owner && current.at >= stamp ? current : { accountId: owner, count: Math.max(0, count), at: stamp });
  }, []);
  // A context cached on this device before chat existed has no count; it simply offers nothing.
  const contextCount = community?.unreadChats;
  const contextAt = community?.unreadAt;
  useEffect(() => {
    if (accountId && typeof contextCount === 'number' && typeof contextAt === 'string') offer(accountId, contextCount, contextAt);
  }, [accountId, contextCount, contextAt, offer]);
  const setChatUnread = useCallback((count: number, at: string) => { if (accountId) offer(accountId, count, at); }, [accountId, offer]);
  // Another account's count is never shown.
  return { count: latest && latest.accountId === accountId ? latest.count : 0, setChatUnread };
}

const subscribeToNothing = () => () => {};
/** False on the server and while its HTML hydrates, true once this device's own storage may be read during render. */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, () => true, () => false);
}

/* ---------- Root ---------- */

/**
 * `initial` is what the server rendered for this request (src/app/page.tsx, src/app/[view]/page.tsx): the landing page
 * or the account's workspace, and `initialRoute` the view its address named, so the first paint is the real screen and
 * no API call stands in front of it.
 */
export function Tracker({ initial, initialRoute }: { initial?: InitialBoot; initialRoute?: Route }) {
  const session = useWorkspace(initial);
  const route = usePathRoute(initialRoute);
  const now = useNow(30_000, initial?.kind === 'workspace' ? initial.renderedAt : undefined);
  const hydrated = useHydrated();
  const { context, snapshot } = session;

  const personalEntity = snapshot?.entities.find((entity) => entity.kind === 'personal' && entity.id === 'personal' && !entity.deleted);
  const parsedPersonal = useMemo(() => personalScheduleSchema.safeParse(personalEntity?.data ?? emptyPersonalSchedule()), [personalEntity]);
  const personal: PersonalSchedule = parsedPersonal.success ? parsedPersonal.data : emptyPersonalSchedule();
  const openTasks = useMemo(() => snapshot ? taskItems(snapshot.entities).filter((item) => !item.task.completed).length : 0, [snapshot]);
  // Finishing a setup step bumps this so its flag (in this device's storage) is re-read during render.
  const [, rereadSetup] = useState(0);
  const userId = context?.user.id;

  const chatUnread = useChatUnread(userId, context?.community);
  // Unsent chat messages and drafts live only in memory; a finished sign-out or a lost session forgets them.
  // Not when sign-out starts: it can still fail and leave the student signed in, with their unsent text kept.
  useEffect(() => { if (session.authRequired) clearChatMemory(); }, [session.authRequired]);
  // Coming back online retries chat messages that failed for network reasons, in every thread (same IDs, so safe).
  const wasOnline = useRef(session.online);
  useEffect(() => {
    const cameOnline = session.online && !wasOnline.current;
    wasOnline.current = session.online;
    if (cameOnline && userId) resumeChatSends(userId);
  }, [session.online, userId]);
  // A chat push tells open tabs to refresh: the badge through the workspace sync, and any visible chat pollers.
  const synchronizeRef = useRef(session.synchronize);
  useEffect(() => { synchronizeRef.current = session.synchronize; });
  useEffect(() => {
    if (!serviceWorkerEnabled || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type !== 'CHAT_ACTIVITY') return;
      window.dispatchEvent(new Event(CHAT_ACTIVITY_EVENT));
      void synchronizeRef.current();
    };
    container.addEventListener('message', onMessage);
    container.startMessages();
    return () => container.removeEventListener('message', onMessage);
  }, []);

  if (session.authRequired) return <Welcome message={session.error || undefined} signInReturn={initial?.kind === 'signed-out' ? { error: initial.signInError, callbackPath: initial.callbackPath } : undefined} />;
  // No loader: the page stays a plain background until the device cache or the server answers, so nothing flashes
  // before the app paints (not even the sign-in gradient, which would read as a loading screen).
  if (session.loading && !context) return <div className="min-h-dvh" aria-busy="true" />;
  if (!context || !snapshot) {
    // session.online is false after the last load could not reach the server (use-workspace sets it on every
    // transport failure), so an online device that still has nothing to show hit a server or storage error.
    const offline = !session.online || (typeof navigator !== 'undefined' && !navigator.onLine);
    return <CenteredNotice title={offline ? 'Connect to get started' : 'Quasar couldn’t load'}
      action={<Button variant="primary" onClick={() => void session.initialize()} busy={session.loading}>{offline ? 'Retry connection' : 'Try again'}</Button>}>
      {session.error || (offline ? 'Connect to the internet and sign in once to set up Quasar on this device.' : 'Something went wrong. Please try again.')}
    </CenteredNotice>;
  }

  // The setup screens have no shell, so they show session errors (a failed sign-out, a refresh or sync
  // error) and the sign-out confirmation themselves.
  const sessionNotice = session.error ? <Callout tone="danger" icon="alert" role="alert" actions={<><Button size="sm" onClick={() => void session.initialize()} disabled={session.loading}>Try again</Button><Button size="sm" variant="ghost" onClick={session.dismissError}>Dismiss</Button></>}>{session.error}</Callout> : null;
  const logoutDialog = <LogoutDialog session={session} />;
  // Refuses every write while the saved personal schedule is unreadable, so its empty fallback never replaces it.
  const savePersonal = personalSaver(parsedPersonal.success, (value) => session.save('personal', 'personal', value));

  // Every signed-in screen is keyed by account, so a switch to another account never keeps the previous one's
  // wizard drafts, prefilled names or screen state.
  const accountKey = context.user.id;
  const needsNames = !context.user.displayName || !context.user.fullName;
  if (needsNames || !context.school) {
    return <Fragment key={accountKey}><Onboarding context={context} online={session.online} sessionNotice={sessionNotice} onRefresh={session.initialize} onSignOut={session.requestLogout} logoutPending={session.logout.pending} />{logoutDialog}</Fragment>;
  }

  const school = context.school;
  const accountId = context.user.id;
  const schedule = effectiveSchedule(school.schedule, personal);
  const timeZone = schedule.timeZone;
  // Right after joining, the wizard continues with the classes step until the student finishes or skips it. The
  // flags live in this device's storage, which the server cannot see, so a server-rendered page shows the dashboard
  // until it hydrates; every render after that reads them directly (no dashboard flash on the way into a step).
  const setupClasses = hydrated && classesStep.pending(accountId);
  const setupFeed = hydrated && feedStep.pending(accountId);
  if (setupClasses) {
    return <Fragment key={accountKey}><ClassesStep userId={context.user.id} schoolId={school.id} schedule={schedule} personal={personal} online={session.online} disabled={!parsedPersonal.success}
      onSave={savePersonal} notice={sessionNotice}
      onDone={() => { classesStep.finish(accountId); feedStep.begin(accountId); rereadSetup((version) => version + 1); }}
      footer={<SignOutButton email={context.user.email} onClick={session.requestLogout} disabled={session.logout.pending || !session.online} />} />{logoutDialog}</Fragment>;
  }
  if (setupFeed) {
    return <Fragment key={accountKey}><FeedStep userId={context.user.id} online={session.online} timeZone={timeZone} subscriptions={context.subscriptions ?? []} onSubscribed={session.initialize}
      onDone={() => { feedStep.finish(accountId); rereadSetup((version) => version + 1); }} notice={sessionNotice}
      footer={<SignOutButton email={context.user.email} onClick={session.requestLogout} disabled={session.logout.pending || !session.online} />} />{logoutDialog}</Fragment>;
  }
  const state: AppState = {
    context: { ...context, school },
    snapshot,
    personal,
    personalValid: parsedPersonal.success,
    schedule: scheduleForGrade(school.schedule, personal.grade),
    timeZone,
    now,
    today: todayIn(timeZone, now),
    online: session.online,
    saveTask: (id: string, task: Task | null) => session.save('task', id, task),
    savePersonal,
    refresh: session.initialize,
    navigate: route.navigate,
    params: route.params,
    chatUnread: session.online ? chatUnread.count : null,
    setChatUnread: chatUnread.setChatUnread,
  };
  const onMessages = route.view === 'messages';
  // A phone thread fills the screen above the keyboard; Shell hides the dock (desktop never shows one).
  const immersive = onMessages && (route.params.has('with') || route.params.get('room') === 'global');
  const onChatPush = async (enabled: boolean) => {
    await api.chat.setPush.mutate({ accountId, enabled });
    await session.synchronize();
  };

  return <Shell key={accountKey} session={session} context={context} view={route.view} navigate={route.navigate} taskCount={openTasks} chatUnread={state.chatUnread} immersive={immersive}
    chatPush={context.community?.chatPush ?? true} onChatPush={onChatPush}
    gradeSettings={<GradePicker personal={personal} save={state.savePersonal} disabled={!state.personalValid} />}>
    {/* The grade prompt would crowd the chat column; it shows again on every other view. */}
    {!personal.grade && state.personalValid && !onMessages && <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl bg-card p-4 shadow-card ring-2 ring-primary/40">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground"><Icon name="school" size={18} /></span>
      <p className="min-w-0 flex-1 basis-[220px] text-sm font-medium">Choose your grade to see the right school schedule and lunch times.</p>
      <div className="min-w-[220px]"><GradePicker personal={personal} save={state.savePersonal} /></div>
    </div>}
    <div className="mb-4 grid gap-4 outline-none empty:hidden" id="conflicts">
      {!parsedPersonal.success && <Callout tone="danger" icon="alert" role="alert" title="Your saved personal schedule needs review" actions={<Button size="sm" onClick={() => void session.synchronize()} disabled={!session.online}>Retry sync</Button>}>It could not be read on this device. Retry sync before making more changes so nothing is overwritten.</Callout>}
      <DeviceConflicts snapshot={snapshot} schedule={schedule} classes={personal.classes} resolve={session.resolve} />
      {context.review && <SchoolReview key={context.review.version} review={context.review} personal={personal} online={session.online} today={state.today}
        onAcknowledge={async () => { await api.school.acknowledge.mutate({ accountId, version: context.review!.version }); await session.initialize(); }}
        onOpenClasses={() => route.navigate('classes')} />}
    </div>
    {route.view === 'today' && <TodayView state={state} />}
    {route.view === 'schedule' && <ScheduleView state={state} />}
    {route.view === 'tasks' && <TasksView state={state} />}
    {route.view === 'classes' && <ClassesView state={state} />}
    {route.view === 'school' && <SchoolView state={state} />}
    {route.view === 'people' && <PeopleView state={state} />}
    {route.view === 'messages' && <MessagesView state={state} />}
  </Shell>;
}
