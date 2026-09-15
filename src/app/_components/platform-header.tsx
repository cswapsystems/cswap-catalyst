"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import EternlWalletButton from "./eternl-wallet";

const navigation = [
  ["/mint", "Mint RWA"],
  ["/fractionalize", "Fractionalize"],
  ["/marketplace", "Marketplace"],
  ["/dex", "Fraction DEX"],
  ["/my-assets", "My assets"],
  ["/assets", "Asset browser"],
  ["/team", "Team console"],
  ["/registry", "Asset controls"],
  ["/reserves", "Shared pool"],
  ["/wallets", "Wallets"],
] as const;

export default function PlatformHeader() {
  const pathname = usePathname();
  const activePath = pathname === "/" ? "/mint" : pathname;
  const historyActive = activePath === "/history";

  return <header className="topbar">
    <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>CSWAP Systems</span></Link>
    <nav aria-label="Main navigation">
      {navigation.map(([href, label]) => <Link key={href} href={href} className={activePath === href ? "active" : ""} aria-current={activePath === href ? "page" : undefined}>{label}</Link>)}
    </nav>
    <Link href="/history" className={`history-shortcut${historyActive ? " connected" : ""}`} aria-current={historyActive ? "page" : undefined}>History</Link>
    <EternlWalletButton />
  </header>;
}
