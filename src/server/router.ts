import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Service, namesSchema, createSchoolSchema, schoolUpdateSchema, adminUpdateSchema, joinSchema, mutationSchema } from './service';
export type Context = { userId: string | null; service: Service };
const t = initTRPC.context<Context>().create();
const authenticated = t.procedure.use(({ ctx, next }) => {
  const user = ctx.service.user(ctx.userId);
  return next({ ctx: { ...ctx, userId: user.id } });
});
const admin = authenticated.use(({ ctx, next }) => { ctx.service.admin(ctx.userId); return next({ctx}); });
export const appRouter = t.router({
  session: t.procedure.query(({ ctx }) => ctx.userId ? { user: ctx.service.user(ctx.userId), isAdmin: ctx.service.isAdmin(ctx.userId) } : null),
  profile: t.router({save: authenticated.input(namesSchema).mutation(({ctx, input}) => ctx.service.profile(ctx.userId, input))}),
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
  admin: t.router({
    schools: admin.query(({ctx}) => ctx.service.schools('', -1)),
    update: admin.input(adminUpdateSchema).mutation(({ctx, input}) => ctx.service.updateSchool(ctx.userId, input, true)),
    requests: admin.query(({ctx}) => ctx.service.requests(ctx.userId)),
    resolveRequest: admin.input(z.object({id:z.string().uuid()})).mutation(({ctx,input}) => ctx.service.resolveRequest(ctx.userId,input.id))
  })
});
export type AppRouter = typeof appRouter;
