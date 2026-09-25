import { describe, expect, it } from 'vitest';
import { signInErrorMessage, signInReturnPath } from './landing';

describe('signInErrorMessage', () => {
  it('says nothing when the address carries no sign-in error', () => {
    expect(signInErrorMessage(null)).toBeNull();
    expect(signInErrorMessage('')).toBeNull();
  });

  it('explains a Google account refused for an unverified email', () => {
    expect(signInErrorMessage('AccessDenied')).toMatch(/verified the email address/);
  });

  it('asks the student to try again after a cancelled or failed Google round trip', () => {
    for (const code of ['OAuthCallback', 'Callback', 'OAuthSignin', 'Something new']) expect(signInErrorMessage(code)).toMatch(/Sign-in didn’t finish/);
  });

  it('does not blame the student for a server setup fault', () => {
    expect(signInErrorMessage('Configuration')).toMatch(/try again later/);
  });
});

describe('signInReturnPath', () => {
  const origin = 'https://quasar.example';

  it('sends a retry back to the owner console when an /admin sign-in failed', () => {
    // NextAuth hands the callback back as an absolute URL on this origin.
    expect(signInReturnPath('https://quasar.example/admin', origin)).toBe('/admin');
    expect(signInReturnPath('/admin?tab=schools#top', origin)).toBe('/admin?tab=schools#top');
  });

  it('falls back to the home page when there is no callback', () => {
    expect(signInReturnPath(null, origin)).toBe('/');
    expect(signInReturnPath('', origin)).toBe('/');
    expect(signInReturnPath('https://quasar.example', origin)).toBe('/');
  });

  it('never sends a retry to another site', () => {
    for (const value of ['https://evil.example/admin', '//evil.example/admin', '/\\evil.example', 'javascript:alert(1)', 'http://quasar.example/admin']) {
      expect(signInReturnPath(value, origin)).toBe('/');
    }
  });
});
