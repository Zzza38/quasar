import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import { ThemeSync, themeBootScript } from '@/lib/theme';
import './globals.css';

// Self-hosted at build time by next/font; the browser never contacts Google.
const manrope = Manrope({ subsets: ['latin'], display: 'swap', variable: '--font-manrope' });

export const metadata: Metadata = {
  title: 'Quasar',
  description: 'Your next class and everything you need to do.',
};

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f5f6fa' }, { media: '(prefers-color-scheme: dark)', color: '#0b0d12' }],
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
