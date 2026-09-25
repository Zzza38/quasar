import { afterEach, describe, expect, it } from 'vitest';
import { SITE_DESCRIPTION, SITE_TITLE, siteOrigin, socialMetadata, structuredData } from './site';

const original = process.env.NEXTAUTH_URL;
afterEach(() => { if (original === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = original; });

describe('site origin', () => {
  it('is the origin of NEXTAUTH_URL, without any path', () => {
    process.env.NEXTAUTH_URL = 'https://quasar.example.com/api/auth';
    expect(siteOrigin()).toBe('https://quasar.example.com');
  });

  it('falls back to localhost when NEXTAUTH_URL is unset or not a URL', () => {
    delete process.env.NEXTAUTH_URL;
    expect(siteOrigin()).toBe('http://localhost:3000');
    process.env.NEXTAUTH_URL = 'not a url';
    expect(siteOrigin()).toBe('http://localhost:3000');
  });
});

describe('search listing text', () => {
  it('keeps the title and description within what result pages show in full', () => {
    expect(SITE_TITLE.length).toBeLessThanOrEqual(60);
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(SITE_TITLE.toLowerCase()).toContain('school schedule');
  });

  it('describes the app as free education software at the public origin', () => {
    process.env.NEXTAUTH_URL = 'https://quasar.example.com';
    const data = structuredData();
    expect(data['@type']).toBe('SoftwareApplication');
    expect(data.url).toBe('https://quasar.example.com');
    expect(data.isAccessibleForFree).toBe(true);
    expect(JSON.stringify(data)).not.toContain('<');
  });

  it('gives every page the same preview card with its own title, text and address', () => {
    const social = socialMetadata({ path: '/help', title: 'Help · Quasar', description: 'Answers.' });
    expect(social.openGraph).toMatchObject({ url: '/help', title: 'Help · Quasar', description: 'Answers.', siteName: 'Quasar' });
    expect(social.twitter).toMatchObject({ card: 'summary_large_image', title: 'Help · Quasar', description: 'Answers.' });
    expect((social.openGraph as { images: Array<{ url: string; width: number; height: number }> }).images).toEqual([expect.objectContaining({ url: '/brand/og.png', width: 1200, height: 630 })]);
  });
});
