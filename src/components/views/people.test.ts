import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BetaProvider } from '../betas';
import { MemberRow, verificationNotice, type Member } from './people';

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

describe('role badges on People', () => {
  const member: Member = { id: 'student', staff: 'school-manager', displayName: 'Casey', fullName: null, grade: null, verified: true,
    joinedAt: '2026-09-01', friendState: 'none', blocked: false, avatar: null };
  const badge = (beta: boolean, person: Member) => renderToStaticMarkup(createElement(BetaProvider, {
    accountId: 'viewer', online: true, refresh: async () => {}, betas: beta ? [{ key: 'staff-roles', name: 'Staff roles', public: false, description: '', joinedAt: '2026-01-01' }] : [],
    children: createElement(MemberRow, { member: person, onOpen: () => {} }),
  }));

  it('shows the assigned role beside a member’s name only when the viewer joined the beta', () => {
    expect(badge(true, member)).toContain('>School Manager<');
    expect(badge(false, member)).not.toContain('School Manager');
    expect(badge(true, { ...member, staff: null })).not.toContain('School Manager');
  });
});
