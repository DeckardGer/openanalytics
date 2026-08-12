import type { Metadata } from "next";
import { Geist_Mono, Inter_Tight } from "next/font/google";
import "./globals.css";
import { OaTracker } from "@/components/analytics/oa-tracker";
import { JsonLd } from "@/components/seo/json-ld";
import { SESSION_HINT_SCRIPT } from "@/lib/session-hint";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import { organizationSchema, webSiteSchema } from "@/lib/structured-data";
import { cn } from "@/lib/utils";

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["300", "400", "500"],
});

// Real monospace for code/CLI snippets (font-mono, code/pre elements)
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

/**
 * The whole app's SEO surface. Pages override `title`/`description` and add
 * their own canonical; everything else — the OG card, the crawler policy,
 * the icon set — inherits from here so no page can ship without it.
 */
export const metadata: Metadata = {
  // Null when this deployment has not been told its own address: relative
  // metadata URLs stay relative, rather than the build dying on `new URL("")`.
  metadataBase: SITE_URL ? new URL(SITE_URL) : null,
  title: {
    default: "Open Analytics: Open-source, privacy-first web analytics",
    template: "%s | Open Analytics",
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "web analytics",
    "open source analytics",
    "privacy-first analytics",
    "Google Analytics alternative",
    "cookieless analytics",
    "GDPR analytics",
    "self-hosted analytics",
    "realtime analytics",
  ],
  category: "technology",
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: "Open Analytics: Open-source, privacy-first web analytics",
    description: SITE_DESCRIPTION,
    images: [
      {
        url: "/og-open.png",
        width: 1200,
        height: 630,
        alt: "Open Analytics: open-source, privacy-first web analytics",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Open Analytics: Open-source, privacy-first web analytics",
    description: SITE_DESCRIPTION,
    images: ["/og-open.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // globals.css sets scroll-behavior: smooth; this attribute lets Next
      // suspend it during route transitions (see missing-data-scroll-behavior)
      data-scroll-behavior="smooth"
      className={cn(
        "h-full antialiased font-sans",
        interTight.variable,
        geistMono.variable,
      )}
    >
      <body className="min-h-full flex flex-col">
        {/* First thing the parser meets, and the only place it can be: this
            script has to run before `/login` paints, and a `<script>` inside
            a page is never executed on a client-side navigation. It checks
            the path itself and does nothing anywhere else. */}
        <script dangerouslySetInnerHTML={{ __html: SESSION_HINT_SCRIPT }} />
        {/* The brand entity, declared once for the whole app. It describes
            who publishes this — a fact that does not change between the
            marketing pages and the dashboard — so it belongs at the root
            rather than being repeated per page. Page-specific graphs (the
            priced product, the answered questions) are rendered by the
            sections that own that content.

            Every node in it is identified by an absolute URL, so a deployment
            that has not been told its own address publishes no graph at all
            rather than one whose `@id`s are relative and cannot be resolved. */}
        {SITE_URL ? (
          <>
            <JsonLd data={organizationSchema()} />
            <JsonLd data={webSiteSchema()} />
          </>
        ) : null}
        {/* Dogfood: our own snippet, injected only on the marketing hosts —
            see the component for why it is not a static tag here. */}
        <OaTracker />
        {children}
      </body>
    </html>
  );
}
