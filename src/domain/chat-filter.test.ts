import { describe, expect, it } from 'vitest';
import { censorSlurs, foldConfusables, hasSlur, icePrankNotice, mentionsImmigrants, normalizeForFilter, slurNotice, SLUR_NOTICE } from './chat-filter';

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

  it('treats leet characters and censor marks at the edge of a word as punctuation or letters', () => {
    for (const text of ['shut up faggot!', 'you nigger!!!', 'yo retard!', 'jap!', 'dago!', 'fag1', 'retard1', 'retard!!', 'what a spaz!', '1retard', '*retard*', '#faggot', '$pic', 'pak1', 'n1gger!', 'n i g g e r !'])
      expect(hasSlur(text), text).toBe(true);
    for (const text of ['wow!', 'Hello, World!', 'jap4n', 'sp1cy', 'retard4nt', '*spicy*', 'Japan!', 'cocoon!!', '100%'])
      expect(hasSlur(text), text).toBe(false);
    expect(censorSlurs('shut up faggot!')).toBe('shut up ******!');
    expect(censorSlurs('you nigger!!!')).toBe('you ******!!!');
    expect(censorSlurs('1retard')).toBe('1******');
    expect(censorSlurs('fag1')).toBe('***1');
    expect(censorSlurs('$pic!')).toBe('****!');
  });

  it('sees through invisible characters and lookalike letters', () => {
    for (const text of ['fag\u200bgot', 'f\u200ba\u200bg\u200bg\u200bo\u200bt', 'nig\u200dger', 'ret\u00adard', 'fa\ufeffggot', 'fаggot', 'nіggеr', 'ｆａｇｇｏｔ', 'rеtаrd', 'f\u2060aggot'])
      expect(hasSlur(text), JSON.stringify(text)).toBe(true);
  });

  it('does not match innocent words that contain a stem', () => {
    for (const text of ['raccoon', 'spicy food', 'Japan', 'spices', 'conspicuous', 'cocoon', 'homogeneous', 'Pakistan', 'retardant', 'tardy', 'ABO blood type', 'yiddish', 'sauerkraut', 'spiced', 'a b', 'I am so late', 'fire retardant foam'])
      expect(hasSlur(text), text).toBe(false);
  });

  it('does not join ordinary words across punctuation or read repeated letters into a short stem', () => {
    for (const text of ['is she male or female?', 'my hair got wet, back soon', 'we got wet back there', 'grab a towel. head to the pool', 'the rag. head over',
      'the rag, head down', 'she, male', 'Woop woop', 'Jaap', 'yiid', 'faag'])
      expect(censorSlurs(text), text).toBe(text);
    for (const text of ['wetback', 'wet-back', 'wet_back', 'shemale', 'she-male', 'towelhead', 'towel.head', 'towel-head', 'rag head', 'rag_head', 'jappp', 'faggg', 'woppp'])
      expect(hasSlur(text), text).toBe(true);
  });

  it('does not read a self-censored swear, a bare run of stars or a hashtag as a slur', () => {
    for (const text of ['holy s***', 'what the h***', 'd*** move', 'f***', 'f**', '****', 'check out #pics', '#pics', 'love #food', '#1 fan', 'd*mn', 'b****'])
      expect(censorSlurs(text), text).toBe(text);
    // Two real letters are enough for a censor mark to stand in for a letter, and a hashtag of a slur is still a slur.
    for (const text of ['f*g', 'n*gger', 'sp*c', '#spaz'])
      expect(hasSlur(text), text).toBe(true);
    expect(censorSlurs('#spaz')).toBe('#****');
    expect(censorSlurs('#faggot')).toBe('#******');
  });

  it('leaves asterisk emphasis around ordinary words alone', () => {
    for (const text of ['I am **on** it', 'say **hi**', 'we **got** this', 'the *app* is down', 'my *id* card', '*AP* exam', '*pics*', '*dark*', '*pick*', '**important**'])
      expect(censorSlurs(text), text).toBe(text);
    // Emphasis around a slur is still a slur, and a censor mark between letters is still a wildcard.
    expect(censorSlurs('**faggot**')).toBe('**' + '******' + '**');
    expect(censorSlurs('*coon*')).toBe('*' + '****' + '*');
    for (const text of ['*retard*', 'fa**ot', 'f * g', 'n i g g * r'])
      expect(hasSlur(text), text).toBe(true);
    // The accepted trade-off: a star at the edge of a word is never a letter, so a starred first or last letter passes.
    for (const text of ['*aggot', 'faggo*'])
      expect(hasSlur(text), text).toBe(false);
  });

  it('matches a two-word slur across joining symbols but not across a clause break', () => {
    for (const text of ['towel/head', 'rag+head', 'camel~jockey', 'jungle / bunny', 'curry&muncher', 'slant=eye', 'ching:chong', 'towel\\head', 'porch - monkey'])
      expect(censorSlurs(text), text).toBe('*'.repeat(text.replace(/[^a-z]/g, '').length));
    for (const text of ['grab a towel: head to the pool', 'grab your towel & head out', 'towel + head', 'my towel 😭 head over', 'grab a towel... head out', 'forgot my towel — head to the pool', 'the rag (head down)', 'wet.back', 'she/male'])
      expect(censorSlurs(text), text).toBe(text);
  });

  it('finds a spaced-out slur that follows a one-letter word such as "a", "u" or "i"', () => {
    expect(censorSlurs("you're a f a g g o t")).toBe("you're a ******");
    expect(censorSlurs('u r a f a g lol')).toBe('u r a *** lol');
    expect(censorSlurs('you are a r e t a r d')).toBe('you are a ******');
    expect(censorSlurs('i n i g g e r')).toBe('i ******');
    for (const text of ['r a c c o o n', 'c o c o o n', 'a r e t a r d a n t', 'i a m o k', 'o k a y', 'a b c d'])
      expect(censorSlurs(text), text).toBe(text);
    // The accepted trade-off: a spaced-out word made of one-letter words and a stem is censored.
    expect(censorSlurs('a s p i c')).toBe('a ****');
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

  it('reads tabs and line breaks as word separators, not invisible characters', () => {
    for (const text of ['hi\nfaggot', 'you faggot\nleave now', 'retard\nlol', 'hi\tfaggot', 'a\r\nretard', 'ok\nfaggot\nok', 'spic\ngood', 'x\u0085retard'])
      expect(hasSlur(text), JSON.stringify(text)).toBe(true);
    expect(censorSlurs('hi\nfaggot')).toBe('hi\n******');
    expect(censorSlurs('you faggot\nleave now')).toBe('you ******\nleave now');
    expect(censorSlurs('a\r\nretard\tlol')).toBe('a\r\n******\tlol');
    // Spaced-out letters split by line breaks are still joined.
    expect(hasSlur('r\ne\nt\na\nr\nd')).toBe(true);
    for (const text of ['spicy\nfood', 'Japan\ttrip', 'fire\nretardant'])
      expect(hasSlur(text), JSON.stringify(text)).toBe(false);
    expect(normalizeForFilter('hello\nworld')).toBe('hello world');
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

describe('foldConfusables', () => {
  it('maps lookalikes, accents, invisible characters and, on request, leet digits', () => {
    expect(foldConfusables('Ѕuрр​órt')).toBe('support');
    expect(foldConfusables('ＱＵＡＳＡＲ‮')).toBe('quasar');
    expect(foldConfusables('Supp0rt')).toBe('supp0rt');
    expect(foldConfusables('Supp0rt', { leet: true })).toBe('support');
  });
});
