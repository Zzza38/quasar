import type { Metadata, Viewport } from 'next';
import { themeBootScript } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quasar',
  description: 'Your next class and everything you need to do.',
};

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f4f5f8' }, { media: '(prefers-color-scheme: dark)', color: '#0f1116' }],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The theme attributes are applied by the inline script before hydration, so
  // the server-rendered <html> intentionally differs from the client.
  return <html lang="en" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
    <body>{children}</body>
  </html>;
}
