/** Browser-only hook regression: no app server or production data is used. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { build } = require(createRequire(require.resolve('tsx')).resolve('esbuild'));
let browser: Browser;
let page: Page;
let bundle: string;

beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot, hydrateRoot } from 'react-dom/client';
      import { useChatThread, useChatInbox, clearChatMemory } from './src/components/use-chat';
      import { GradesTab } from './src/components/grades';
      import { writeReceived, readReceived, removeReceived } from './src/client/received-cache';
      import { validThread } from './src/client/chat-cache';
      let root;
      const getRoot = () => root ??= createRoot(document.getElementById('root'));
      window.requests = [];
      window.seed = (account, resource, value) => writeReceived(account, resource, value);
      window.read = (account, resource) => readReceived(account, resource, validThread);
      window.purge = removeReceived;
      window.clear = clearChatMemory;
      function View({account, online, target, inbox}) {
        const state = {context: {user: {id: account}}, online, refresh: async () => {}, setChatUnread: () => {}};
        const chat = useChatThread(state, target);
        const list = useChatInbox(state, inbox);
        window.chat = chat; window.list = list;
        return <div>{JSON.stringify({messages: chat.messages, status: chat.status, inbox: list.inbox})}</div>;
      }
      window.mount = (account = 'a', online = false, target = {kind: 'peer', userId: 'p'}, inbox = false) => getRoot().render(<View account={account} online={online} target={target} inbox={inbox} />);
      window.hydrateThread = () => {
        document.getElementById('root').innerHTML = '<div>{&quot;messages&quot;:[],&quot;status&quot;:&quot;loading&quot;,&quot;inbox&quot;:null}</div>';
        root = hydrateRoot(document.getElementById('root'), <View account="a" online={false} target={{kind: 'peer', userId: 'p'}} inbox={false} />);
      };
      window.mountGrades = (account = 'a', online = false, beta = true) => getRoot().render(<GradesTab state={{
        context: {user: {id: account}, betas: beta ? [{key: 'schoology-connect'}] : []}, online,
        personal: {classes: []}, now: new Date(), today: '2026-11-13', params: new URLSearchParams(),
        navigate: () => {}, refresh: async () => {},
      }} tabs={null} />);
      window.answer = (path, value, error = false) => {
        const i = window.requests.findIndex(r => r.path === path);
        if (i < 0) throw new Error('No pending request: ' + path);
        const [r] = window.requests.splice(i, 1); error ? r.reject(value) : r.resolve(value);
      };
    `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': resolve('src') },
    plugins: [{ name: 'fake-network', setup(plugin: { onResolve: Function; onLoad: Function }) {
      plugin.onResolve({ filter: /^@\/client\/(api|chat-events)$/ }, (args: { path: string }) => ({ path: args.path, namespace: 'fake' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fake' }, (args: { path: string }) => ({ contents: args.path.endsWith('chat-events')
        ? 'export const connectChatEvents = () => () => {};'
        : `const proxy = path => new Proxy(() => {}, {get: (_, key) => key === 'query' || key === 'mutate' ? input => new Promise((resolve, reject) => window.requests.push({path, input, resolve, reject})) : proxy(path ? path + '.' + key : key)});
           export const api = proxy(''); export const errorMessage = e => e.message || 'Offline';
           export const isUnauthorized = e => e.data?.code === 'UNAUTHORIZED'; export const isTransportFailure = e => !e.data;` }));
    } }],
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.route('http://cache.test/', route => route.fulfill({ body: '<div id="root"></div>', contentType: 'text/html' }));
  await page.goto('http://cache.test/');
  await page.addScriptTag({ content: bundle });
}, 30_000);
afterAll(async () => { await browser?.close(); });
const run = (script: string) => page.evaluate(script);
const message = (revision: number, body: string | null = 'cached') => ({ id: 'm1', seq: 1, revision, body, fromMe: false, createdAt: '2026-11-13T00:00:00Z', deletedBy: body === null ? 'sender' : null, replyTo: null, reactions: [] });
const data = () => ({ peer: { id: 'p', displayName: 'Peer', fullName: null, avatar: null, verified: true }, room: null, group: null, school: null, pause: null, receipts: [], messages: [message(1)], hasEarlier: false, muted: false });
const wait = async (expression: string) => {
  try { await page.waitForFunction(expression, undefined, { timeout: 5_000 }); }
  catch { throw new Error(`${expression} failed: ${await page.locator('body').innerText()} requests=${await run('JSON.stringify(window.requests.map(r => r.path))')}`); }
};

it('hydrates immediately, fully revalidates, persists mutations and never restores purged data', async () => {
  await run(`window.seed('a', 'thread:peer:p', ${JSON.stringify(data())}); window.mount();`);
  await wait(`window.chat?.messages[0]?.body === 'cached'`);
  expect(await run('window.requests.length')).toBe(0);
  await run('window.mount("a", true)');
  await wait('window.requests.some(r => r.path === "chat.thread")');
  expect(await run('window.requests.find(r => r.path === "chat.thread").input.after')).toBeUndefined();
  expect(await run('window.chat.messages[0].body')).toBe('cached');
  const pageResult = { ...data(), messages: [message(2, 'fresh')], revision: 2, lastReadSeq: 0, reset: false };
  await run(`window.answer('chat.thread', ${JSON.stringify(pageResult)})`);
  await wait('window.chat.messages[0]?.body === "fresh"');
  await run(`void window.chat.react(1, '👍'); void window.chat.deleteMessage('m1');`);
  await wait('window.requests.some(r => r.path === "chat.delete")');
  await run(`window.answer('chat.delete', ${JSON.stringify({ message: message(4, null) })})`);
  await wait('window.chat.messages[0]?.revision === 4');
  await run(`window.answer('chat.react', ${JSON.stringify({ message: { ...message(3, 'old reaction response'), reactions: [{ emoji: '👍', count: 1, mine: true }] } })})`);
  await wait('window.requests.some(r => r.path === "chat.thread")');
  expect(await run(`window.read('a', 'thread:peer:p').messages[0].body`)).toBeNull();
  // A late poll after sign-out cannot recreate the snapshot.
  await run(`window.clear(); window.answer('chat.thread', ${JSON.stringify(pageResult)})`);
  await wait('window.chat.messages.length === 0');
  expect(await run(`window.read('a', 'thread:peer:p')`)).toBeNull();
  await run(`window.mount('b', false)`);
  await wait('window.chat.messages.length === 0');
  // A browser reload, not a module-memory hit.
  await run(`window.seed('b', 'thread:peer:p', ${JSON.stringify(data())})`);
  await page.reload(); await page.addScriptTag({ content: bundle }); await run(`window.mount('b')`);
  await wait('window.chat.messages[0]?.body === "cached"');
  await run(`window.mount('b', true)`);
  await wait('window.requests.some(r => r.path === "chat.thread")');
  await run(`window.answer('chat.thread', {data: {code: 'FORBIDDEN'}, message: 'No permission'}, true)`);
  await wait('window.chat.status === "closed" && window.chat.messages.length === 0');
  expect(await run(`window.read('b', 'thread:peer:p')`)).toBeNull();
}, 30_000);

it('hydrates the inbox, replaces previews and isolates peer, group, school and global snapshots', async () => {
  await page.reload(); await page.addScriptTag({ content: bundle });
  const row = { state: 'open', peer: data().peer, lastMessage: { fromMe: false, preview: 'cached preview', createdAt: '2026-11-13T00:00:00Z', deletedBy: null }, unread: 1, muted: false };
  const inbox = { rows: [row], groups: [], global: { lastMessage: null, unread: 0, muted: false }, school: null, pause: null, unreadChats: 1, unreadAt: '2026-11-13T00:00:00Z' };
  await run(`window.seed('a', 'inbox', ${JSON.stringify(inbox)}); window.mount('a', false, {kind: 'peer', userId: 'p'}, true)`);
  await wait('window.list.inbox?.rows[0]?.lastMessage.preview === "cached preview"');
  await run(`window.mount('a', true, {kind: 'peer', userId: 'p'}, true)`);
  await wait('window.requests.some(r => r.path === "chat.inbox")');
  await run(`window.answer('chat.inbox', ${JSON.stringify({ ...inbox, rows: [] })})`);
  await wait('window.list.inbox?.rows.length === 0');
  await run(`window.mount('b', false, {kind: 'global'}, true)`);
  await wait('window.list.inbox === null && window.chat.messages.length === 0');
  for (const [target, resource] of [
    [{ kind: 'peer', userId: 'same' }, 'peer:same'], [{ kind: 'group', groupId: 'same' }, 'group:same'],
    [{ kind: 'school', schoolId: 'same' }, 'school:same'], [{ kind: 'global' }, 'global'],
  ] as const) {
    await run(`window.seed('b', 'thread:${resource}', ${JSON.stringify({ ...data(), messages: [message(1, resource)] })}); window.mount('b', false, ${JSON.stringify(target)})`);
    await wait(`window.chat.messages[0]?.body === '${resource}'`);
  }
});

it('hydrates grades before status arrives, refreshes them and purges revoked or disconnected access', async () => {
  await page.reload(); await page.addScriptTag({ content: bundle });
  const gradebook = (title: string) => ({ name: 'Student', checkedAt: '2026-11-13T00:00:00Z', goals: {}, classes: [{ grade: '92%', graded: 0, classId: null,
    detail: { sectionId: '1', title, termWeight: 100, termReported: 92, reported: 92, categories: [], items: [], exams: [] },
  }] });
  const connected = { beta: true, available: true, pendingConnection: false, plusLocked: false,
    connected: { name: 'Student', connectedAt: '2026-11-13T00:00:00Z', syncedAt: null, importAssignments: true, autoComplete: true } };
  await run(`window.seed('a', 'grades', ${JSON.stringify(gradebook('Cached Biology'))}); window.mountGrades('a', true)`);
  await expect.poll(() => page.locator('body').innerText()).toContain('Cached Biology');
  await wait('window.requests.some(r => r.path === "schoology.status")');
  expect(await run('window.requests.some(r => r.path === "schoology.gradebook")')).toBe(false);
  await run(`window.answer('schoology.status', ${JSON.stringify(connected)})`);
  await wait('window.requests.some(r => r.path === "schoology.gradebook")');
  await run(`window.answer('schoology.gradebook', ${JSON.stringify(gradebook('Fresh Biology'))})`);
  await expect.poll(() => page.locator('body').innerText()).toContain('Fresh Biology');
  await run(`window.mountGrades('b', false)`);
  await expect.poll(() => page.locator('body').innerText()).not.toContain('Fresh Biology');
  await run(`window.seed('b', 'grades', ${JSON.stringify(gradebook('Private Biology'))}); window.mountGrades('b', true)`);
  await wait('window.requests.some(r => r.path === "schoology.status")');
  await run(`window.answer('schoology.status', ${JSON.stringify(connected)})`);
  await wait('window.requests.some(r => r.path === "schoology.gradebook")');
  await run(`window.answer('schoology.gradebook', {data: {code: 'UNAUTHORIZED'}, message: 'Reconnect Schoology'}, true)`);
  await expect.poll(() => page.locator('body').innerText()).not.toContain('Private Biology');
  expect(await run(`localStorage.getItem('quasar-received-v1:b:grades')`)).toBeNull();
  await wait('window.requests.some(r => r.path === "schoology.status")');
  await run(`window.answer('schoology.status', ${JSON.stringify({ ...connected, connected: null })})`);
  await expect.poll(() => page.locator('body').innerText()).toContain('Connect Schoology');
  await run(`window.seed('b', 'grades', ${JSON.stringify(gradebook('Forbidden Biology'))}); window.mountGrades('b', false, false)`);
  await expect.poll(() => page.locator('body').innerText()).not.toContain('Forbidden Biology');
  expect(await run(`localStorage.getItem('quasar-received-v1:b:grades')`)).toBeNull();
}, 30_000);

it('hydrates server HTML without a mismatch when a browser snapshot exists', async () => {
  await page.reload(); await page.addScriptTag({ content: bundle });
  const errors: string[] = [];
  const capture = (error: Error) => errors.push(error.message);
  page.on('pageerror', capture);
  await run(`window.seed('a', 'thread:peer:p', ${JSON.stringify(data())}); window.hydrateThread()`);
  await wait('window.chat.messages[0]?.body === "cached"');
  page.off('pageerror', capture);
  expect(errors).toEqual([]);
});
