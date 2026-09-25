import { describe, expect, it } from 'vitest';
import { hasMarkup, parseInline, parseMarkdown, plainText, type Inline } from './markdown';

const text = (value: string): Inline => ({ kind: 'text', text: value });

describe('parseInline', () => {
  it('renders bold, italic, strikethrough and code', () => {
    expect(parseInline('**due** _tomorrow_ *ok* ~~not friday~~ `x = 1`')).toEqual([
      { kind: 'strong', children: [text('due')] }, text(' '),
      { kind: 'em', children: [text('tomorrow')] }, text(' '),
      { kind: 'em', children: [text('ok')] }, text(' '),
      { kind: 'strike', children: [text('not friday')] }, text(' '),
      { kind: 'code', text: 'x = 1' },
    ]);
  });
  it('nests emphasis and keeps unmatched markers as text', () => {
    expect(parseInline('**really _important_**')).toEqual([{ kind: 'strong', children: [text('really '), { kind: 'em', children: [text('important')] }] }]);
    expect(parseInline('5 * 3 = 15 and 2*3')).toEqual([text('5 * 3 = 15 and 2*3')]);
    expect(parseInline('**unclosed and _also')).toEqual([text('**unclosed and _also')]);
    expect(parseInline('** spaced **')).toEqual([text('** spaced **')]);
  });
  it('leaves longer runs alone, so a censored slur (asterisks) never turns into formatting', () => {
    expect(parseInline('shut up ******')).toEqual([text('shut up ******')]);
    expect(parseInline('***three***')).toEqual([text('***three***')]);
    expect(parseInline('wow ~~~ ok')).toEqual([text('wow ~~~ ok')]);
  });
  it('leaves underscores inside words alone', () => {
    expect(parseInline('my_file_name.txt and snake_case')).toEqual([text('my_file_name.txt and snake_case')]);
    expect(parseInline('_whole word_')).toEqual([{ kind: 'em', children: [text('whole word')] }]);
  });
  it('keeps https links whole, markers inside them included, and never links markdown link syntax', () => {
    expect(parseInline('see https://a.example/some_path_here*x now')).toEqual([text('see '), { kind: 'link', text: 'https://a.example/some_path_here*x', href: 'https://a.example/some_path_here*x' }, text(' now')]);
    expect(parseInline('**go https://a.example/x**')).toEqual([{ kind: 'strong', children: [text('go '), { kind: 'link', text: 'https://a.example/x', href: 'https://a.example/x' }] }]);
    expect(parseInline('[click](https://evil.example)')).toEqual([text('[click]('), { kind: 'link', text: 'https://evil.example', href: 'https://evil.example' }, text(')')]);
  });
  it('does not format inside a code span', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
    expect(parseInline('a ` b')).toEqual([text('a ` b')]);
  });
  it('handles emoji and other astral characters as single atoms', () => {
    expect(parseInline('**🎉 party**')).toEqual([{ kind: 'strong', children: [text('🎉 party')] }]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps line breaks inside them', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { kind: 'paragraph', lines: [[text('one')], [text('two')]] },
      { kind: 'paragraph', lines: [[text('three')]] },
    ]);
  });
  it('parses quotes, lists and fenced code', () => {
    expect(parseMarkdown('> quoted\n> again\n- milk\n- eggs\n1. first\n2) second\n```\nlet x = **1**;\n```\nafter')).toEqual([
      { kind: 'quote', lines: [[text('quoted')], [text('again')]] },
      { kind: 'list', ordered: false, start: 1, items: [[text('milk')], [text('eggs')]] },
      { kind: 'list', ordered: true, start: 1, items: [[text('first')], [text('second')]] },
      { kind: 'code', text: 'let x = **1**;' },
      { kind: 'paragraph', lines: [[text('after')]] },
    ]);
  });
  it('closes an unterminated fence at the end and treats a lone bullet-less dash as text', () => {
    expect(parseMarkdown('```js\ncode')).toEqual([{ kind: 'code', text: 'code' }]);
    expect(parseMarkdown('5 - 3 = 2\n-nope')).toEqual([{ kind: 'paragraph', lines: [[text('5 - 3 = 2')], [text('-nope')]] }]);
  });
  it('starts a numbered list where the message does', () => {
    expect(parseMarkdown('3. third\n4. fourth')).toEqual([{ kind: 'list', ordered: true, start: 3, items: [[text('third')], [text('fourth')]] }]);
  });
});

describe('plainText and hasMarkup', () => {
  it('strips markers and keeps list markers readable', () => {
    expect(plainText('**Bring** _the_ ~~old~~ `form`')).toBe('Bring the old form');
    expect(plainText('- milk\n- eggs')).toBe('• milk\n• eggs');
    expect(plainText('2. two\n3. three')).toBe('2. two\n3. three');
    expect(plainText('> quote\n\n```\ncode\n```')).toBe('quote\ncode');
    expect(plainText('see https://a.example/x')).toBe('see https://a.example/x');
  });
  it('says whether the raw text differs from its rendering', () => {
    expect(hasMarkup('plain text with 2*3 and a_b')).toBe(false);
    expect(hasMarkup('**bold**')).toBe(true);
  });
});
