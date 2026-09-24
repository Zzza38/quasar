import { TRPCError } from '@trpc/server';
import { getErrorShape } from '@trpc/server/unstable-core-do-not-import';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appRouter, INVALID_INPUT_MESSAGE } from './router';

const shapeOf = (error: TRPCError) => getErrorShape({ config: appRouter._def._config, error, type: 'mutation', path: 'profile.save', input: {}, ctx: undefined });

describe('error formatter', () => {
  it('replaces a serialized Zod issue list with plain text and keeps the code', () => {
    const parsed = z.object({ first: z.string().min(1) }).safeParse({ first: '' });
    if (parsed.success) throw new Error('expected a validation failure');
    const shape = shapeOf(new TRPCError({ code: 'BAD_REQUEST', cause: parsed.error }));
    expect(shape.message).toBe(INVALID_INPUT_MESSAGE);
    expect(shape.data.code).toBe('BAD_REQUEST');
    expect(shape.data.httpStatus).toBe(400);
  });

  it('keeps a custom schema message and replaces a built-in one', () => {
    const custom = z.object({ domain: z.string().refine((v) => v.includes('.'), 'Enter a domain such as students.example.org') }).safeParse({ domain: 'nope' });
    if (custom.success) throw new Error('expected a validation failure');
    expect(shapeOf(new TRPCError({ code: 'BAD_REQUEST', cause: custom.error })).message).toBe('Enter a domain such as students.example.org');
    const builtIn = z.object({ count: z.number().max(3) }).safeParse({ count: 9 });
    if (builtIn.success) throw new Error('expected a validation failure');
    expect(shapeOf(new TRPCError({ code: 'BAD_REQUEST', cause: builtIn.error })).message).toBe(INVALID_INPUT_MESSAGE);
  });

  it('passes messages written for students through unchanged', () => {
    const shape = shapeOf(new TRPCError({ code: 'CONFLICT', message: 'This directory class changed. Reload and review it before saving.' }));
    expect(shape.message).toBe('This directory class changed. Reload and review it before saving.');
    expect(shape.data.code).toBe('CONFLICT');
  });
});
