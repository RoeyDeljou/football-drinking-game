import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { RoomProvider } from '@/lib/room-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Football Drinking Game',
  description: 'Kahoot-style multiplayer football drinking game — matchday and general games.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0e14',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink-950 font-sans antialiased">
        <RoomProvider>{children}</RoomProvider>
      </body>
    </html>
  );
}
