import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PartSleuth',
  description: 'Sort your LEGO back into sets',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'PartSleuth' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#FFD700',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap" />
      </head>
      <body className="min-h-screen" style={{ backgroundColor: '#F5F3EE' }}>
        {/* LEGO-yellow top bar */}
        <header style={{ backgroundColor: '#FFD700' }} className="sticky top-0 z-40">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
            <span className="text-2xl leading-none">🧩</span>
            <div className="flex-1">
              <p className="font-black text-brand-900 text-lg leading-none tracking-tight">
                PartSleuth
              </p>
              <p className="text-[11px] text-brand-900/50 leading-none mt-0.5 font-medium">
                Sort your LEGO back into sets
              </p>
            </div>
          </div>
        </header>

        <main className="max-w-2xl mx-auto px-4 py-6 pb-12">
          {children}
        </main>
      </body>
    </html>
  )
}
