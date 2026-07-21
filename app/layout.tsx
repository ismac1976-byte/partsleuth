import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PartSleuth',
  description: 'Sort your Lego back into sets',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'PartSleuth' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,   // Prevent accidental pinch-zoom during scanning
  themeColor: '#1e1b4b',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
      </head>
      <body className="min-h-screen">
        <header className="bg-brand-900 text-white px-4 py-3 flex items-center gap-3 safe-area-top">
          <span className="text-xl font-bold tracking-tight">🔍 PartSleuth</span>
        </header>
        <main className="max-w-2xl mx-auto px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  )
}
