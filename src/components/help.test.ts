import { describe, expect, it } from 'vitest';
import { CHAT } from '@/domain/chat';
import { FAQ } from './help';
import { schoolLocks } from './views/school';

const answer = (question: string) => {
  const entry = FAQ.find((item) => item.q === question);
  if (!entry) throw new Error(`Missing FAQ entry: ${question}`);
  return entry.a;
};

describe('Help FAQ', () => {
  it('sends students at a small support-locked school to a correction request, not proposals', () => {
    // A school under 10 members that support locked has no proposals section, so the answer must not promise one there.
    expect(schoolLocks({ supportLocked: true, memberLocked: false, memberCount: 5 })).toEqual({ locked: true, voting: false });
    const bellTimes = answer('A bell time is wrong. How do I fix it?');
    expect(bellTimes).not.toMatch(/If editing is locked, choose “Propose a change”/);
    expect(bellTimes).toMatch(/10 members.*“Propose a change”/);
    expect(bellTimes).toMatch(/support locked the schedule.*“Request a correction”/);
  });

  it('qualifies the chat retention promise with how long reported messages are kept', () => {
    const deletion = answer('How do I sign out or delete my data?');
    expect(deletion).toContain(`deleted automatically ${CHAT.retentionDays} days after they are sent`);
    expect(deletion).toContain(`until ${CHAT.evidenceDays} days after the report is closed`);
    expect(deletion).toContain('Deleting a whole account is not available yet');
  });
});
