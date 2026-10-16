import { test, expect, hydrating } from './fixtures';
import type { Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { openDatabase } from '../../src/server/db';
import { MODS } from '../../src/domain/mods';

async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}

test('per-user admin overrides reach the selected account live, persist through reload, and lock every mod', async ({ page, context, browser }) => {
  test.setTimeout(90_000);
  const id = randomUUID(), memberId = randomUUID();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, 'browser-owner@example.com', 'Owner', 'Test Owner', new Date().toISOString());
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(memberId, memberId, 'mod-target@test.dev', 'Mod Target', 'Test Target', new Date().toISOString());
  db.close();
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true }]);
  const visitorContext = await browser.newContext();
  const memberToken = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: memberId, authAt: Date.now() }, maxAge: 3600 });
  await visitorContext.addCookies([{ name: 'next-auth.session-token', value: memberToken, domain: 'localhost', path: '/', httpOnly: true }]);
  const anonymous = await browser.newContext();
  const visitor = hydrating(await visitorContext.newPage());
  try {
    await page.goto('/admin');
    await visitor.goto(new URL('/help', page.url()).href);
    await page.getByRole('tab', { name: 'People', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search members', exact: true }).fill(memberId);
    await page.getByRole('button', { name: 'Open Mod Target', exact: true }).click();
    await page.getByRole('button', { name: 'Fixing their account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Mod overrides' })).toBeVisible();
    for (const mod of MODS) {
      const select = page.getByRole('combobox', { name: `${mod.name} override`, exact: true });
      await choose(select, 'Force on');
      await expect(select).toHaveText('Force on');
      const publicPolicy = await anonymous.request.get(new URL('/api/trpc/mods', page.url()).href);
      expect((await publicPolicy.json()).result.data).toMatchObject({ accountId: null, overrides: { [mod.id]: 'default' } });
      const ownerPolicy = await page.request.get('/api/trpc/mods');
      expect((await ownerPolicy.json()).result.data).toMatchObject({ accountId: id, overrides: { [mod.id]: 'default' } });
      // An open modal holds Shy pieces still while the controls are inspected.
      for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) await visitor.keyboard.press(key);
      const toggle = visitor.getByRole('switch', { name: mod.name, exact: true });
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeDisabled();
      await visitor.reload();
      for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) await visitor.keyboard.press(key);
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeDisabled();
      await choose(select, 'Force off');
      await expect(toggle).not.toBeChecked();
      await expect(toggle).toBeDisabled();
      await visitor.reload();
      for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) await visitor.keyboard.press(key);
      await expect(toggle).not.toBeChecked();
      await expect(toggle).toBeDisabled();
      await choose(select, 'User choice');
      await expect(toggle).toBeEnabled();
      // Keyboard toggling: Playwright never considers a switch stable once Spin keeps it turning.
      await toggle.focus();
      await visitor.keyboard.press('Space');
      await expect(toggle).toBeChecked();
      await visitor.keyboard.press('Space');
      await expect(toggle).not.toBeChecked();
      await visitor.keyboard.press('Escape');
    }
    await visitor.emulateMedia({ reducedMotion: 'reduce' });
    for (const name of ['What Is an Attention Span', "I'm Shy"]) await choose(page.getByRole('combobox', { name: `${name} override`, exact: true }), 'Force on');
    for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) await visitor.keyboard.press(key);
    for (const name of ['What Is an Attention Span', "I'm Shy"]) {
      const toggle = visitor.getByRole('switch', { name, exact: true });
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeDisabled();
    }
    await expect(visitor.locator('html')).not.toHaveAttribute('data-shy-mode', 'true');
    await expect(visitor.getByText('Reduced motion is enabled.', { exact: false })).toBeVisible();
    for (const name of ['What Is an Attention Span', "I'm Shy"]) await choose(page.getByRole('combobox', { name: `${name} override`, exact: true }), 'User choice');
    await page.reload();
    await page.getByRole('tab', { name: 'People', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search members', exact: true }).fill(memberId);
    await page.getByRole('button', { name: 'Open Mod Target', exact: true }).click();
    await page.getByRole('button', { name: 'Fixing their account', exact: true }).click();
    for (const mod of MODS) await expect(page.getByRole('combobox', { name: `${mod.name} override`, exact: true })).toHaveText('User choice');
    await visitor.keyboard.press('Escape');
    await choose(page.getByRole('combobox', { name: 'RGB Mode override', exact: true }), 'Force on');
    await expect(visitor.locator('html')).toHaveAttribute('data-rgb-mode', 'true');
    let held = false, finished = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await visitor.route(/\/api\/trpc\/[^?]*mods[^?]*\?/, async route => {
      if (held) { await route.continue(); return; }
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
      finished = true;
    });
    await expect.poll(() => held).toBe(true);
    await visitorContext.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true }]);
    await visitor.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'nextauth.message' })));
    await expect(visitor.locator('html')).not.toHaveAttribute('data-rgb-mode', 'true');
    release();
    await expect.poll(() => finished).toBe(true);
    await expect(visitor.locator('html')).not.toHaveAttribute('data-rgb-mode', 'true');
    await choose(page.getByRole('combobox', { name: 'RGB Mode override', exact: true }), 'User choice');
  } finally {
    await visitorContext.close();
    await anonymous.close();
    const cleanup = openDatabase(process.env.E2E_DATABASE_PATH!);
    cleanup.prepare('DELETE FROM user_mod_overrides').run();
    cleanup.close();
  }
});
