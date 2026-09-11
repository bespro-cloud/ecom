import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { SkipToContent } from '@health/ui';
import { publicConfig } from '@/lib/env';
import { currentUser } from '@/lib/session';
import { fetchCart } from '@/lib/commerce';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  // Text stays readable while the webfont loads instead of flashing invisible.
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(publicConfig.siteUrl),
  title: {
    default: `${publicConfig.siteName} — Considered wellness products`,
    template: `%s · ${publicConfig.siteName}`,
  },
  description:
    'A US wellness retailer that documents what is in each product, where it came from, and what the evidence does and does not show.',
  // Indexing is decided per route now that there is a catalogue: `robots.ts`
  // holds the site-wide policy, and a page that should not be indexed (a
  // listing an editor marked noindex, a search result) says so itself. A blanket
  // `index: false` here would silently override both.
  robots: {
    index: process.env.NEXT_PUBLIC_ALLOW_INDEXING === 'true',
    follow: true,
  },
  openGraph: {
    type: 'website',
    siteName: publicConfig.siteName,
    locale: 'en_US',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#276a70',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();

  // A failing basket lookup must not take the whole site down — the header can
  // show nothing and every other page still works.
  const cartCount = await fetchCart()
    .then((cart) => cart.itemCount)
    .catch(() => 0);

  return (
    <html lang="en" className={inter.variable}>
      <body className="flex min-h-screen flex-col font-sans">
        <SkipToContent />
        <SiteHeader user={user} cartCount={cartCount} />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
