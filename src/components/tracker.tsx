'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/client/api';
import { serviceWorkerEnabled } from '@/client/service-worker-support';
import { effectiveSchedule, scheduleForGrade, emptyPersonalSchedule, personalScheduleSchema, type PersonalSchedule } from '@/domain/schedule';
import type { Task } from '@/domain/task';
import { todayIn } from '@/lib/format';
import { VIEWS, taskItems, type AppState, type View } from './app-state';
import { DeviceConflicts, SchoolReview } from './conflicts';
import { Onboarding, SignOutButton } from './onboarding';
import { ClassesStep } from './onboarding-classes';
import { FeedStep } from './onboarding-feed';
import { classesStep, feedStep } from './setup-state';
import { Icon } from './icon';
import { CenteredNotice, Shell } from './shell';
import { Welcome } from './landing';
import { Button, Callout } from './primitives';
import { useWorkspace } from './use-workspace';
import { ClassesView } from './views/classes';
import { ScheduleView } from './views/schedule';
import { SchoolView } from './views/school';
import { TasksView } from './views/tasks';
import { TodayView } from './views/today';
import { PeopleView } from './views/people';
import { MessagesView } from './views/messages';
import { CHAT_ACTIVITY_EVENT, clearChatMemory, resumeChatSends } from './use-chat';
import { GradePicker } from './grade-picker';

/* ---------- Hash routing keeps the public offline shell at "/" ---------- */

function splitHash(hash: string): [name: string, query: string] {
  const [name, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return [name, query];
}

function parseHash(hash: string): { view: View; params: URLSearchParams } {
  const [name, query] = splitHash(hash);
  const view = VIEWS.find((entry) => entry.id === name)?.id ?? 'today';
  return { view, params: new URLSearchParams(query) };
}

function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(typeof window === 'undefined' ? '' : window.location.hash));
  const shownView = useRef(route.view);
  useEffect(() => {
    const update = () => {
      // In-page anchors (#main, #conflicts) are not routes: only an empty hash or a known view changes the screen.
      const [name] = splitHash(window.location.hash);
      if (name && !VIEWS.some((entry) => entry.id === name)) return;
      setRoute(parseHash(window.location.hash));
    };
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  // Every way of changing view (tab bar, sidebar, links, back/forward, navigate) opens the new view at the top.
  // Scrolling after it renders avoids clamping to the old page's height; param-only changes keep their position.
  useLayoutEffect(() => {
    if (shownView.current === route.view) return;
    shownView.current = route.view;
    window.scrollTo({ top: 0 });
  }, [route.view]);
  const navigate = useCallback((view: View, params?: Record<string, string>, options?: { replace?: boolean }) => {
    const query = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const next = `#${view}${query}`;
    if (options?.replace) {
      // Stripping a one-shot param must not leave it in history, or Back would re-trigger it.
      // replaceState fires no hashchange, so the route is set directly.
      window.history.replaceState(null, '', next);
      setRoute(parseHash(next));
      return;
    }
    if (window.location.hash === next) setRoute(parseHash(next));
    else window.location.hash = next;
    if (view === shownView.current) window.scrollTo({ top: 0 });
  }, []);
  return { ...route, navigate };
}

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
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

/* ---------- Root ---------- */

export function Tracker() {
  const session = useWorkspace();
  const route = useHashRoute();
  const now = useNow();
  const { context, snapshot } = session;

  const personalEntity = snapshot?.entities.find((entity) => entity.kind === 'personal' && entity.id === 'personal' && !entity.deleted);
  const parsedPersonal = useMemo(() => personalScheduleSchema.safeParse(personalEntity?.data ?? emptyPersonalSchedule()), [personalEntity]);
  const personal: PersonalSchedule = parsedPersonal.success ? parsedPersonal.data : emptyPersonalSchedule();
  const openTasks = useMemo(() => snapshot ? taskItems(snapshot.entities).filter((item) => !item.task.completed).length : 0, [snapshot]);
  const [setupClasses, setSetupClasses] = useState(false);
  const [setupFeed, setSetupFeed] = useState(false);
  const userId = context?.user.id;
  useEffect(() => { setSetupClasses(!!userId && classesStep.pending(userId)); setSetupFeed(!!userId && feedStep.pending(userId)); }, [userId, context?.school?.id]);

  const chatUnread = useChatUnread(userId, context?.community);
  // Unsent chat messages and drafts live only in memory; signing out or losing the session forgets them.
  useEffect(() => { if (session.authRequired || session.logout.pending) clearChatMemory(); }, [session.authRequired, session.logout.pending]);
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

  if (session.authRequired) return <Welcome message={session.error || undefined} />;
  // No loader: the page stays blank until the device cache or the server answers, so nothing flashes before the app paints.
  if (session.loading && !context) return <div className="welcome-bg min-h-dvh" aria-busy="true" />;
  if (!context || !snapshot) {
    return <CenteredNotice title="Connect to get started" action={<Button variant="primary" onClick={() => void session.initialize()} busy={session.loading}>Retry connection</Button>}>
      {session.error || 'Connect to the internet and sign in once to set up Quasar on this device.'}
    </CenteredNotice>;
  }

  const needsNames = !context.user.displayName || !context.user.fullName;
  if (needsNames || !context.school) {
    return <Onboarding context={context} online={session.online} error={session.error} onRefresh={session.initialize} onSignOut={session.requestLogout} logoutPending={session.logout.pending} />;
  }

  const school = context.school;
  const accountId = context.user.id;
  const schedule = effectiveSchedule(school.schedule, personal);
  const timeZone = schedule.timeZone;
  // Right after joining, the wizard continues with the classes step until the student finishes or skips it.
  if (setupClasses) {
    return <ClassesStep userId={context.user.id} schoolId={school.id} schedule={schedule} personal={personal} online={session.online} disabled={!parsedPersonal.success}
      onSave={(value) => session.save('personal', 'personal', personalScheduleSchema.parse(value))}
      onDone={() => { classesStep.finish(context.user.id); feedStep.begin(context.user.id); setSetupClasses(false); setSetupFeed(true); }}
      footer={<SignOutButton email={context.user.email} onClick={session.requestLogout} disabled={session.logout.pending || !session.online} />} />;
  }
  if (setupFeed) {
    return <FeedStep userId={context.user.id} online={session.online} subscriptions={context.subscriptions ?? []} onSubscribed={session.initialize}
      onDone={() => { feedStep.finish(context.user.id); setSetupFeed(false); }}
      footer={<SignOutButton email={context.user.email} onClick={session.requestLogout} disabled={session.logout.pending || !session.online} />} />;
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
    savePersonal: (value: PersonalSchedule) => session.save('personal', 'personal', personalScheduleSchema.parse(value)),
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

  return <Shell session={session} context={context} view={route.view} taskCount={openTasks} chatUnread={state.chatUnread} immersive={immersive}
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
        onAcknowledge={async () => { await api.school.acknowledge.mutate({ version: context.review!.version }); await session.initialize(); }}
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
