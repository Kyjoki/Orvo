import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Orvo — офис ИИ-агентов', description: 'Личное рабочее пространство команды ИИ-агентов' };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="ru" suppressHydrationWarning><head><link rel="stylesheet" href="/design/fonts.css"/><link rel="stylesheet" href="/design/tokens.css"/></head><body>{children}</body></html>;
}
