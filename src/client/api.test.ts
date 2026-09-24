import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorMessage, INVALID_INPUT_MESSAGE, isTransportFailure, isUnauthorized, UNREACHABLE_MESSAGE } from './api';

const serverError = (message: string, code: string) => new TRPCClientError(message, { result: { error: { message, code: -32600, data: { code, httpStatus: 400 } } } });

describe('error messages', () => {
  it('explains transport failures instead of showing browser text', () => {
    for (const error of [new TypeError('Failed to fetch'), new TypeError('Load failed'), new TRPCClientError('Failed to fetch'), new TRPCClientError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")]) {
      expect(isTransportFailure(error)).toBe(true);
      expect(errorMessage(error)).toBe(UNREACHABLE_MESSAGE);
    }
  });

  it('passes server messages through and keeps them out of the offline path', () => {
    const conflict = serverError('This directory class changed. Reload and review it before saving.', 'CONFLICT');
    expect(isTransportFailure(conflict)).toBe(false);
    expect(errorMessage(conflict)).toBe('This directory class changed. Reload and review it before saving.');
    const unauthorized = serverError('Sign in again.', 'UNAUTHORIZED');
    expect(isTransportFailure(unauthorized)).toBe(false);
    expect(isUnauthorized(unauthorized)).toBe(true);
  });

  it('uses a custom Zod message and hides the built-in ones', () => {
    const custom = z.string().refine((value) => value.includes('.'), 'Enter a domain such as students.example.org').safeParse('school');
    expect(errorMessage(custom.error)).toBe('Enter a domain such as students.example.org');
    const builtIn = z.object({ first: z.string().min(1) }).safeParse({ first: '' });
    expect(errorMessage(builtIn.error)).toBe(INVALID_INPUT_MESSAGE);
  });

  it('never shows a serialized issue list', () => {
    expect(errorMessage(serverError('[{"code":"too_small","minimum":1}]', 'BAD_REQUEST'))).toBe(INVALID_INPUT_MESSAGE);
    expect(errorMessage(new Error('{"error":"upstream"}'))).toBe('Something went wrong. Please try again.');
    expect(errorMessage('nope')).toBe('Something went wrong. Please try again.');
  });
});
