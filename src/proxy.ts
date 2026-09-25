import { createHash, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from '../next.config';
import { themeBootScript } from '@/lib/theme-boot';

/**
 * The support console gets a stricter Content-Security-Policy than the rest of the site: scripts run only with this
 * request's nonce (Next applies it to its own scripts, reading it from the request's CSP header) or, for the theme
 * script in the root layout, by hash, so a script injected through student text shown there (support requests,
 * proofs, reports, names) would not run. Other pages keep next.config.ts's policy, because a nonce needs a
 * per-request render and most pages are static. /admin is rendered per request anyway (force-dynamic).
 */
const THEME_HASH = `'sha256-${createHash('sha256').update(themeBootScript).digest('base64')}'`;

export function adminContentSecurityPolicy(nonce: string, dev = process.env.NODE_ENV === 'development'): string {
  const script = `script-src 'self' 'nonce-${nonce}' ${THEME_HASH} 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`;
  return contentSecurityPolicy.split('; ').map(directive => directive.startsWith('script-src ') ? script : directive).join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString('base64');
  const policy = adminContentSecurityPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [{ source: '/admin', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] }],
};
