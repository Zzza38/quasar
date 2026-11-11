import { describe, expect, it } from 'vitest';
import { receiptGroups, receiptsFor, receiptStatus } from './messages';

const member = (id: string, readSeq: number, deliveredSeq: number, joinedAt?: string) => ({ id, displayName: id, avatar: null, readSeq, deliveredSeq, typing: false, joinedAt });

describe('group receipts', () => {
  const bob = member('Bob', 5, 5, '2026-11-01T10:00:00.000Z');
  const cara = member('Cara', 2, 5, '2026-11-01T10:00:00.000Z');
  const dan = member('Dan', 0, 0, '2026-11-01T10:00:00.000Z');
  // Eve was added after the message: her markers start at the newest seq, but the message is not hers to read.
  const eve = member('Eve', 5, 5, '2026-11-03T10:00:00.000Z');

  it('sorts everyone into read, delivered or waiting', () => {
    const groups = receiptGroups(4, [bob, cara, dan]);
    expect(groups.read.map((entry) => entry.id)).toEqual(['Bob']);
    expect(groups.delivered.map((entry) => entry.id)).toEqual(['Cara']);
    expect(groups.waiting.map((entry) => entry.id)).toEqual(['Dan']);
  });

  it('leaves out members who joined after the message was sent', () => {
    const sentAt = '2026-11-02T10:00:00.000Z';
    expect(receiptsFor(sentAt, [bob, cara, eve]).map((entry) => entry.id)).toEqual(['Bob', 'Cara']);
    expect(receiptStatus(4, receiptsFor(sentAt, [bob, cara, eve]), true)?.label).toBe('Read by 1');
    expect(receiptStatus(4, receiptsFor('2026-11-04T10:00:00.000Z', [bob, eve]), true)?.label).toBe('Read by everyone');
  });

  it('keeps one-to-one receipts, which carry no join time', () => {
    const peer = [member('Bob', 5, 5)];
    expect(receiptsFor('2026-11-02T10:00:00.000Z', peer)).toBe(peer);
  });
});
