import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CSWAP Systems | Real-world assets",
  description: "A calm workspace for minting, fractionalizing, liquidating, and listing RWA tokens.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
