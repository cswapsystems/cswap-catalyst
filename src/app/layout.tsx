import type { Metadata } from "next";
import { Bai_Jamjuree, Host_Grotesk } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "./_components/wallet-context";

const baiJamjuree = Bai_Jamjuree({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-cswap-display",
});

const hostGrotesk = Host_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-cswap-body",
});

export const metadata: Metadata = {
  title: "CSWAP Systems | Real-world assets",
  description: "A calm workspace for minting, fractionalizing, liquidating, and listing RWA tokens.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${baiJamjuree.variable} ${hostGrotesk.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col"><WalletProvider>{children}</WalletProvider></body>
    </html>
  );
}
