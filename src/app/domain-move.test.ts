import { afterEach, describe, expect, it, vi } from 'vitest';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import nextConfig from '../../next.config';

afterEach(() => vi.unstubAllEnvs());
const response = (host: string, path = '/') => unstable_getResponseFromNextConfig({ nextConfig, url: `https://${host}${path}`, headers: { host } });

describe('domain move routing', () => {
  it('keeps the old site working before cutover and after rollback', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://quasar.ziona.dev');
    expect((await response('quasar.ziona.dev')).headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('rewrites old bookmarks to the notice without redirecting visitors', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://getquasarapp.com');
    for (const path of ['/', '/schedule', '/admin', '/offline', '/tasks?error=example']) {
      const result = await response('quasar.ziona.dev', path);
      expect(new URL(result.headers.get('x-middleware-rewrite')!).pathname).toBe('/moved');
      expect(result.headers.get('location')).toBeNull();
      expect(result.headers.get('cache-control')).toBe('private, no-store');
      expect(result.headers.get('x-robots-tag')).toBe('noindex, follow');
    }
  });

  it('leaves authentication, APIs, service workers and page assets reachable', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://getquasarapp.com');
    for (const path of ['/api/auth/callback/google', '/api/health', '/api/trpc/tasks.create', '/sw.js', '/brand/icon-192.png', '/_next/static/chunk.js', '/icon.svg', '/apple-icon.png', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml']) {
      expect((await response('quasar.ziona.dev', path)).headers.get('x-middleware-rewrite')).toBeNull();
    }
  });

  it('serves the app normally on the new host', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://getquasarapp.com');
    for (const path of ['/', '/schedule', '/admin']) {
      expect((await response('getquasarapp.com', path)).headers.get('x-middleware-rewrite')).toBeNull();
    }
  });
});
