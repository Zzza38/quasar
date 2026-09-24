import { describe, expect, it } from 'vitest';
import { hasSlur, icePrankNotice, mentionsImmigrants, normalizeForFilter, slurError, SLUR_ERROR } from './chat-filter';

describe('chat filter', () => {
  it('lets ordinary swearing through', () => {
    for (const text of ['fuck this homework', 'what the hell', 'shit, I forgot', 'that test was ass', 'damn it', 'bitch please', 'this is bullshit', 'crap', 'dickhead', 'piss off', 'cunt', 'twat', 'bastard'])
      expect(hasSlur(text), text).toBe(false);
  });

  it('blocks slurs as whole words, in any case', () => {
    for (const text of ['you nigger', 'NIGGA what', 'stupid faggot', 'fag', 'shut up retard', 'a chink', 'those spics', 'kike', 'dyke', 'tranny', 'wetbacks', 'towel head', 'porch monkey'])
      expect(hasSlur(text), text).toBe(true);
  });

  it('catches leetspeak, censor marks, repeated letters and spaced-out letters', () => {
    for (const text of ['n1gger', 'n!gga', 'f4ggot', 'f*ggot', 'r3tard', 'fagggggot', 'n i g g e r', 'n.i.g.g.e.r', 'F A G', 'nïgger', 'sp1c', 'ch1nk'])
      expect(hasSlur(text), text).toBe(true);
  });

  it('does not match innocent words that contain a stem', () => {
    for (const text of ['raccoon', 'spicy food', 'Japan', 'spices', 'conspicuous', 'cocoon', 'homogeneous', 'Pakistan', 'retardant', 'tardy', 'ABO blood type', 'yiddish', 'sauerkraut', 'spiced', 'a b', 'I am so late', 'fire retardant foam'])
      expect(hasSlur(text), text).toBe(false);
  });

  it('exposes a fixed error string and never the text', () => {
    expect(slurError('what a retard')).toBe(SLUR_ERROR);
    expect(slurError('what a jerk')).toBeNull();
    expect(SLUR_ERROR).not.toContain('retard');
  });

  it('normalizes without breaking ordinary text', () => {
    expect(normalizeForFilter('Hello, World! 2024')).toBe('hello, worldi 2o2a');
    expect(normalizeForFilter('a b c')).toBe('abc');
    expect(normalizeForFilter('a b')).toBe('a b');
  });

  it('spots immigrants for the prank', () => {
    expect(mentionsImmigrants('we talked about immigrants in history')).toBe(true);
    expect(mentionsImmigrants('an Immigrant family')).toBe(true);
    expect(mentionsImmigrants('immigration policy')).toBe(false);
    expect(mentionsImmigrants('emigrants')).toBe(false);
    expect(icePrankNotice()).toBe('ALERT! ALERT! WORD "IMMIGRANT" DETECTED. Reporting to ICE...');
  });
});
