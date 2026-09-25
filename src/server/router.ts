import { initTRPC, StandardSchemaV1Error, TRPCError } from '@trpc/server';
import { z, ZodError } from 'zod';
import { NotificationService, pushSubscriptionSchema, pushEndpointSchema } from './notifications';
import { Service, type ClientOptions, namesSchema, createSchoolSchema, schoolUpdateSchema, adminUpdateSchema, joinSchema, mutationSchema } from './service';
import { CalendarService, listSubscriptions, subscribeSchema } from './calendar';
import { DirectoryService, directorySaveSchema, directoryRemoveSchema } from './directory';
import { ScanService, scanInputSchema } from './scan';
import { CommunityService, memberIdSchema, proofSchema, reportSchema } from './community';
import { ProposalService, proposalCreateSchema, voteSchema } from './proposals';
import { ChatService, chatUserSchema, chatThreadSchema, chatSendSchema, chatDeleteSchema, chatReadSchema, chatMuteSchema, chatReportSchema, pauseChatSchema } from './chat';
import { TASK_CLIENT_VERSION } from '@/domain/task';
import { GlobalChatService, globalThreadSchema, globalSendSchema, globalDeleteSchema, globalEditSchema, globalReadSchema, globalMuteSchema } from './global-chat';
import { MenuService, menuLookupSchema, menuSetSchema, menuWeekSchema } from './menu';
export type Context = { userId: string | null; service: Service };
/** Shown instead of a serialized issue list when input fails validation. Keeps the code and data. */
export const INVALID_INPUT_MESSAGE = "Some of this doesn't look right. Check the fields and try again.";
/** Zod's built-in wording ("Invalid input", "Too small: …") is not written for students; custom refine messages are. */
const DEFAULT_ISSUE = /^(Invalid\b|Too (small|big)\b|Unrecognized key)/;
/**
 * Shown for any unexpected server failure. tRPC wraps a plain Error (a SqliteError, a library bug) as
 * INTERNAL_SERVER_ERROR carrying its raw message, which can name tables and columns; messages meant for
 * students are thrown as a TRPCError with another code instead.
 */
export const SERVER_ERROR_MESSAGE = 'Something went wrong. Please try again.';
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    if (!(error.cause instanceof ZodError || error.cause instanceof StandardSchemaV1Error)) {
      return error.code === 'INTERNAL_SERVER_ERROR' ? { ...shape, message: SERVER_ERROR_MESSAGE } : shape;
    }
    const first = (error.cause as { issues?: readonly { message?: unknown }[] }).issues?.[0]?.message;
    const message = typeof first === 'string' && first.trim() && !DEFAULT_ISSUE.test(first) ? first : INVALID_INPUT_MESSAGE;
    return { ...shape, message };
  },
});
const authenticated = t.procedure.use(({ ctx, next }) => {
  const user = ctx.service.user(ctx.userId);
  return next({ ctx: { ...ctx, userId: user.id } });
});
const admin = authenticated.use(({ ctx, next }) => { ctx.service.admin(ctx.userId); return next({ctx}); });
/**
 * Shown when a request is missing a field every current client sends: it comes from a tab still running a bundle
 * built before that field existed (an open tab or a resumed phone app keeps its old code across a deploy).
 */
export const OUTDATED_CLIENT_MESSAGE = 'Quasar has been updated. Reload the page, or close and reopen the app, to continue.';
/** Refuses a request without `field` with OUTDATED_CLIENT_MESSAGE, before input validation would give a vaguer one. */
const requiresField = (field: string) => t.middleware(async ({ getRawInput, next }) => {
  const raw = await getRawInput();
  if (!raw || typeof raw !== 'object' || !(field in raw)) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: OUTDATED_CLIENT_MESSAGE });
  return next();
});
const accountScoped = authenticated.use(requiresField('accountId')).input(z.object({ accountId: z.uuid() })).use(({ ctx, input, next }) => {
  if (input.accountId !== ctx.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'The signed-in account changed. Sign in to the original account to manage its data.' });
  return next({ ctx });
});
/** Owner mutations bound to the signed-in account, so an account switch in another tab can't write the audit log under the wrong account. */
const adminScoped = accountScoped.use(({ ctx, next }) => { ctx.service.admin(ctx.userId); return next({ ctx }); });
const clientVersionSchema = z.object({ clientVersion: z.number().int().positive().optional() });
const clientOptions = (input: { clientVersion?: number } | undefined): ClientOptions => ({ legacyTasks: (input?.clientVersion ?? 1) < TASK_CLIENT_VERSION });
const chat = (service: Service) => new ChatService(service);
const room = (service: Service) => new GlobalChatService(service);
export const appRouter = t.router({
  session: t.procedure.query(({ ctx }) => ctx.userId ? { user: ctx.service.user(ctx.userId), isAdmin: ctx.service.isAdmin(ctx.userId) } : null),
  profile: t.router({save: accountScoped.input(namesSchema).mutation(({ctx, input}) => ctx.service.profile(ctx.userId, input))}),
  directory: t.router({
    list: authenticated.input(z.object({ schoolId: z.uuid() })).query(({ ctx, input }) => new DirectoryService(ctx.service).list(ctx.userId, input.schoolId)),
    save: accountScoped.input(directorySaveSchema).mutation(({ ctx, input }) => new DirectoryService(ctx.service).save(ctx.userId, input)),
    remove: accountScoped.input(directoryRemoveSchema).mutation(({ ctx, input }) => new DirectoryService(ctx.service).remove(ctx.userId, input)),
  }),
  community: t.router({
    verification: authenticated.query(({ ctx }) => new CommunityService(ctx.service).verification(ctx.userId)),
    requestVerification: accountScoped.input(proofSchema).mutation(({ ctx, input }) => new CommunityService(ctx.service).requestVerification(ctx.userId, input)),
    members: authenticated.input(z.object({ query: z.string().max(80).default('') })).query(({ ctx, input }) => new CommunityService(ctx.service).members(ctx.userId, input.query)),
    friends: authenticated.query(({ ctx }) => new CommunityService(ctx.service).friends(ctx.userId)),
    profile: authenticated.input(memberIdSchema).query(({ ctx, input }) => new CommunityService(ctx.service).profile(ctx.userId, input.userId)),
    request: accountScoped.input(memberIdSchema).mutation(({ ctx, input }) => new CommunityService(ctx.service).request(ctx.userId, input.userId)),
    respond: accountScoped.input(memberIdSchema.extend({ accept: z.boolean() })).mutation(({ ctx, input }) => new CommunityService(ctx.service).respond(ctx.userId, input.userId, input.accept)),
    remove: accountScoped.input(memberIdSchema).mutation(({ ctx, input }) => new CommunityService(ctx.service).remove(ctx.userId, input.userId)),
    block: accountScoped.input(memberIdSchema.extend({ blocked: z.boolean() })).mutation(({ ctx, input }) => new CommunityService(ctx.service).block(ctx.userId, input.userId, input.blocked)),
    report: accountScoped.input(reportSchema).mutation(({ ctx, input }) => new CommunityService(ctx.service).report(ctx.userId, input)),
  }),
  // Every chat procedure is account-scoped, queries included (docs/CHAT.md §2).
  chat: t.router({
    // The list carries the global room's row too (§11), so the Messages view polls one endpoint.
    inbox: accountScoped.query(({ ctx }) => ({ ...chat(ctx.service).inbox(ctx.userId), global: room(ctx.service).summary(ctx.userId) })),
    thread: accountScoped.input(chatThreadSchema).query(({ ctx, input }) => chat(ctx.service).thread(ctx.userId, input.userId, { after: input.after, before: input.before })),
    send: accountScoped.input(chatSendSchema).mutation(({ ctx, input }) => chat(ctx.service).send(ctx.userId, input.userId, input.clientId, input.body)),
    delete: accountScoped.input(chatDeleteSchema).mutation(({ ctx, input }) => chat(ctx.service).delete(ctx.userId, input.userId, input.messageId)),
    read: accountScoped.input(chatReadSchema).mutation(({ ctx, input }) => chat(ctx.service).read(ctx.userId, input.userId, input.seq)),
    mute: accountScoped.input(chatMuteSchema).mutation(({ ctx, input }) => chat(ctx.service).mute(ctx.userId, input.userId, input.muted)),
    reopen: accountScoped.input(chatUserSchema).mutation(({ ctx, input }) => chat(ctx.service).reopen(ctx.userId, input.userId)),
    report: accountScoped.input(chatReportSchema).mutation(({ ctx, input }) => chat(ctx.service).report(ctx.userId, input.userId, input)),
    setPush: accountScoped.input(z.object({ enabled: z.boolean() })).mutation(({ ctx, input }) => chat(ctx.service).setPush(ctx.userId, input.enabled)),
  }),
  // The global chat room (docs/CHAT.md §11). Public to every member with names, so the owner moderates it directly.
  global: t.router({
    thread: accountScoped.input(globalThreadSchema).query(({ ctx, input }) => room(ctx.service).thread(ctx.userId, { after: input.after, before: input.before })),
    send: accountScoped.input(globalSendSchema).mutation(({ ctx, input }) => room(ctx.service).send(ctx.userId, input.clientId, input.body)),
    delete: accountScoped.input(globalDeleteSchema).mutation(({ ctx, input }) => room(ctx.service).delete(ctx.userId, input.messageId, input.reason)),
    edit: adminScoped.input(globalEditSchema).mutation(({ ctx, input }) => room(ctx.service).edit(ctx.userId, input.messageId, input.body, input.reason)),
    read: accountScoped.input(globalReadSchema).mutation(({ ctx, input }) => room(ctx.service).read(ctx.userId, input.seq)),
    mute: accountScoped.input(globalMuteSchema).mutation(({ ctx, input }) => room(ctx.service).mute(ctx.userId, input.muted)),
  }),
  proposals: t.router({
    list: authenticated.query(({ ctx }) => new ProposalService(ctx.service).list(ctx.userId)),
    create: accountScoped.input(proposalCreateSchema).mutation(({ ctx, input }) => new ProposalService(ctx.service).create(ctx.userId, input)),
    vote: accountScoped.input(voteSchema).mutation(({ ctx, input }) => new ProposalService(ctx.service).vote(ctx.userId, input)),
    withdraw: accountScoped.input(z.object({ proposalId: z.uuid() })).mutation(({ ctx, input }) => new ProposalService(ctx.service).withdraw(ctx.userId, input.proposalId)),
  }),
  scan: t.router({
    status: authenticated.query(({ ctx }) => ({ enabled: new ScanService(ctx.service).enabled() })),
    schedule: accountScoped.input(scanInputSchema).mutation(({ ctx, input }) => new ScanService(ctx.service).scan(ctx.userId, input)),
  }),
  calendar: t.router({
    list: authenticated.query(({ ctx }) => listSubscriptions(ctx.service.db, ctx.userId)),
    subscribe: accountScoped.input(subscribeSchema).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).subscribe(ctx.userId, input)),
    refresh: accountScoped.input(z.object({ id: z.uuid() })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).refreshNow(ctx.userId, input.id)),
    setEnabled: accountScoped.input(z.object({ id: z.uuid(), enabled: z.boolean() })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).setEnabled(ctx.userId, input.id, input.enabled)),
    remove: accountScoped.input(z.object({ id: z.uuid() })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).remove(ctx.userId, input.id)),
    resolve: accountScoped.input(z.object({ entityId: z.string().min(1).max(100), expectedVersion: z.number().int().positive(), choice: z.enum(['local', 'source']), revision: z.string().max(100).optional() })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).resolve(ctx.userId, input.entityId, input.expectedVersion, input.choice, input.revision)),
  }),
  school: t.router({
    // Summaries only, without schedules (school.get serves the chosen one). The flag marks a client that expects
    // that: an older bundle reads `schedule` from each result, so it is asked to reload instead.
    list: authenticated.use(requiresField('summaries')).input(z.object({query: z.string().max(200), summaries: z.literal(true)})).query(({ctx, input}) => ctx.service.schoolSummaries(input.query)),
    get: authenticated.input(z.object({id: z.string().uuid()})).query(({ctx, input}) => ctx.service.school(input.id)),
    create: accountScoped.input(createSchoolSchema).mutation(({ctx, input}) => ctx.service.createSchool(ctx.userId, input)),
    join: accountScoped.input(joinSchema).mutation(({ctx, input}) => ctx.service.join(ctx.userId, input)),
    update: accountScoped.input(schoolUpdateSchema).mutation(({ctx, input}) => ctx.service.updateSchool(ctx.userId, input)),
    acknowledge: accountScoped.input(z.object({version: z.number().int().positive()})).mutation(({ctx, input}) => ctx.service.acknowledge(ctx.userId, input.version)),
    requestCorrection: accountScoped.input(z.object({message: z.string().trim().min(10).max(5000)})).mutation(({ctx, input}) => ctx.service.requestCorrection(ctx.userId, input.message)),
    feedback: accountScoped.input(z.object({message: z.string().trim().min(10).max(5000)})).mutation(({ctx, input}) => ctx.service.feedback(ctx.userId, input.message)),
    // The lunch menu (src/server/menu.ts): the week containing a date for the student's school, the menus a
    // Nutrislice site publishes (for the picker), and pointing the school at one of them.
    menu: authenticated.input(menuWeekSchema).query(({ctx, input}) => new MenuService(ctx.service).week(ctx.userId, input)),
    menuSources: accountScoped.input(menuLookupSchema.extend({schoolId: z.uuid()})).query(({ctx, input}) => new MenuService(ctx.service).lookup(ctx.userId, input.schoolId, {url: input.url})),
    setMenu: accountScoped.input(menuSetSchema).mutation(({ctx, input}) => new MenuService(ctx.service).set(ctx.userId, input))
  }),
  // Clients built before TASK_CLIENT_VERSION send no input here and no clientVersion with a sync; they get tasks shaped for them.
  workspace: authenticated.input(clientVersionSchema.optional()).query(({ctx, input}) => ctx.service.workspace(ctx.userId, clientOptions(input))),
  sync: authenticated.input(mutationSchema.extend({accountId: z.string().uuid()}).extend(clientVersionSchema.shape)).mutation(({ctx, input}) => {
    if (input.accountId !== ctx.userId) throw new TRPCError({code: 'UNAUTHORIZED', message: 'The signed-in account changed. Sign in to the original account to sync these changes.'});
    return ctx.service.sync(ctx.userId, input, clientOptions(input));
  }),
  notifications: t.router({
    config: authenticated.query(({ctx}) => new NotificationService(ctx.service.db).config()),
    status: authenticated.input(z.object({accountId: z.string().uuid(), endpoint: pushEndpointSchema})).mutation(({ctx,input}) => {
      if (input.accountId !== ctx.userId) throw new TRPCError({code: 'UNAUTHORIZED', message: 'The signed-in account changed. Reopen Quasar to manage reminders.'});
      return new NotificationService(ctx.service.db).status(ctx.userId, input.endpoint);
    }),
    subscribe: authenticated.input(pushSubscriptionSchema.extend({accountId: z.string().uuid()})).mutation(({ctx,input}) => {
      if (input.accountId !== ctx.userId) throw new TRPCError({code: 'UNAUTHORIZED', message: 'The signed-in account changed. Reopen Quasar to manage reminders.'});
      return new NotificationService(ctx.service.db).subscribe(ctx.userId, {endpoint: input.endpoint, keys: input.keys});
    }),
    unsubscribe: authenticated.input(z.object({accountId: z.string().uuid(), endpoint: pushEndpointSchema})).mutation(({ctx,input}) => {
      if (input.accountId !== ctx.userId) throw new TRPCError({code: 'UNAUTHORIZED', message: 'The signed-in account changed. Reopen Quasar to manage reminders.'});
      return new NotificationService(ctx.service.db).unsubscribe(ctx.userId, {endpoint: input.endpoint});
    }),
  }),
  admin: t.router({
    schools: admin.query(({ctx}) => ctx.service.schools('', -1)),
    update: admin.input(adminUpdateSchema).mutation(({ctx, input}) => ctx.service.updateSchool(ctx.userId, input, true)),
    requests: admin.query(({ctx}) => ctx.service.requests(ctx.userId)),
    resolveRequest: admin.input(z.object({id:z.string().uuid()})).mutation(({ctx,input}) => ctx.service.resolveRequest(ctx.userId,input.id)),
    verificationRequests: admin.query(({ ctx }) => new CommunityService(ctx.service).verificationRequests(ctx.userId)),
    decideVerification: admin.input(z.object({ id: z.uuid(), approve: z.boolean() })).mutation(({ ctx, input }) => new CommunityService(ctx.service).decideVerification(ctx.userId, input.id, input.approve)),
    reports: admin.query(({ ctx }) => new CommunityService(ctx.service).reports(ctx.userId)),
    resolveReport: admin.input(z.object({ id: z.uuid(), outcome: z.enum(['dismissed', 'removed']) })).mutation(({ ctx, input }) => new CommunityService(ctx.service).resolveReport(ctx.userId, input.id, input.outcome)),
    removeMember: admin.input(z.object({ userId: z.uuid(), schoolId: z.uuid(), reason: z.string().trim().min(3).max(2000) })).mutation(({ ctx, input }) => new CommunityService(ctx.service).removeFromSchool(ctx.userId, input.userId, input.schoolId, input.reason)),
    proposals: admin.query(({ ctx }) => new ProposalService(ctx.service).awaitingSupport(ctx.userId)),
    decideProposal: admin.input(z.object({ id: z.uuid(), publish: z.boolean() })).mutation(({ ctx, input }) => new ProposalService(ctx.service).decide(ctx.userId, input.id, input.publish)),
    // No admin procedure reads chat_messages.body. Chat text reaches the owner only through showEvidence, which is audited.
    showEvidence: adminScoped.input(z.object({ reportId: z.uuid() })).mutation(({ ctx, input }) => chat(ctx.service).showEvidence(ctx.userId, input.reportId)),
    redactMessage: adminScoped.input(z.object({ reportId: z.uuid(), seq: z.number().int().positive() })).mutation(({ ctx, input }) => { chat(ctx.service).redactMessage(ctx.userId, input.reportId, input.seq); }),
    pauseChat: adminScoped.input(pauseChatSchema).mutation(({ ctx, input }) => { chat(ctx.service).pauseChat(ctx.userId, input); }),
    liftChatPause: adminScoped.input(chatUserSchema).mutation(({ ctx, input }) => { chat(ctx.service).liftChatPause(ctx.userId, input.userId); }),
    chatPauses: admin.query(({ ctx }) => chat(ctx.service).chatPauses(ctx.userId)),
  })
});
export type AppRouter = typeof appRouter;
