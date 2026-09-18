import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { Manrope } from 'next/font/google';
import { themeBootScript } from '@/lib/theme';
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
    <head><Script id="theme-boot" strategy="beforeInteractive">{themeBootScript}</Script></head>
    <body>{children}</body>
  </html>;
}
