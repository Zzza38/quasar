import { describe, expect, it } from 'vitest';
import config, { contentSecurityPolicy, httpsRedirects, permissionsPolicy } from '../../next.config';

const directives = new Map(contentSecurityPolicy.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

describe('response security headers', () => {
  it('sends CSP, Permissions-Policy and HSTS on every page next to the existing headers', async () => {
    const rules = await config.headers!();
    const page = rules.find((rule) => rule.source === '/:path*')!;
    const keys = page.headers.map((header) => header.key);
    expect(keys).toEqual(expect.arrayContaining(['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Content-Security-Policy', 'Permissions-Policy', 'Strict-Transport-Security']));
    expect(page.headers.find((header) => header.key === 'Strict-Transport-Security')?.value).toMatch(/max-age=\d{8}/);
  });

  it('keeps scripts, fetches and plugins on this origin and lets the theme-boot inline script run', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    // Scan photo previews are data: URLs; nothing in the app creates blob: URLs. Google profile pictures (docs/CHAT.md §13) come from Google's CDN.
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'https://*.googleusercontent.com']);
    // Google sign-in is a fetch plus navigation, never a form post to Google.
    expect(directives.get('form-action')).toEqual(["'self'"]);
  });

  it('turns off unused features but leaves the camera for scan photo capture', () => {
    expect(permissionsPolicy).toContain('geolocation=()');
    expect(permissionsPolicy).toContain('microphone=()');
    expect(permissionsPolicy).not.toContain('camera');
  });

  it('sends a proxied plain-HTTP visit to the same path on HTTPS, for good', async () => {
    const rules = await config.redirects!();
    expect(rules).toEqual(httpsRedirects);
    for (const rule of httpsRedirects) {
      expect(rule.source).toBe('/:path*');
      expect(rule.destination).toBe('https://:host/:path*');
      expect(rule.permanent).toBe(true);
      // Only a proxied request can match: a direct request (next dev, the browser tests) carries neither header.
      expect(rule.has.map((condition) => condition.type)).toEqual(['header', 'host']);
    }
    expect(httpsRedirects.map((rule) => rule.has[0].key)).toEqual(['x-forwarded-proto', 'cf-visitor']);
  });
});
