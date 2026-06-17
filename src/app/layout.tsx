import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Lato } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const lato = Lato({
  variable: "--font-lato",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "CFO Agent — Falcon 37",
  description: "Daily P&L and finance operations for Falcon 37 stores",
};

// Inline boot script: set data-theme from localStorage before paint to avoid
// a flash of the wrong theme. Default is ALWAYS dark (Paysight-style); we only
// honour a light theme if the user explicitly toggled to it.
const themeBootScript = `
(function(){try{
  var pref = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', pref);
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${inter.variable} ${jetbrains.variable} ${lato.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      {/* suppressHydrationWarning on body suppresses Grammarly / 1Password
          / similar browser extensions that inject data-* attributes on
          <body> after page load, which would otherwise trip React's
          hydration mismatch warning in dev. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
