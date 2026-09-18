import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { NotificationService, pushSubscriptionSchema, pushEndpointSchema } from './notifications';
import { Service, namesSchema, createSchoolSchema, schoolUpdateSchema, adminUpdateSchema, joinSchema, mutationSchema } from './service';
import { CalendarService, listSubscriptions, subscribeSchema } from './calendar';
import { DirectoryService, directorySaveSchema, directoryRemoveSchema } from './directory';
export type Context = { userId: string | null; service: Service };
const t = initTRPC.context<Context>().create();
const authenticated = t.procedure.use(({ ctx, next }) => {
  const user = ctx.service.user(ctx.userId);
  return next({ ctx: { ...ctx, userId: user.id } });
});
const admin = authenticated.use(({ ctx, next }) => { ctx.service.admin(ctx.userId); return next({ctx}); });
const accountScoped = authenticated.input(z.object({ accountId: z.uuid() })).use(({ ctx, input, next }) => {
  if (input.accountId !== ctx.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'The signed-in account changed. Sign in to the original account to manage its data.' });
  return next({ ctx });
});
export const appRouter = t.router({
  session: t.procedure.query(({ ctx }) => ctx.userId ? { user: ctx.service.user(ctx.userId), isAdmin: ctx.service.isAdmin(ctx.userId) } : null),
  profile: t.router({save: authenticated.input(namesSchema).mutation(({ctx, input}) => ctx.service.profile(ctx.userId, input))}),
  directory: t.router({
    list: authenticated.input(z.object({ schoolId: z.uuid() })).query(({ ctx, input }) => new DirectoryService(ctx.service).list(ctx.userId, input.schoolId)),
    save: accountScoped.input(directorySaveSchema).mutation(({ ctx, input }) => new DirectoryService(ctx.service).save(ctx.userId, input)),
    remove: accountScoped.input(directoryRemoveSchema).mutation(({ ctx, input }) => new DirectoryService(ctx.service).remove(ctx.userId, input)),
  }),
  calendar: t.router({
    list: authenticated.query(({ ctx }) => listSubscriptions(ctx.service.db, ctx.userId)),
    subscribe: accountScoped.input(subscribeSchema).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).subscribe(ctx.userId, input)),
    refresh: accountScoped.input(z.object({ id: z.uuid() })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).refresh(ctx.userId, input.id)),
    setEnabled: accountScoped.input(z.object({ id: z.uuid(), enabled: z.boolean() })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).setEnabled(ctx.userId, input.id, input.enabled)),
    remove: accountScoped.input(z.object({ id: z.uuid() })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).remove(ctx.userId, input.id)),
    resolve: accountScoped.input(z.object({ entityId: z.string().min(1).max(100), expectedVersion: z.number().int().positive(), choice: z.enum(['local', 'source']) })).mutation(({ ctx, input }) => new CalendarService(ctx.service.db).resolve(ctx.userId, input.entityId, input.expectedVersion, input.choice)),
  }),
  school: t.router({
    list: authenticated.input(z.object({query: z.string().max(200)})).query(({ctx, input}) => ctx.service.schools(input.query)),
    create: authenticated.input(createSchoolSchema).mutation(({ctx, input}) => ctx.service.createSchool(ctx.userId, input)),
    join: authenticated.input(joinSchema).mutation(({ctx, input}) => ctx.service.join(ctx.userId, input)),
    update: authenticated.input(schoolUpdateSchema).mutation(({ctx, input}) => ctx.service.updateSchool(ctx.userId, input)),
    acknowledge: authenticated.input(z.object({version: z.number().int().positive()})).mutation(({ctx, input}) => ctx.service.acknowledge(ctx.userId, input.version)),
    requestCorrection: authenticated.input(z.object({message: z.string().trim().min(10).max(5000)})).mutation(({ctx, input}) => ctx.service.requestCorrection(ctx.userId, input.message))
  }),
  workspace: authenticated.query(({ctx}) => ctx.service.workspace(ctx.userId)),
  sync: authenticated.input(mutationSchema.extend({accountId: z.string().uuid()})).mutation(({ctx, input}) => {
    if (input.accountId !== ctx.userId) throw new TRPCError({code: 'UNAUTHORIZED', message: 'The signed-in account changed. Sign in to the original account to sync these changes.'});
    return ctx.service.sync(ctx.userId, input);
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
    resolveRequest: admin.input(z.object({id:z.string().uuid()})).mutation(({ctx,input}) => ctx.service.resolveRequest(ctx.userId,input.id))
  })
});
export type AppRouter = typeof appRouter;
