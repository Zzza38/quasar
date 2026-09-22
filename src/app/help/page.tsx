import type { Metadata } from 'next';
import { Help } from '@/components/help';

export const metadata: Metadata = { title: 'Help · Quasar' };

export default function HelpPage() {
  return <Help />;
}
