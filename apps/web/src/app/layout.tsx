import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Caveat, Chivo } from 'next/font/google';
import { RoomProvider } from '@/lib/room-context';
import { NavigationTracker } from '@/components/NavigationTracker';
import '../styles/tokens.css';
import './globals.css';

/** Fantasy3.0's pair: Caveat (chalk handwriting) for headlines and big numbers, Chivo for everything
 * read. next/font self-hosts both at build time; latin-ext covers player names like Çalhanoğlu. */
const caveat = Caveat({ subsets: ['latin', 'latin-ext'], weight: ['600', '700'], variable: '--font-hand', display: 'swap' });
const chivo = Chivo({ subsets: ['latin', 'latin-ext'], variable: '--font-body', display: 'swap' });

export const metadata: Metadata = {
  title: 'Football Drinking Game',
  description: 'Kahoot-style multiplayer football drinking game — matchday and general games.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#17352b',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${caveat.variable} ${chivo.variable}`}>
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">
        <NavigationTracker />
        <RoomProvider>{children}</RoomProvider>
      </body>
    </html>
  );
}
