"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import EternlWalletButton from "./eternl-wallet";

const navigation = [
  ["/marketplace", "Marketplace"],
  ["/my-assets", "Portfolio"],
  ["/dex", "DEX"],
  ["/mint", "Mint"],
  ["/protocol", "Protocol"],
  ["/assets", "Explore"],
  ["/team", "Operations"],
] as const;

const groups = {
  portfolio: [["/my-assets", "Holdings"], ["/portfolio/positions", "Open positions"], ["/portfolio/orders", "Listings & requests"], ["/portfolio/reserves", "Shared reserves"], ["/wallet", "Wallet"], ["/history", "Activity"]],
  dex: [["/dex", "Swap"], ["/dex/liquidity", "Liquidity"], ["/dex/launch", "Launch a pool"]],
  operations: [["/team", "Requests"], ["/team/inventory", "Inventory & prices"], ["/registry", "Asset approvals"], ["/team/controls", "Pool controls"], ["/team/dex", "DEX administration"], ["/team/recovery", "Recovery"], ["/wallets", "Deployment wallets"]],
  explore: [["/assets", "Asset browser"], ["/asset-registry", "Public registry"], ["/vault", "Vault explorer"]],
} as const;

export default function PlatformHeader() {
  const pathname = usePathname();
  const activePath = pathname === "/" ? "/marketplace" : pathname;
  const group = activePath.startsWith("/portfolio") || ["/my-assets", "/wallet", "/history", "/fractionalize"].includes(activePath) ? "portfolio" : activePath.startsWith("/dex") ? "dex" : activePath.startsWith("/team") || ["/registry", "/reserves", "/wallets"].includes(activePath) ? "operations" : ["/assets", "/asset-registry", "/vault"].includes(activePath) ? "explore" : null;
  const primaryPath = group === "portfolio" ? "/my-assets" : group === "operations" ? "/team" : group === "explore" ? "/assets" : group === "dex" ? "/dex" : activePath;

  return <><header className="topbar">
    <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>CSWAP Systems</span></Link>
    <nav aria-label="Main navigation">
      {navigation.map(([href, label]) => <Link key={href} href={href} className={primaryPath === href ? "active" : ""} aria-current={activePath === href ? "page" : undefined}>{label}</Link>)}
    </nav>
    <EternlWalletButton />
  </header>{group && <nav className="module-nav" aria-label={`${group} navigation`}>{groups[group].map(([href, label]) => <Link key={href} href={href} className={activePath === href ? "active" : ""} aria-current={activePath === href ? "page" : undefined}>{label}</Link>)}</nav>}</>;
}
