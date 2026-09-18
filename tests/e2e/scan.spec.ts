import { test, expect, type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { DirectoryService } from '../../src/server/directory';
import { exampleSchedule } from '../../src/domain/example';

/** Stands in for any OpenAI-compatible vision provider; the config points SCAN_API_URL here. */
const MOCK_PORT = Number(new URL(process.env.SCAN_API_URL ?? 'http://127.0.0.1:3199/v1').port);
let mock: Server;
const requests: Array<{ model: string; image: string; prompt: string }> = [];
let directoryId = '';

test.beforeAll(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const parts = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      requests.push({ model: body.model, image: parts[1].image_url!.url, prompt: parts[0].text! });
      const rows = [
        { className: 'Algebra II', periodId: 'A', directoryId, days: ['Day 1', 'Day 3'] },
        { className: 'World History', teacher: 'Mr. Adeyemi', room: '118', periodLabel: 'B' },
        { className: 'Study Hall', periodLabel: 'Flex' },
      ];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows }) } }] }));
    });
  });
  await new Promise<void>(resolve => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise<void>(resolve => mock.close(() => resolve())); });

function seed() {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${id}@example.com`, 'Browser Student', 'Browser Test Student', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Scan High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    directoryId = new DirectoryService(service).save(id, { schoolId: school.id, details: { name: 'Algebra II', teacher: 'Ms. Ortiz', room: '204', grades: ['9'] } }).id;
    return { id, school };
  } finally { db.close(); }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}


test('scans a timetable photo, lets the student review it, and places the classes', async ({ page, context }, testInfo) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#classes');
  // A real PNG for the browser's image decoder: a screenshot of the page itself.
  const PNG = await page.screenshot({ type: 'png' });
  await page.getByRole('button', { name: 'Scan timetable' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Scan your timetable' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Read schedule' })).toBeDisabled();
  await dialog.getByLabel('Choose a timetable photo').setInputFiles({ name: 'timetable.png', mimeType: 'image/png', buffer: PNG });
  await expect(dialog.getByRole('img', { name: 'Your timetable photo' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Read schedule' }).click();

  await expect(dialog.getByText('3 classes were found.')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe('mock-vision');
  expect(requests[0].image).toMatch(/^data:image\/jpeg;base64,/);
  expect(requests[0].prompt).toContain(directoryId);
  const rows = dialog.getByRole('list', { name: 'Classes read from the photo' }).getByRole('listitem');
  await expect(rows.nth(0).getByLabel('Class')).toHaveValue('Algebra II');
  await expect(rows.nth(0).getByLabel('Teacher')).toHaveValue('Ms. Ortiz');
  await expect(rows.nth(0).getByLabel('Room')).toHaveValue('204');
  await expect(rows.nth(0).getByLabel('Period')).toHaveValue('A');
  await expect(rows.nth(0).getByText('From the school directory')).toBeVisible();
  await expect(rows.nth(1).getByLabel('Period')).toHaveValue('B');
  await expect(rows.nth(2).getByText('Period “Flex” not matched')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('scan-review.png'), fullPage: true });

  // Fix a misread room and leave study hall out.
  await rows.nth(1).getByLabel('Room').fill('119');
  await rows.nth(2).getByLabel('Include').uncheck();
  await dialog.getByRole('button', { name: 'Add 2 classes' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ }).first()).toBeVisible();
  const cards = page.getByRole('list', { name: 'Your classes' }).getByRole('listitem');
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'Algebra II' })).toContainText('Room 204 · Ms. Ortiz');
  await expect(cards.filter({ hasText: 'World History' })).toContainText('Room 119 · Mr. Adeyemi');
  await expect(cards.filter({ hasText: 'World History' }).getByText('B', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('scan-placed.png'), fullPage: true });
});
