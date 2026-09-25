import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChoiceGroup, ChoiceItem, Field, fieldAria, fieldLink, Input, OptionCard, Section, Textarea, WeekStrip, selectModel } from './primitives';

const option = (value: string, label: string, disabled = false) => createElement('option', { key: `${value}:${label}`, value, disabled }, label);

describe('Select value model', () => {
  it('round trips item values, including a selectable empty option', () => {
    const model = selectModel([option('', 'No class'), option('math', 'Math'), createElement(Fragment, { key: 'more' }, option('art', 'Art'))]);
    expect(model.items.map((item) => item.value)).toEqual(['', 'math', 'art']);
    expect(model.decode(model.encode(''))).toBe('');
    expect(model.decode(model.encode('math'))).toBe('math');
    expect(model.decode(model.encode('art'))).toBe('art');
  });

  it('ignores values that are not one of the options, such as the stray empty value from the hidden form select', () => {
    const plain = selectModel([option('math', 'Math'), option('art', 'Art')]);
    expect(plain.decode('')).toBeNull();
    expect(plain.decode('removed-class')).toBeNull();
    const withPlaceholder = selectModel([option('', 'Choose one', true), option('10', '10 minutes before')]);
    expect(withPlaceholder.placeholder?.value).toBe('');
    expect(withPlaceholder.encode('')).toBe('');
    expect(withPlaceholder.decode('')).toBeNull();
    expect(withPlaceholder.decode('10')).toBe('10');
    const withEmpty = selectModel([option('', 'No reminder'), option('10', '10 minutes before')]);
    expect(withEmpty.decode('')).toBeNull();
  });
});

describe('Select option collection', () => {
  it('keeps a disabled placeholder apart from a selectable empty option when both are present', () => {
    const model = selectModel([option('', 'Choose a class', true), option('', 'No class'), option('math', 'Math')]);
    expect(model.placeholder?.label).toBe('Choose a class');
    expect(model.items.map((item) => [item.value, item.label])).toEqual([['', 'No class'], ['math', 'Math']]);
    // The selectable empty option takes the sentinel, so choosing it is not mistaken for "nothing chosen".
    expect(model.encode('')).toBe('__empty__');
    expect(model.decode('__empty__')).toBe('');
  });

  it('never gives Radix an empty item value', () => {
    const model = selectModel([option('', 'None'), option('a', 'A')]);
    expect(model.items.map((item) => model.encode(item.value))).not.toContain('');
  });

  it('uses the text as the value of a value-less option, flattens nested fragments and skips anything that is not an option', () => {
    const model = selectModel([
      createElement('option', { key: 'plain' }, 'Plain'),
      createElement(Fragment, { key: 'outer' }, createElement(Fragment, null, option('deep', 'Deep'))),
      createElement('optgroup', { key: 'group', label: 'Group' }, option('grouped', 'Grouped')),
      'stray text', null, false,
    ]);
    expect(model.items.map((item) => item.value)).toEqual(['Plain', 'deep']);
    expect(model.decode('grouped')).toBeNull();
  });

  it('keeps a disabled non-empty option as a disabled item', () => {
    const model = selectModel([option('a', 'A', true), option('b', 'B')]);
    expect(model.placeholder).toBeUndefined();
    expect(model.items.map((item) => item.disabled)).toEqual([true, false]);
  });
});

describe('Field description links', () => {
  it('points the labelled control at the visible hint, or at the error instead of the hint', () => {
    expect(fieldAria(fieldLink('name', 'At least 10 characters.', undefined), 'name', {})).toEqual({ 'aria-describedby': 'name-hint', 'aria-invalid': undefined });
    expect(fieldAria(fieldLink('name', 'At least 10 characters.', 'Too short'), 'name', {})).toEqual({ 'aria-describedby': 'name-error', 'aria-invalid': true });
    expect(fieldAria(fieldLink('name', undefined, undefined), 'name', {})).toEqual({ 'aria-describedby': undefined, 'aria-invalid': undefined });
  });

  it('keeps the caller’s own description and invalid state, and leaves other controls alone', () => {
    const link = fieldLink('note', 'Optional', undefined);
    expect(fieldAria(link, 'note', { 'aria-describedby': 'crisis' })['aria-describedby']).toBe('crisis note-hint');
    expect(fieldAria(fieldLink('note', undefined, 'Bad'), 'note', { 'aria-invalid': false })['aria-invalid']).toBe(false);
    expect(fieldAria(link, 'other', { 'aria-describedby': 'x' })).toEqual({ 'aria-describedby': 'x' });
    expect(fieldAria(fieldLink(undefined, 'Hint', undefined), 'note', {})).toEqual({});
  });

  it('renders the hint and error with the ids the input points at', () => {
    const hinted = renderToStaticMarkup(createElement(Field, { label: 'Summary', htmlFor: 'summary', hint: 'At least 10 characters.', children: createElement(Textarea, { id: 'summary' }) }));
    expect(hinted).toContain('aria-describedby="summary-hint"');
    expect(hinted).toContain('id="summary-hint"');
    const failed = renderToStaticMarkup(createElement(Field, { label: 'Date', htmlFor: 'date', hint: 'Unused', error: 'Another exception already uses this date.', children: createElement(Input, { id: 'date', type: 'date' }) }));
    expect(failed).toContain('aria-describedby="date-error"');
    expect(failed).toContain('aria-invalid="true"');
    expect(failed).toContain('id="date-error"');
    expect(failed).not.toContain('date-hint');
  });

  it('shows a failure that is not about the value without marking the control invalid', () => {
    expect(fieldAria(fieldLink('class', 'Applies on A.', 'Could not save.', false), 'class', {})).toEqual({ 'aria-describedby': 'class-error', 'aria-invalid': undefined });
    const html = renderToStaticMarkup(createElement(Field, { label: 'Class', htmlFor: 'class', error: 'Sign in again to save changes.', invalid: false, children: createElement(Input, { id: 'class' }) }));
    expect(html).toContain('aria-describedby="class-error"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('aria-invalid=');
  });
});

describe('ChoiceGroup', () => {
  it('renders option cards as radios in one roving-focus radiogroup, so arrow keys move between them', () => {
    const html = renderToStaticMarkup(createElement(ChoiceGroup, { label: 'Schedule type', value: 'ab', onChange: () => {}, children: [
      createElement(OptionCard, { key: 'same', value: 'same', title: 'Same every day', description: 'One bell schedule.' }),
      createElement(OptionCard, { key: 'ab', value: 'ab', title: 'A / B days', description: 'Two alternating days.' }),
    ] }));
    expect(html).toMatch(/^<div[^>]*role="radiogroup"[^>]*aria-label="Schedule type"/);
    const radios = html.match(/<button[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    // Radix roving focus: every item is a collection item and none is its own Tab stop until the group takes focus.
    for (const radio of radios) expect(radio).toMatch(/role="radio"[^>]*tabindex="-1"[^>]*data-radix-collection-item/);
    expect(radios[0]).toContain('aria-checked="false"');
    expect(radios[1]).toContain('aria-checked="true"');
    expect(radios[1]).toContain('data-state="on"');
  });

  it('leaves every item unchecked when nothing is chosen yet, and passes labels through to bare items', () => {
    const html = renderToStaticMarkup(createElement(ChoiceGroup, { label: 'Accent color', value: null, onChange: () => {}, children: [
      createElement(ChoiceItem, { key: 'ocean', value: 'ocean', 'aria-label': 'Ocean', title: 'Ocean' }),
      createElement(ChoiceItem, { key: 'rose', value: 'rose', 'aria-label': 'Rose', title: 'Rose' }),
    ] }));
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Rose"');
  });
});

describe('Section', () => {
  it('is a region named by its heading, since a plain div cannot carry a name', () => {
    const html = renderToStaticMarkup(createElement(Section, { id: 'tasks-title', title: 'Tasks' }, 'Body'));
    expect(html).toMatch(/^<div[^>]*role="region"[^>]*aria-labelledby="tasks-title"/);
    expect(html).toContain('<h2 id="tasks-title"');
  });
});

describe('WeekStrip', () => {
  it('marks today with aria-current, not only with a ring', () => {
    const days = ['2026-09-23', '2026-09-24', '2026-09-25'].map((date) => ({ date, caption: 'Day 1', label: date }));
    const html = renderToStaticMarkup(createElement(WeekStrip, { days, selected: '2026-09-25', today: '2026-09-24', onSelect: () => {} }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.includes('aria-current="date"'))).toEqual([false, true, false]);
    expect(buttons[2]).toContain('aria-pressed="true"');
  });
});
