import type { ReactNode } from 'react';
import { ThemeProvider } from '../contexts/ThemeContext';
import './globals.css';

export const metadata = {
  title: 'term2 web',
  description: 'term2 agent web client',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
