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

test('admin overrides reach another visitor live, persist through reload, and lock every mod', async ({ page, context, browser }) => {
  const id = randomUUID();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, 'browser-owner@example.com', 'Owner', 'Test Owner', new Date().toISOString());
  db.close();
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true }]);
  const visitorContext = await browser.newContext();
  const visitor = hydrating(await visitorContext.newPage());
  try {
    await page.goto('/admin');
    await visitor.goto(new URL('/help', page.url()).href);
    await page.getByRole('tab', { name: 'Mods', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Mod overrides' })).toBeVisible();
    for (const mod of MODS) {
      const select = page.getByRole('combobox', { name: `${mod.name} override`, exact: true });
      await choose(select, 'Force on');
      await expect(select).toHaveText('Force on');
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
      await toggle.click();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await visitor.keyboard.press('Escape');
    }
    await page.reload();
    await page.getByRole('tab', { name: 'Mods', exact: true }).click();
    for (const mod of MODS) await expect(page.getByRole('combobox', { name: `${mod.name} override`, exact: true })).toHaveText('User choice');
  } finally {
    await visitorContext.close();
    const cleanup = openDatabase(process.env.E2E_DATABASE_PATH!);
    cleanup.prepare('DELETE FROM mod_overrides').run();
    cleanup.close();
  }
});
