import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEED_SOURCES, FeedGuide } from './feed-guide';

describe('FeedGuide', () => {
  it('renders the sources as keyboard tabs that each name and control the step list shown', () => {
    const html = renderToStaticMarkup(createElement(FeedGuide, { initial: 'canvas' }));
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Where is your homework\?"|aria-label="Where is your homework\?"[^>]*role="tablist"/);
    const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(FEED_SOURCES.length);
    expect(tabs.map((tab) => tab.includes('aria-selected="true"'))).toEqual(FEED_SOURCES.map((entry) => entry.id === 'canvas'));
    // Radix roving focus: the tabs are one collection that the arrow keys, Home and End move through, not separate Tab stops.
    for (const tab of tabs) expect(tab).toMatch(/tabindex="-1"[^>]*data-radix-collection-item/);
    const selected = tabs.find((tab) => tab.includes('aria-selected="true"'))!;
    const tabId = selected.match(/ id="([^"]+)"/)![1];
    const panelId = selected.match(/aria-controls="([^"]+)"/)![1];
    const panels = html.match(/<div[^>]*role="tabpanel"[^>]*>/g) ?? [];
    expect(panels).toHaveLength(FEED_SOURCES.length);
    const shown = panels.filter((panel) => !/ hidden=""/.test(panel));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(`id="${panelId}"`);
    expect(shown[0]).toContain(`aria-labelledby="${tabId}"`);
    expect(html).toContain('Calendar Feed');
    expect(html).not.toContain('Share Calendar');
  });
});
