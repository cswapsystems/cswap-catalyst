"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import EternlWalletButton from "./eternl-wallet";
import HeaderDisclosure from "./header-disclosure";
import { navigationForPath, primaryNavigation } from "@/lib/navigation";

export default function PlatformHeader() {
  const pathname = usePathname();
  const { path, section, primary } = navigationForPath(pathname);

  return <><header className="app-header">
    <Link href="/marketplace" className="app-brand" aria-label="CSWAP marketplace"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>CSWAP<span className="app-brand-suffix"> Systems</span></span></Link>
    <nav className="app-primary-nav" aria-label="Main navigation">
      {primaryNavigation.map(({ href, label }) => <Link key={href} href={href} className={primary === href ? "active" : ""} aria-current={path === href ? "page" : primary === href ? "location" : undefined}>{label}</Link>)}
    </nav>
    <div className="app-header-actions">
      <HeaderDisclosure label="More" active={section?.primary === null}>
        <span className="header-menu-label">Protocol information</span>
        <Link href="/protocol" aria-current={path === "/protocol" ? "page" : undefined}>Protocol overview<small>Public deployment statistics</small></Link>
        <Link href="/asset-registry" aria-current={path === "/asset-registry" ? "page" : undefined}>Approved assets<small>Check registry admission</small></Link>
        <Link href="/vault" aria-current={path === "/vault" ? "page" : undefined}>Vault activity<small>Inspect assets held in custody</small></Link>
        <div className="header-menu-divider" />
        <Link href="/team" aria-current={path === "/team" ? "page" : undefined}>Operator console<small>Approvals, pricing and pool controls</small></Link>
        <p className="header-network-note"><span />Preprod testnet · Test assets only</p>
      </HeaderDisclosure>
      <EternlWalletButton />
    </div>
  </header><div className="app-context-bar">
    {section ? <nav className="app-section-nav" aria-label={`${section.label} navigation`}><span className="app-section-label">{section.label}</span>{section.items.map(({ href, label }) => <Link key={href} href={href} className={path === href ? "active" : ""} aria-current={path === href ? "page" : undefined}>{label}</Link>)}</nav> : <span className="app-context-label">Real-world asset marketplace</span>}
    <span className="app-network-label"><i aria-hidden="true" />Preprod<span> · Testnet</span></span>
  </div></>;
}
