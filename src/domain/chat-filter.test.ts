import { describe, expect, it } from 'vitest';
import { censorSlurs, hasSlur, icePrankNotice, mentionsImmigrants, normalizeForFilter, slurNotice, SLUR_NOTICE } from './chat-filter';

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

  it('sees through invisible characters and lookalike letters', () => {
    for (const text of ['fag\u200bgot', 'f\u200ba\u200bg\u200bg\u200bo\u200bt', 'nig\u200dger', 'ret\u00adard', 'fa\ufeffggot', 'fаggot', 'nіggеr', 'ｆａｇｇｏｔ', 'rеtаrd', 'f\u2060aggot'])
      expect(hasSlur(text), JSON.stringify(text)).toBe(true);
  });

  it('does not match innocent words that contain a stem', () => {
    for (const text of ['raccoon', 'spicy food', 'Japan', 'spices', 'conspicuous', 'cocoon', 'homogeneous', 'Pakistan', 'retardant', 'tardy', 'ABO blood type', 'yiddish', 'sauerkraut', 'spiced', 'a b', 'I am so late', 'fire retardant foam'])
      expect(hasSlur(text), text).toBe(false);
  });

  it('exposes a fixed notice and never the text', () => {
    expect(slurNotice('what a retard')).toBe(SLUR_NOTICE);
    expect(slurNotice('what a jerk')).toBeNull();
    expect(SLUR_NOTICE).not.toContain('retard');
  });

  it('censors slurs to asterisks and leaves the rest of the message alone', () => {
    expect(censorSlurs('this is a test for the filter: nigger')).toBe('this is a test for the filter: ******');
    expect(censorSlurs('you faggot, fuck off')).toBe('you ******, fuck off');
    expect(censorSlurs('F4GGOT and r3tards')).toBe('****** and *******');
    expect(censorSlurs('fag\u200bgot')).toBe('******');
    expect(censorSlurs('n i g g e r please')).toBe('****** please');
    expect(censorSlurs('fаggot (cyrillic a)')).toBe('****** (cyrillic a)');
    expect(censorSlurs('spicy raccoon in Japan')).toBe('spicy raccoon in Japan');
    expect(censorSlurs('😀 chink 😀')).toBe('😀 ***** 😀');
    expect(censorSlurs('')).toBe('');
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
