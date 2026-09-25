import { linkParts } from './chat';

/**
 * The small, chat-friendly markdown subset a message can carry (docs/CHAT.md §13). It is parsed into a tree the
 * bubble renders as React nodes, so there is never any HTML: `**bold**`, `_italic_` or `*italic*`, `~~struck~~`,
 * `` `code` ``, fenced ``` code blocks, `> quotes` and `-`/`1.` lists. Links stay what §3.6 makes them: only a bare
 * `https://` URL becomes a link, and its visible text is always the whole URL, so `[text](url)` is deliberately not
 * supported (it would hide the host). Every newline is a line break, as in any chat.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'strike'; children: Inline[] };

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; lines: Inline[][] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] };

/** A character of the text, or a link that the inline scanner treats as one opaque, non-space atom. */
type Atom = string | { href: string; text: string };

const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?/;
const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+/;

const isSpace = (atom: Atom | undefined): boolean => typeof atom === 'string' && /\s/u.test(atom);
const isWordChar = (atom: Atom | undefined): boolean => typeof atom === 'string' && /[\p{L}\p{N}]/u.test(atom);

function toAtoms(text: string): Atom[] {
  const atoms: Atom[] = [];
  for (const part of linkParts(text)) {
    if (part.href) atoms.push({ href: part.href, text: part.text });
    else atoms.push(...part.text);
  }
  return atoms;
}

function runIs(atoms: Atom[], at: number, marker: string): boolean {
  for (let offset = 0; offset < marker.length; offset += 1) if (atoms[at + offset] !== marker[offset]) return false;
  return true;
}

/** The delimiters, longest first so `**` and `~~` are tried before `*`. */
const MARKERS: Array<{ marker: string; kind: 'strong' | 'em' | 'strike' }> = [
  { marker: '**', kind: 'strong' }, { marker: '~~', kind: 'strike' }, { marker: '*', kind: 'em' }, { marker: '_', kind: 'em' },
];

/**
 * True when the run of the marker's character starting at `at` is exactly the marker: not preceded by the same
 * character and not followed by it. A longer run (`***`, the `******` a censored slur leaves behind, `~~~`) is never
 * a delimiter, so it stays plain text.
 */
function exactRun(atoms: Atom[], at: number, marker: string): boolean {
  const char = marker[0]!;
  return runIs(atoms, at, marker) && atoms[at - 1] !== char && atoms[at + marker.length] !== char;
}

/**
 * Where the delimiter run at `at` closes, or -1. An opener must be followed by something that is not a space and,
 * for `_`, not preceded by a letter (so snake_case_names stay plain); a closer must follow something that is not a
 * space and, for `_`, not run straight into a letter. Both must be exact runs (see exactRun).
 */
function closerOf(atoms: Atom[], at: number, end: number, marker: string): number {
  const size = marker.length;
  if (!exactRun(atoms, at, marker) || at + size >= end || isSpace(atoms[at + size])) return -1;
  if (marker === '_' && isWordChar(atoms[at - 1])) return -1;
  for (let close = at + size + 1; close + size <= end; close += 1) {
    if (!exactRun(atoms, close, marker) || isSpace(atoms[close - 1])) continue;
    if (marker === '_' && isWordChar(atoms[close + size])) continue;
    return close;
  }
  return -1;
}

function parseInlineAtoms(atoms: Atom[], start: number, end: number): Inline[] {
  const nodes: Inline[] = [];
  let buffer = '';
  const flush = () => { if (buffer) { nodes.push({ kind: 'text', text: buffer }); buffer = ''; } };
  let at = start;
  while (at < end) {
    const atom = atoms[at]!;
    if (typeof atom !== 'string') { flush(); nodes.push({ kind: 'link', text: atom.text, href: atom.href }); at += 1; continue; }
    if (atom === '`') {
      let close = at + 1;
      while (close < end && atoms[close] !== '`') close += 1;
      if (close < end && close > at + 1) {
        flush();
        nodes.push({ kind: 'code', text: atoms.slice(at + 1, close).map((entry) => (typeof entry === 'string' ? entry : entry.text)).join('') });
        at = close + 1;
        continue;
      }
    }
    let matched = false;
    for (const { marker, kind } of MARKERS) {
      if (!runIs(atoms, at, marker)) continue;
      const close = closerOf(atoms, at, end, marker);
      if (close < 0) continue;
      flush();
      nodes.push({ kind, children: parseInlineAtoms(atoms, at + marker.length, close) });
      at = close + marker.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buffer += atom;
    at += 1;
  }
  flush();
  return nodes;
}

/** The inline tree of one line (or any run of text without block markers). */
export function parseInline(text: string): Inline[] {
  const atoms = toAtoms(text);
  return parseInlineAtoms(atoms, 0, atoms.length);
}

/** The block tree of a whole message body. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (FENCE.test(line)) {
      let close = at + 1;
      while (close < lines.length && !FENCE.test(lines[close]!)) close += 1;
      blocks.push({ kind: 'code', text: lines.slice(at + 1, close).join('\n') });
      at = close + 1;
      continue;
    }
    if (!line.trim()) { at += 1; continue; }
    if (QUOTE.test(line)) {
      const quoted: Inline[][] = [];
      while (at < lines.length && QUOTE.test(lines[at]!)) { quoted.push(parseInline(lines[at]!.replace(QUOTE, ''))); at += 1; }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered || BULLET.test(line)) {
      const ordered = !!numbered;
      const items: Inline[][] = [];
      while (at < lines.length && (ordered ? NUMBERED.test(lines[at]!) : BULLET.test(lines[at]!))) {
        items.push(parseInline(lines[at]!.replace(ordered ? NUMBERED : BULLET, '')));
        at += 1;
      }
      blocks.push({ kind: 'list', ordered, start: numbered ? Number(numbered[1]) : 1, items });
      continue;
    }
    const paragraph: Inline[][] = [];
    while (at < lines.length && lines[at]!.trim() && !FENCE.test(lines[at]!) && !QUOTE.test(lines[at]!) && !BULLET.test(lines[at]!) && !NUMBERED.test(lines[at]!)) {
      paragraph.push(parseInline(lines[at]!));
      at += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

function inlineText(nodes: Inline[]): string {
  return nodes.map((node) => (node.kind === 'text' || node.kind === 'link' || node.kind === 'code' ? node.text : inlineText(node.children))).join('');
}

/**
 * The message without its markup, for list previews, task titles and anywhere else one line of plain text is
 * wanted. Lists keep a bullet or number so "1. milk 2. eggs" still reads as a list once collapsed to one line.
 */
export function plainText(text: string): string {
  return parseMarkdown(text).map((block) => {
    if (block.kind === 'code') return block.text;
    if (block.kind === 'list') return block.items.map((item, index) => `${block.ordered ? `${block.start + index}.` : '•'} ${inlineText(item)}`).join('\n');
    return block.lines.map(inlineText).join('\n');
  }).join('\n');
}

/** True when the body carries any markup the bubble would render differently from the raw text. */
export function hasMarkup(text: string): boolean {
  return plainText(text) !== text;
}
