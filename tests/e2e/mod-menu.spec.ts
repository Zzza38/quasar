import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

const code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
async function enterCode(page: Page, keys = code) {
  for (const key of keys) await page.keyboard.press(key);
}

async function advanceMotion(page: Page, milliseconds: number) {
  for (let remaining = milliseconds; remaining > 0; remaining -= 32) {
    await page.clock.runFor(Math.min(32, remaining));
    await expect.poll(() => page.evaluate(() => !(window as Window & { __shyWorkerStats?: { pending: boolean } }).__shyWorkerStats?.pending), { intervals: [5, 10, 20] }).toBe(true);
  }
}

test('the secret menu opens only after the code and can close and reopen across pages', async ({ page }) => {
  await page.goto('/');
  const menu = page.getByRole('dialog', { name: 'Mod menu', exact: true });
  await expect(menu).toHaveCount(0);
  await enterCode(page, [...code.slice(0, 5), 'x', ...code.slice(5)]);
  await expect(menu).toHaveCount(0);
  await enterCode(page, code.slice(0, -1));
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('a');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('switch', { name: 'RGB Mode', exact: true })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.goto('/help');
  await enterCode(page, ['ArrowUp', ...code.slice(0, -2), 'B', 'A']);
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
  await expect(menu).toHaveCount(0);
});

test('RGB Mode covers the viewport, keeps controls usable, and turns off from the reopened menu', async ({ page }) => {
  await page.goto('/');
  const overlay = page.locator('.rgb-mode-overlay');
  await expect(overlay).toHaveCount(0);
  await enterCode(page);
  const menu = page.getByRole('dialog', { name: 'Mod menu', exact: true });
  const toggle = menu.getByRole('switch', { name: 'RGB Mode', exact: true });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(overlay).toBeVisible();
  expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize()! });
  await expect(overlay).toHaveCSS('pointer-events', 'none');
  await expect(page.locator('html')).toHaveCSS('animation-name', 'rgb-mode-cycle');
  const colors = await page.locator('html').evaluate(element => {
    const animation = element.getAnimations()[0];
    animation.pause();
    animation.currentTime = 0;
    const before = getComputedStyle(document.body).backgroundColor;
    animation.currentTime = 1500;
    return { before, after: getComputedStyle(document.body).backgroundColor };
  });
  expect(colors.after).not.toBe(colors.before);
  await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(overlay).toBeVisible();
  await page.goto('/help');
  await expect(overlay).toHaveCount(0);
  await enterCode(page);
  await toggle.click();
  await page.keyboard.press('Escape');
  await enterCode(page);
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(overlay).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
});

test('RGB Mode uses a static rainbow when reduced motion is preferred', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await enterCode(page);
  await page.getByRole('switch', { name: 'RGB Mode', exact: true }).click();
  const overlay = page.locator('.rgb-mode-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('animation-name', 'none');
  await expect(overlay).toHaveCSS('background-image', /radial-gradient/);
});

test('typing the code in an editable field does not unlock the menu', async ({ page }) => {
  await page.goto('/help');
  await page.evaluate(() => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('aria-label', 'Test editor');
    document.body.append(editor);
    editor.focus();
  });
  await enterCode(page);
  const menu = page.getByRole('dialog', { name: 'Mod menu', exact: true });
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => { document.querySelector<HTMLElement>('[aria-label="Test editor"]')!.remove(); });
  await enterCode(page);
  await expect(menu).toBeVisible();
});

test('Backwards reverses its own label and page text, then restores their original display', async ({ page }) => {
  await page.goto('/help');
  await enterCode(page);
  const toggle = page.getByRole('switch', { name: 'Backwards', exact: true });
  const label = page.getByText('Backwards', { exact: true });
  const characterPositions = () => label.evaluate(element => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 1);
    const first = range.getBoundingClientRect().x;
    range.setStart(text, text.textContent!.length - 1); range.setEnd(text, text.textContent!.length);
    return { first, last: range.getBoundingClientRect().x };
  });
  const normal = await characterPositions();
  expect(normal.first).toBeLessThan(normal.last);
  await toggle.click();
  const reversed = await characterPositions();
  expect(reversed.first).toBeGreaterThan(reversed.last);
  await expect(page.locator('h1').first()).toHaveCSS('unicode-bidi', 'bidi-override');
  await expect(page.locator('h1').first()).toHaveCSS('direction', 'rtl');
  await toggle.click();
  const restored = await characterPositions();
  expect(restored.first).toBeLessThan(restored.last);
  await expect(page.locator('h1').first()).toHaveCSS('direction', 'ltr');
});

test('Backwards preserves the sidebar space and icon positions in expanded and collapsed navigation', async ({ page, context }) => {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  const id = randomUUID();
  try {
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Browser Student', 'Browser Test Student', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Mod Test ${id}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community' });
  } finally { db.close(); }
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true }]);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/today');
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  await expect(sidebar).toBeVisible();
  const inset = page.locator('[data-slot="sidebar-inset"]');
  const before = (await inset.boundingBox())!;
  const link = page.getByRole('link', { name: 'Schedule', exact: true });
  const iconBefore = (await link.locator('svg').boundingBox())!;
  await enterCode(page);
  await page.getByRole('switch', { name: 'Backwards', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const after = (await inset.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x);
  expect(after.width).toBeCloseTo(before.width);
  const side = (await sidebar.boundingBox())!;
  expect(after.x).toBeGreaterThanOrEqual(side.x + side.width);
  const iconAfter = (await link.locator('svg').boundingBox())!;
  expect(iconAfter.x).toBeCloseTo(iconBefore.x);
  const label = (await link.locator('span').first().boundingBox())!;
  expect(iconAfter.x + iconAfter.width).toBeLessThan(label.x);
  await expect(link.locator('span').first()).toHaveCSS('direction', 'rtl');
  await page.getByRole('button', { name: 'Collapse navigation sidebar', exact: true }).click();
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute('data-state', 'collapsed');
  await expect.poll(async () => (await inset.boundingBox())!.x).toBe(56);
  const collapsedSide = (await sidebar.boundingBox())!;
  expect((await inset.boundingBox())!.x).toBeGreaterThanOrEqual(collapsedSide.x + collapsedSide.width);
});

test('Attention Span leaves pages without manually assigned placements alone', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/help');
  const before = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, heading: document.querySelector('h1')!.getBoundingClientRect().toJSON() }));
  await enterCode(page);
  await page.getByRole('switch', { name: 'What Is an Attention Span', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-attention-videos] video')).toHaveCount(0);
  expect(await page.evaluate(() => ({ height: document.documentElement.scrollHeight, heading: document.querySelector('h1')!.getBoundingClientRect().toJSON() }))).toEqual(before);
});

test('buttons and letters both flee independently and restore cleanly', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  const originalText = await button.textContent();
  const originalTranslate = await button.evaluate(element => (element as HTMLElement).style.translate);
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-shy-engine', 'wasm');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await expect(button.locator('[data-shy-glyph]')).toHaveCount(6);
  expect(await page.locator('a[data-shy-particle]').count()).toBeGreaterThan(0);
  expect(await page.locator('h1[data-shy-particle], h2[data-shy-particle]').count()).toBeGreaterThan(0);
  const parent = await button.boundingBox();
  const letters = button.locator('[data-shy-glyph]');
  const first = (await letters.first().boundingBox())!;
  await page.evaluate(() => {
    const original = document.elementFromPoint.bind(document);
    (window as unknown as { shyHitReads: number }).shyHitReads = 0;
    document.elementFromPoint = (x, y) => {
      (window as unknown as { shyHitReads: number }).shyHitReads++;
      return original(x, y);
    };
  });
  await page.clock.install();
  await page.mouse.move(first.x - 5, first.y + first.height + 5);
  await advanceMotion(page, 160);
  expect(await page.evaluate(() => (window as unknown as { shyHitReads: number }).shyHitReads)).toBe(0);
  expect(await letters.evaluateAll(elements => elements.some(element => (element as HTMLElement).style.translate !== ''))).toBe(true);
  expect(await button.evaluate(element => (element as HTMLElement).style.translate)).not.toBe(originalTranslate);
  expect(await button.boundingBox()).not.toEqual(parent);
  const independent = await button.evaluate(element => {
    const offset = (value: string) => value.split(' ').map(parseFloat);
    const button = offset((element as HTMLElement).style.translate);
    return [...element.querySelectorAll<HTMLElement>('[data-shy-glyph]')].some(letter => {
      const local = offset(letter.style.translate);
      return Math.abs(local[0]) > 0.1 || Math.abs(local[1]) > 0.1;
    }) && button.every(Number.isFinite);
  });
  expect(independent).toBe(true);
  await enterCode(page);
  const toggle = page.getByRole('switch', { name: "I'm Shy", exact: true });
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-shy-glyph]')).toHaveCount(0);
  await expect(page.locator('[data-shy-particle]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(await button.textContent()).toBe(originalText);
  expect(await button.evaluate(element => (element as HTMLElement).style.translate)).toBe(originalTranslate);
  await enterCode(page);
  await expect(page.getByRole('dialog', { name: 'Mod menu', exact: true })).toBeVisible();
});

test('pieces can move below the viewport without increasing document size', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const originalHeight = await page.evaluate(() => {
    const piece = document.createElement('button');
    piece.id = 'page-roaming-test';
    piece.textContent = 'x';
    Object.assign(piece.style, { position: 'absolute', left: '8px', top: `${innerHeight - 32}px`, width: '12px', height: '24px' });
    (document.querySelector('main') ?? document.body).append(piece);
    return document.documentElement.scrollHeight;
  });
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-shy-engine', 'wasm');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.clock.install();
  await page.evaluate(() => {
    const piece = document.getElementById('page-roaming-test')!;
    let frames = 0;
    const chase = () => {
      const rect = piece.getBoundingClientRect();
      window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: rect.x + rect.width / 2, clientY: rect.y - 10 }));
      if (++frames < 50) requestAnimationFrame(chase);
    };
    chase();
  });
  await advanceMotion(page, 800);
  const position = await page.locator('#page-roaming-test').boundingBox();
  expect(position!.y).toBeGreaterThan(page.viewportSize()!.height);
  expect(position!.x).toBeGreaterThanOrEqual(7.5);
  expect(position!.x + position!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 7.5);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(originalHeight);
  await page.evaluate(() => {
    document.documentElement.dispatchEvent(new PointerEvent('pointerleave'));
    window.scrollTo(0, 600);
  });
  await advanceMotion(page, 100);
  expect(await page.evaluate(() => window.scrollY)).toBe(600);
  const revealed = await page.locator('#page-roaming-test').boundingBox();
  expect(revealed!.y).toBeLessThan(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(originalHeight);
});

test('covered letters freeze and active letters roam within the existing page', async ({ page }) => {
  await page.goto('/');
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-shy-engine', 'wasm');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.clock.install();
  const backgroundButton = page.getByRole('button', { name: 'Sign in', exact: true, includeHidden: true });
  const background = backgroundButton.locator('[data-shy-glyph]').first();
  const original = (await background.boundingBox())!;
  await page.mouse.move(original.x - 4, original.y + original.height + 4);
  await advanceMotion(page, 80);
  await enterCode(page);
  const menu = page.getByRole('dialog', { name: 'Mod menu', exact: true });
  await expect(menu).toBeVisible();
  const frozenButton = await backgroundButton.evaluate(element => (element as HTMLElement).style.translate);
  const frozen = await background.evaluate(element => (element as HTMLElement).style.translate);
  const target = menu.getByRole('button', { name: 'Close menu', exact: true }).locator('[data-shy-glyph]').first();
  await expect(target).toBeAttached();
  const targetHandle = (await target.elementHandle())!;
  const backgroundHandle = (await background.elementHandle())!;
  for (let frame = 0; frame < 20; frame++) {
    const box = (await targetHandle.boundingBox())!;
    await page.mouse.move(box.x - 4, box.y + box.height + 4);
    await advanceMotion(page, 16);
    expect(await backgroundButton.evaluate(element => (element as HTMLElement).style.translate)).toBe(frozenButton);
    expect(await backgroundHandle.evaluate(element => (element as HTMLElement).style.translate)).toBe(frozen);
    const next = (await targetHandle.boundingBox())!;
    const viewport = page.viewportSize()!;
    const documentBounds = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, scrollY: window.scrollY }));
    expect(next.x).toBeGreaterThanOrEqual(7.5);
    expect(next.y + documentBounds.scrollY).toBeGreaterThanOrEqual(7.5);
    expect(next.x + next.width).toBeLessThanOrEqual(viewport.width - 7.5);
    expect(next.y + next.height + documentBounds.scrollY).toBeLessThanOrEqual(documentBounds.height - 7.5);
  }
  await page.setViewportSize({ width: 800, height: 650 });
  await advanceMotion(page, 100);
  const resized = (await targetHandle.boundingBox())!;
  expect(resized.x + resized.width).toBeLessThanOrEqual(800);
  expect(resized.y + resized.height).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.scrollHeight));
});

test('live text changes and compound characters survive particle mode', async ({ page }) => {
  await page.goto('/help');
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-shy-engine', 'wasm');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const text = document.createElement('p');
    text.id = 'particle-update';
    text.textContent = 'A👨‍👩‍👧‍👦é';
    document.body.append(text);
  });
  await expect(page.locator('#particle-update [data-shy-glyph]')).toHaveCount(3);
  await page.locator('#particle-update').evaluate(element => { element.firstChild!.textContent = 'Updated text'; });
  await expect(page.locator('#particle-update')).toHaveText('Updated text');
  await expect(page.locator('#particle-update [data-shy-glyph]')).toHaveCount(11);
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-shy-text]')).toHaveCount(0);
  await expect(page.locator('#particle-update')).toHaveText('Updated text');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Switch to dark appearance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Switch to light appearance', exact: true })).toBeVisible();
});

test('tabular countdown ticks reuse glyphs without full-page geometry reads', async ({ page }) => {
  await page.goto('/');
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-shy-engine', 'wasm');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const text = document.createElement('p');
    text.id = 'particle-clock';
    text.style.fontVariantNumeric = 'tabular-nums';
    text.textContent = '12:34';
    document.querySelector('main')!.append(text);
  });
  await expect(page.locator('#particle-clock [data-shy-glyph]')).toHaveCount(5);
  const glyph = await page.locator('#particle-clock [data-shy-glyph]').first().elementHandle();
  await page.clock.install();
  const result = await page.evaluate(async () => {
    let reads = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { reads++; return original.call(this); };
    document.getElementById('particle-clock')!.firstChild!.textContent = '12:33';
    await Promise.resolve();
    await Promise.resolve();
    Element.prototype.getBoundingClientRect = original;
    return reads;
  });
  await advanceMotion(page, 32);
  expect(result).toBe(0);
  await expect(page.locator('#particle-clock')).toHaveText('12:33');
  expect(await glyph!.evaluate(element => element.isConnected)).toBe(true);
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#particle-clock')).toHaveText('12:33');
});

test('failed WASM loading keeps physics in the worker with a JavaScript fallback', async ({ page }) => {
  await page.route('**/mods/shy-physics.wasm', route => route.abort());
  await page.goto('/');
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-shy-engine', 'js');
  await page.keyboard.press('Escape');
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  const initial = await button.boundingBox();
  await page.clock.install();
  await page.mouse.move(initial!.x - 5, initial!.y + initial!.height / 2);
  await advanceMotion(page, 160);
  expect(await button.boundingBox()).not.toEqual(initial);
  expect(await page.evaluate(() => (window as Window & { __shyWorkerStats?: { steps: number } }).__shyWorkerStats?.steps)).toBeGreaterThan(0);
  await enterCode(page);
  await page.getByRole('switch', { name: "I'm Shy", exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('html')).not.toHaveAttribute('data-shy-engine');
});

test('manually placed videos use existing blank space without changing layout', async ({ page, context }) => {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  const id = randomUUID();
  try {
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id.slice(0, 4)}@test.dev`, 'Test', 'Test Student', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const schedule = { ...exampleSchedule, periods: [...exampleSchedule.periods, { id: 'E', label: 'E', kind: 'class' as const }],
      cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, slots: [...day.slots, { id: 'late', periodId: 'E', start: '12:00', end: '13:00' }] })) };
    const school = service.createSchool(id, { name: 'Video Test', location: 'Boston, MA', schedule });
    service.join(id, { schoolId: school.id, choice: 'community' });
    const personal = service.entity(id, 'personal')!;
    service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: personal,
      data: { ...personal.data, grade: '9', classes: Array.from({ length: 7 }, (_, index) => ({ id: `class-${index}`, name: `Class ${index + 1}` })),
        assignments: { A: 'class-0', B: 'class-1', C: 'class-2', D: 'class-3', E: 'class-4' } } });
    service.sync(id, { mutationId: randomUUID(), id: 'video-task', kind: 'task', base: null,
      data: { title: 'Test assignment', dueDate: '2026-09-18', dueTime: null, classId: null, notes: '', completed: false } });
  } finally { db.close(); }
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true }]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.clock.setFixedTime(new Date('2026-09-17T12:00:00Z'));
  await page.goto('/today');
  await expect(page.locator('[data-slot="sidebar-container"]')).toBeVisible();
  await enterCode(page);
  await page.getByRole('switch', { name: 'What Is an Attention Span', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await expect(page.locator('[data-attention-slot="sidebar"]').first()).toBeVisible();
  await expect(page.locator('[data-attention-slot="sidebar"]')).toHaveCount(3);
  const video = page.locator('[data-attention-slot="sidebar"]').first();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  const playback = await video.evaluate(element => {
    const video = element as HTMLVideoElement;
    return { time: video.currentTime, duration: video.duration, paused: video.paused, loop: video.loop, muted: video.muted };
  });
  expect(playback.time).toBeGreaterThan(0);
  expect(playback.time).toBeLessThan(playback.duration);
  expect(playback).toMatchObject({ paused: false, loop: true, muted: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  const pausedTime = await video.evaluate(element => (element as HTMLVideoElement).currentTime);
  await page.waitForTimeout(300);
  expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBe(pausedTime);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
  await page.locator('[data-attention-after="today-tasks"]').evaluate(element => { const rect = element.getBoundingClientRect(); window.scrollTo(0, window.scrollY + rect.bottom - 180); });
  await expect(page.locator('[data-attention-slot="today-tasks"]').first()).toBeVisible();
  const snapshot = async (name: string) => {
    const overlaps = await page.evaluate(() => {
      const scope = [...document.querySelectorAll('[role="dialog"]')].find(element => element.getAttribute('data-state') === 'open') ?? document.body;
      const videos = [...scope.querySelectorAll('[data-attention-slot]')].map(element => ({ rect: element.getBoundingClientRect(), zone: element.getAttribute('data-attention-slot') }));
      const obstacles = [...scope.querySelectorAll('button, input, textarea, [data-slot="card"], .app-main li')]
        .filter(element => !element.hasAttribute('data-attention-gap') && !element.closest('[aria-hidden="true"], [inert]') && getComputedStyle(element).visibility !== 'hidden')
        .map(element => ({ rect: element.getBoundingClientRect(), label: element.outerHTML.slice(0, 160) }));
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || !node.parentElement || node.parentElement.closest('script, style, .sr-only, [aria-hidden="true"], [inert]')) continue;
        range.selectNodeContents(node);
        if (getComputedStyle(node.parentElement).visibility === 'hidden') continue;
        obstacles.push(...[...range.getClientRects()].map(rect => ({ rect, label: node.textContent! })));
      }
      return videos.flatMap(video => obstacles.filter(item => { const a = video.rect, b = item.rect; return b.width > 0 && b.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; }).map(item => ({ zone: video.zone, content: item.label, video: video.rect.toJSON(), obstacle: item.rect.toJSON() })));
    });
    expect(overlaps, `Videos cover content on ${name}`).toEqual([]);
    expect(await page.locator('[data-attention-slot]').evaluateAll(elements => elements.every(element => getComputedStyle(element).position === 'static' && element.parentElement?.hasAttribute('data-attention-gap')))).toBe(true);
    await page.screenshot({ path: `/tmp/quasar-${name}-zones.png` });
  };
  for (const name of ['Schedule', 'Tasks', 'Classes', 'School', 'People']) {
    await page.getByRole('link', { name, exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    if (name === 'School') await expect(page.locator('#school-directory-title')).toBeVisible();
    else await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
    if (['Schedule', 'Tasks', 'Classes', 'People'].includes(name)) expect(await page.locator('[data-attention-slot="page-header"]').count()).toBeGreaterThanOrEqual(1);
    const layout = () => page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      cards: [...document.querySelectorAll('.app-main [data-slot="card"], .app-main li, .app-main header')].map(element => element.getBoundingClientRect().toJSON()),
    }));
    const enabled = await layout();
    await enterCode(page);
    await page.getByRole('switch', { name: 'What Is an Attention Span', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    expect(await layout()).toEqual(enabled);
    await enterCode(page);
    await page.getByRole('switch', { name: 'What Is an Attention Span', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    expect(await layout()).toEqual(enabled);
    await snapshot(name.toLowerCase());
    if (name === 'Classes') {
      await page.locator('[data-attention-zone="classes-grid"]').evaluate(element => { const rect = element.getBoundingClientRect(); window.scrollTo(0, window.scrollY + rect.bottom - 350); });
      await expect(page.locator('[data-attention-slot="classes-grid"]')).toHaveCount(2);
      const coverage = await page.locator('li[data-attention-gap="classes-grid"]').filter({ visible: true }).evaluate(element => {
        const host = element.getBoundingClientRect();
        const videos = [...element.querySelectorAll('video')].map(video => video.getBoundingClientRect());
        return { columns: getComputedStyle(element).gridColumnEnd, left: videos[0].left - host.left,
          right: host.right - videos.at(-1)!.right, height: host.height - videos[0].height,
          proportional: [...element.querySelectorAll('video')].every(video => getComputedStyle(video).objectFit === 'cover') };
      });
      expect(coverage).toEqual({ columns: 'span 2', left: 0, right: 0, height: 0, proportional: true });
      await snapshot('classes-grid');
      const beforeScroll = await page.locator('[data-attention-slot="classes-grid"]').first().boundingBox();
      await page.evaluate(() => window.scrollBy(0, 100));
      const afterScroll = await page.locator('[data-attention-slot="classes-grid"]').first().boundingBox();
      expect(afterScroll!.y).toBeCloseTo(beforeScroll!.y - 100, 0);
      await page.setViewportSize({ width: 600, height: 1080 });
      await expect(page.locator('[data-attention-slot="classes-grid"]')).toHaveCount(0);
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
    if (name === 'School') {
      await page.locator('[data-attention-after="school-directory"]').evaluate(element => { const rect = element.getBoundingClientRect(); window.scrollTo(0, window.scrollY + rect.bottom - 180); });
      await expect(page.locator('[data-attention-slot="school-directory"]').first()).toBeVisible();
      await snapshot('school-directory');
    }
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('quasar:open-account')));
  const account = page.getByRole('dialog', { name: 'Account', exact: true });
  await expect(account).toBeVisible();
  await expect(page.locator('[data-attention-slot^="account-"]').first()).toBeVisible();
  await expect(account.locator('[data-attention-slot="account-profile"]')).toHaveCount(1);
  await expect(account.locator('[data-attention-slot="account-photo"]')).toHaveCount(1);
  expect(await account.locator('[data-attention-slot="account-look"]').count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-slot="sidebar-content"] [data-attention-slot="sidebar"]')).toHaveCount(3);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await expect(page.locator('[data-attention-videos]')).toHaveCount(0);
  await snapshot('account');
  await page.locator('[data-attention-zone="account-look"]').scrollIntoViewIfNeeded();
  await snapshot('account-look');
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.locator('[data-attention-zone="account-look"]').scrollIntoViewIfNeeded();
  await snapshot('ipad-account');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1024, height: 1366 });
  await page.getByRole('link', { name: 'Classes', exact: true }).click();
  await expect(page.locator('[data-attention-slot="classes-grid"]')).toHaveCount(2);
  await snapshot('ipad-classes');
});
