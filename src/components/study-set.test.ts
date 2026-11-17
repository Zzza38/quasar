import { describe, expect, it } from 'vitest';
import { markCard, shuffle, startDeck } from './study-set';

const cards = ['c1', 'c2', 'c3'].map(id => ({ id, front: `${id} front`, back: `${id} back` }));

describe('study set flashcards', () => {
  it('starts with the cards not marked yet, or all of them once every card is known', () => {
    expect(startDeck(cards, ['c2'])).toEqual({ queue: ['c1', 'c3'], known: ['c2'] });
    expect(startDeck(cards, ['c1', 'c2', 'c3'])).toEqual({ queue: ['c1', 'c2', 'c3'], known: [] });
    // Ids from an older set are dropped.
    expect(startDeck(cards, ['c9']).known).toEqual([]);
  });

  it('takes a known card out of the round and sends an "again" card to the back', () => {
    let deck = startDeck(cards, []);
    deck = markCard(deck, false);
    expect(deck).toEqual({ queue: ['c2', 'c3', 'c1'], known: [] });
    deck = markCard(deck, true);
    expect(deck).toEqual({ queue: ['c3', 'c1'], known: ['c2'] });
    deck = markCard(markCard(deck, true), true);
    expect(deck).toEqual({ queue: [], known: ['c2', 'c3', 'c1'] });
    expect(markCard(deck, true)).toBe(deck);
  });

  it('shuffles without losing or repeating anything', () => {
    const order = shuffle(['a', 'b', 'c', 'd'], () => 0);
    expect(order).toEqual(['b', 'c', 'd', 'a']);
    expect([...shuffle(['a', 'b', 'c', 'd'])].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
