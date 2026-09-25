import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import { ThemeSync } from '@/lib/theme';
import { themeBootScript } from '@/lib/theme-boot';
import { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_NAME, SITE_TITLE, siteOrigin, socialMetadata } from '@/server/site';
import './globals.css';

// Self-hosted at build time by next/font; the browser never contacts Google.
const manrope = Manrope({ subsets: ['latin'], display: 'swap', variable: '--font-manrope' });

/**
 * What a search result or link preview shows for any page. Pages narrow it: /help sets its own title, description
 * and canonical address, /admin asks not to be indexed. The view paths (/schedule, /tasks, …) inherit the home
 * page's canonical address on purpose: signed out they render the same landing page, so crawlers should file them
 * under /. Set GOOGLE_SITE_VERIFICATION (.env.local) to prove ownership to Search Console with a meta tag; a DNS
 * record at the registrar works too and needs nothing here.
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  applicationName: SITE_NAME,
  title: { default: SITE_TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  keywords: [...SITE_KEYWORDS],
  category: 'education',
  alternates: { canonical: '/' },
  ...socialMetadata({ path: '/', title: SITE_TITLE, description: SITE_DESCRIPTION }),
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } },
  ...(process.env.GOOGLE_SITE_VERIFICATION ? { verification: { google: process.env.GOOGLE_SITE_VERIFICATION } } : {}),
};

export const viewport: Viewport = {
  // cover lets env(safe-area-inset-*) report real values on notched phones; resizes-content
  // shrinks the layout (and dvh) above the Android keyboard so bottom sheets stay reachable.
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  // The OS-scheme defaults for the first paint. The in-app appearance choice rewrites both tags to
  // its own background (THEME_COLORS in src/lib/theme.ts), so keep these values equal to those.
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f4f5f9' }, { media: '(prefers-color-scheme: dark)', color: '#0b0d12' }],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The theme attributes are applied by the inline script before hydration, so
  // the server-rendered <html> intentionally differs from the client.
  return <html lang="en" suppressHydrationWarning className={manrope.variable}>
    {/* A raw inline script: next/script queues even beforeInteractive scripts until its runtime
        loads, which paints the light theme first. This runs synchronously before any styles apply. */}
    <head><script id="theme-boot" dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
    <body><ThemeSync />{children}</body>
  </html>;
}
