import type { Metadata } from 'next';
import './globals.css';
// Nonces are generated per request; never cache a pre-rendered login script nonce.
export const dynamic='force-dynamic';
export const metadata: Metadata = { title: 'Orvo — офис ИИ-агентов', description: 'Личное рабочее пространство команды ИИ-агентов' };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="ru" suppressHydrationWarning><head><link rel="stylesheet" href="/design/fonts.css"/><link rel="stylesheet" href="/design/tokens.css"/></head><body>{children}</body></html>;
}
