import { test as base, type Page } from '@playwright/test';

/**
 * Pages arrive rendered by the server, so a control can be on screen before React has hydrated and attached its
 * handlers; typing into it that early is lost. `<html data-hydrated>` is set once the page is interactive
 * (ThemeSync in src/lib/theme.ts), and every navigation here waits for it, except a `commit`-only goto that wants
 * the pre-hydration document on purpose.
 */
export async function interactive(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 20_000 });
}

/** Makes `goto` and `reload` on this page wait for hydration. Use it on every page a test creates itself. */
export function hydrating(page: Page): Page {
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = async (url, options) => {
    const response = await goto(url, options);
    if (options?.waitUntil !== 'commit' && response?.ok()) await interactive(page);
    return response;
  };
  page.reload = async (options) => {
    const response = await reload(options);
    if (options?.waitUntil !== 'commit' && response?.ok()) await interactive(page);
    return response;
  };
  return page;
}

export const test = base.extend({
  page: async ({ page }, use) => { await use(hydrating(page)); },
});
export { expect } from '@playwright/test';
