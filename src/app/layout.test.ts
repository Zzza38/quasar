import { describe, expect, it } from 'vitest';
import config, { contentSecurityPolicy, permissionsPolicy } from '../../next.config';

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
    // Scan photo previews are data: URLs; nothing in the app creates blob: URLs.
    expect(directives.get('img-src')).toEqual(["'self'", 'data:']);
    // Google sign-in is a fetch plus navigation, never a form post to Google.
    expect(directives.get('form-action')).toEqual(["'self'"]);
  });

  it('turns off unused features but leaves the camera for scan photo capture', () => {
    expect(permissionsPolicy).toContain('geolocation=()');
    expect(permissionsPolicy).toContain('microphone=()');
    expect(permissionsPolicy).not.toContain('camera');
  });
});
