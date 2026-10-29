import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_GUIDE_SETS, FEED_PLATFORMS, platformNames, SCHEDULE_PLATFORMS, type GuideSet } from '@/domain/setup-guides';
import { ScheduleSourceGuide } from './schedule-sources';
import { FeedGuide } from './setup-guide';

const DEFAULT_FEED_GUIDES = DEFAULT_GUIDE_SETS.calendar.guides;

const render = (props: Parameters<typeof FeedGuide>[0]) => renderToStaticMarkup(createElement(FeedGuide, props));

describe('FeedGuide', () => {
  it('renders the platforms as keyboard tabs that each name and control the step list shown', () => {
    const html = render({ initial: 'canvas' });
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Where is your homework\?"|aria-label="Where is your homework\?"[^>]*role="tablist"/);
    const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(FEED_PLATFORMS.length);
    expect(tabs.map((tab) => tab.includes('aria-selected="true"'))).toEqual(FEED_PLATFORMS.map((entry) => entry === 'canvas'));
    // Radix roving focus: the tabs are one collection that the arrow keys, Home and End move through, not separate Tab stops.
    for (const tab of tabs) expect(tab).toMatch(/tabindex="-1"[^>]*data-radix-collection-item/);
    const selected = tabs.find((tab) => tab.includes('aria-selected="true"'))!;
    const tabId = selected.match(/ id="([^"]+)"/)![1];
    const panelId = selected.match(/aria-controls="([^"]+)"/)![1];
    const panels = html.match(/<div[^>]*role="tabpanel"[^>]*>/g) ?? [];
    expect(panels).toHaveLength(FEED_PLATFORMS.length);
    const shown = panels.filter((panel) => !/ hidden=""/.test(panel));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(`id="${panelId}"`);
    expect(shown[0]).toContain(`aria-labelledby="${tabId}"`);
    expect(html).toContain('<b class="font-bold text-foreground">Calendar Feed</b>');
    expect(html).not.toContain('Share Calendar');
    expect(html).not.toContain('My school uses something else');
  });

  it('shows only the school’s platform, without tabs, plus a way to the others', () => {
    const guides: GuideSet = { platforms: ['schoology'], guides: { ...DEFAULT_FEED_GUIDES, schoology: { steps: [{ text: 'Click **Export**', image: '0b5e8f9c-3f0e-4d7a-9a51-7c1f3f2b6d10' }], note: 'Ask your teacher.' } } };
    const html = render({ guides, initial: 'canvas' });
    expect(html).not.toContain('role="tab"');
    expect(html).toContain('In Schoology');
    expect(html).toContain('Click <b class="font-bold text-foreground">Export</b>');
    expect(html).toContain('src="/api/guide-images/0b5e8f9c-3f0e-4d7a-9a51-7c1f3f2b6d10"');
    expect(html).toContain('Ask your teacher.');
    expect(html).not.toContain('Calendar Feed');
    expect(html).toContain('My school uses something else');
  });

  it('offers just the school’s platforms as tabs, under their own names', () => {
    const guides: GuideSet = { platforms: ['classroom', 'other'], guides: { ...DEFAULT_FEED_GUIDES, other: { ...DEFAULT_FEED_GUIDES.other, name: 'Blackbaud' } } };
    const tabs = render({ guides }).match(/<button[^>]*role="tab"[^>]*>[^<]*/g) ?? [];
    expect(tabs.map((tab) => tab.replace(/^.*>/, ''))).toEqual(['Google Classroom', 'Blackbaud']);
    expect(platformNames('calendar', guides)).toBe('Google Classroom or Blackbaud');
    expect(platformNames('calendar', { ...guides, platforms: ['schoology', 'canvas', 'other'], guides: DEFAULT_FEED_GUIDES })).toBe('Schoology or Canvas');
    expect(platformNames('calendar', undefined)).toBe('');
  });
});

describe('ScheduleSourceGuide', () => {
  const html = (props: Parameters<typeof ScheduleSourceGuide>[0]) => renderToStaticMarkup(createElement(ScheduleSourceGuide, props));

  it('offers every portal until support picks the school’s, and the Veracross sync only when asked', () => {
    const all = html({});
    expect(all.match(/role="tab"/g)).toHaveLength(SCHEDULE_PLATFORMS.length);
    expect(all).toMatch(/aria-label="Where is your schedule\?"/);
    expect(all).not.toContain('Connect a calendar subscription');
    expect(html({ onConnectFeed: () => {} })).toContain('Connect a calendar subscription');
  });

  it('shows only the school’s portal, with support’s wording', () => {
    const guides: GuideSet = { platforms: ['blackbaud'], guides: { ...DEFAULT_GUIDE_SETS.schedule.guides, blackbaud: { steps: [{ text: 'Open **Resources**' }], note: '' } } };
    const shown = html({ guides, onConnectFeed: () => {} });
    expect(shown).not.toContain('role="tab"');
    expect(shown).toContain('In Blackbaud');
    expect(shown).toContain('Open <b class="font-bold text-foreground">Resources</b>');
    expect(shown).not.toContain('Connect a calendar subscription');
    expect(shown).toContain('My school uses something else');
    expect(platformNames('schedule', guides)).toBe('Blackbaud');
  });
});
