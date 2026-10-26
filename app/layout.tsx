import type { ReactNode } from "react";
import type { Metadata } from "next";
import { ThemeProvider } from "../components/theme";
import { themeBootScript } from "../src/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mockbot",
  description: "A multi-agent chat workspace",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
