import { describe, expect, it } from 'vitest';
import { verificationNotice } from './people';

describe('proof sent notice', () => {
  it('says support has the proof while it waits for review', () => {
    expect(verificationNotice({ status: 'pending', method: null })).toBe('Sent to support.');
  });
  it('credits the school email only when the email domain verified the student', () => {
    expect(verificationNotice({ status: 'verified', method: 'domain' })).toBe('You are verified through your school email address.');
  });
  it('says support verified a student whose earlier request was already approved', () => {
    expect(verificationNotice({ status: 'verified', method: 'support' })).toBe('You are already verified by support.');
  });
});
