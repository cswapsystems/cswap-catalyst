"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import EternlWalletButton from "./eternl-wallet";
import Cip25MintForm from "./cip25-mint-form";

type Page = "mint" | "fractionalize" | "liquidate" | "list" | "wallets";

const navItems: { href: string; label: string; page: Page; icon: string }[] = [
  { href: "/mint", label: "Mint RWA", page: "mint", icon: "◇" },
  { href: "/fractionalize", label: "Fractionalize", page: "fractionalize", icon: "◒" },
  { href: "/liquidate", label: "Liquidate", page: "liquidate", icon: "↘" },
  { href: "/list", label: "List", page: "list", icon: "□" },
  { href: "/wallets", label: "Wallets", page: "wallets", icon: "⌘" },
];

const pageDetails: Record<Page, { eyebrow: string; title: string; description: string }> = {
  mint: { eyebrow: "Asset origination", title: "Mint real-world value", description: "Create a verifiable on-chain representation of an off-chain asset." },
  fractionalize: { eyebrow: "Portfolio tooling", title: "Make ownership flexible", description: "Split an RWA into transferable units or reassemble units you hold." },
  liquidate: { eyebrow: "Redemption desk", title: "Exit with confidence", description: "Redeem eligible RWA tokens against the reserve and settle the position." },
  list: { eyebrow: "Secondary market", title: "Put your asset to work", description: "Offer verified RWA tokens to a curated marketplace of participants." },
  wallets: { eyebrow: "Operational directory", title: "Wallets & custody", description: "Inspect the public addresses that support each part of the RWA lifecycle." },
};

function Arrow() { return <span aria-hidden="true" className="button-arrow">↗</span>; }

function Field({ label, placeholder, hint, select }: { label: string; placeholder: string; hint?: string; select?: boolean }) {
  return <label className="field"><span className="field-label">{label}</span><span className="field-input-wrap">{select ? <select defaultValue=""><option value="" disabled>{placeholder}</option><option>Seaport Warehouse 04</option><option>Northline Solar Project</option><option>Maison Alder - Unit 3B</option></select> : <input placeholder={placeholder} />}{select && <span className="select-chevron">⌄</span>}</span>{hint && <span className="field-hint">{hint}</span>}</label>;
}

function MintForm() {
  return <Cip25MintForm />;
}

function FractionalizeForm() {
  const [mode, setMode] = useState<"split" | "combine">("split");
  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">01 / Position setup</span><h2>{mode === "split" ? "Create fractional ownership" : "Combine your fractional units"}</h2></div><span className="step-badge">1 of 2</span></div><div className="segmented-control"><button className={mode === "split" ? "selected" : ""} onClick={() => setMode("split")}>Fractionalize</button><button className={mode === "combine" ? "selected" : ""} onClick={() => setMode("combine")}>Combine</button></div><div className="field-grid"><Field label="Select RWA asset" placeholder="Choose an asset" select /><Field label={mode === "split" ? "Number of fractions" : "Units to combine"} placeholder={mode === "split" ? "e.g. 1,000" : "e.g. 250"} /><Field label="Token you receive" placeholder={mode === "split" ? "Created automatically" : "Original RWA token"} /><Field label="Recipient wallet" placeholder="Paste wallet address" /></div><div className="calculation-card"><span>{mode === "split" ? "Illustrative allocation" : "Resulting position"}</span><strong>{mode === "split" ? "1 RWA token → 1,000 ownership units" : "250 units → 25% of RWA token"}</strong><p>Network fees and final ratio are confirmed in the next step.</p></div><div className="form-footer"><p><span className="status-dot" /> Assets remain in audited custody.</p><button type="button" className="primary-button">Review {mode === "split" ? "fractions" : "combination"} <Arrow /></button></div></section>;
}

function LiquidateForm() {
  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">01 / Redemption request</span><h2>Choose a position to liquidate</h2></div><span className="step-badge">1 of 2</span></div><div className="asset-choice selected-choice"><div className="asset-monogram amber">SH</div><div><strong>Seaport Warehouse 04</strong><p>Commercial property · 42.5 RWA available</p></div><span className="asset-value">$12,750.00</span><span className="choice-check">✓</span></div><div className="asset-choice"><div className="asset-monogram moss">NS</div><div><strong>Northline Solar Project</strong><p>Renewable energy · 18.0 RWA available</p></div><span className="asset-value">$7,920.00</span></div><div className="liquidation-summary"><div><span>Requested amount</span><strong>42.5 RWA</strong></div><div><span>Estimated settlement</span><strong>$12,686.25</strong></div><div><span>Settlement window</span><strong>1–2 business days</strong></div></div><div className="form-footer"><p><span className="status-dot" /> Redemption eligibility verified.</p><button type="button" className="primary-button">Request liquidation <Arrow /></button></div></section>;
}

function ListForm() {
  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">01 / Listing details</span><h2>Set up your offer</h2></div><span className="step-badge">1 of 2</span></div><div className="field-grid"><Field label="Select token to list" placeholder="Choose an available position" select /><Field label="Amount to list" placeholder="0.00 RWA" /><Field label="Price per token" placeholder="$ 0.00" /><Field label="Listing duration" placeholder="Select duration" select /></div><div className="market-note"><span className="market-icon">↗</span><div><strong>Marketplace reach</strong><p>Your listing will be visible to verified marketplace participants after approval.</p></div></div><div className="form-footer"><p><span className="status-dot" /> 1.5% fee applies when the listing settles.</p><button type="button" className="primary-button">Review listing <Arrow /></button></div></section>;
}

const walletRoles = [
  { name: "Issuer / Admin", purpose: "Controls the one-shot mint setup and authorized vault updates.", env: "NEXT_PUBLIC_ISSUER_WALLET", tone: "lime", tag: "Control" },
  { name: "Custody", purpose: "Receives the RWA NFT before it is locked by the vault contract.", env: "NEXT_PUBLIC_CUSTODY_WALLET", tone: "sand", tag: "Custody" },
  { name: "Treasury", purpose: "Receives protocol and marketplace fees after settlement.", env: "NEXT_PUBLIC_TREASURY_WALLET", tone: "coral", tag: "Fees" },
  { name: "Settlement", purpose: "Receives proceeds from liquidation and secondary-market sales.", env: "NEXT_PUBLIC_SETTLEMENT_WALLET", tone: "blue", tag: "Settlement" },
];

function WalletDirectory() {
  const [copied, setCopied] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [balanceStatus, setBalanceStatus] = useState<"loading" | "ready" | "error">("loading");
  const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "preprod" ? "preprod" : "mainnet";
  const cexplorerBase = network === "preprod" ? "https://preprod.cexplorer.io/address/" : "https://cexplorer.io/";
  const addresses: Record<string, string | undefined> = {
    NEXT_PUBLIC_ISSUER_WALLET: process.env.NEXT_PUBLIC_ISSUER_WALLET,
    NEXT_PUBLIC_CUSTODY_WALLET: process.env.NEXT_PUBLIC_CUSTODY_WALLET,
    NEXT_PUBLIC_TREASURY_WALLET: process.env.NEXT_PUBLIC_TREASURY_WALLET,
    NEXT_PUBLIC_SETTLEMENT_WALLET: process.env.NEXT_PUBLIC_SETTLEMENT_WALLET,
  };
  const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS;

  async function refreshBalances() {
    setBalanceStatus("loading");
    try {
      const response = await fetch("/api/wallet-balances", { cache: "no-store" });
      if (!response.ok) throw new Error("Balance request failed");
      const data: { balances: Record<string, string> } = await response.json();
      setBalances(data.balances);
      setBalanceStatus("ready");
    } catch {
      setBalanceStatus("error");
    }
  }

  useEffect(() => { void refreshBalances(); }, []);

  function formatAda(lovelace: string | undefined) {
    if (!lovelace) return "—";
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 }).format(Number(lovelace) / 1_000_000);
  }

  async function copyAddress(name: string, address: string) {
    await navigator.clipboard.writeText(address);
    setCopied(name);
    window.setTimeout(() => setCopied(null), 1600);
  }

  return <section className="wallet-directory"><div className="wallet-directory-head"><div><span className="section-kicker">Public deployment addresses</span><h2>Inspect every operational wallet</h2></div><span className="network-badge"><i /> {network === "preprod" ? "Preprod" : "Mainnet"}</span></div><div className="directory-intro-row"><p className="directory-intro">Only public receiving addresses belong here—never seed phrases, signing keys, or private credentials. Select an address to inspect its balance and activity in Cexplorer.</p><button className="refresh-button" type="button" onClick={() => void refreshBalances()} disabled={balanceStatus === "loading"}>{balanceStatus === "loading" ? "Refreshing…" : "↻ Refresh balances"}</button></div><div className="wallet-grid">{walletRoles.map((wallet, index) => { const address = addresses[wallet.env]; const balance = address ? balances[address] : undefined; return <article className="wallet-card" key={wallet.name}><div className="wallet-card-top"><span className={`wallet-symbol ${wallet.tone}`}>0{index + 1}</span><span className="wallet-tag">{wallet.tag}</span></div><h3>{wallet.name}</h3><p>{wallet.purpose}</p><div className={address ? "address-box" : "address-box unconfigured"}>{address ? <code>{address}</code> : <span>Address not configured</span>}{address && <button type="button" aria-label={`Copy ${wallet.name} address`} onClick={() => copyAddress(wallet.name, address)}>{copied === wallet.name ? "Copied" : "Copy"}</button>}</div>{address && <div className="balance-row"><span>Available balance</span><strong>{balanceStatus === "error" ? "Unavailable" : `${formatAda(balance)} tADA`}</strong></div>}{address ? <a className="explorer-link" href={`${cexplorerBase}${address}`} target="_blank" rel="noreferrer">View on Cexplorer <Arrow /></a> : <span className="explorer-link muted-link">Add {wallet.env} to enable inspection</span>}</article>; })}</div><div className="vault-callout"><span className="vault-callout-icon">◇</span><div><strong>The vault is a script address, not a user wallet.</strong><p>It secures the underlying RWA NFT while fractional tokens are in circulation.</p>{vaultAddress ? <a className="explorer-link vault-explorer-link" href={`${cexplorerBase}${vaultAddress}`} target="_blank" rel="noreferrer">Inspect vault on Cexplorer <Arrow /></a> : <span className="vault-config-hint">Add NEXT_PUBLIC_VAULT_ADDRESS once the validator is deployed.</span>}</div></div></section>;
}

function SidePanel({ page }: { page: Page }) {
  const content = page === "mint" ? ["Verified asset registry", "Independent valuation", "Proof-of-reserve record"] : page === "fractionalize" ? ["Flexible ownership sizes", "Transferable fractional units", "Full audit trail"] : page === "liquidate" ? ["Reserve-backed settlement", "Transparent pricing", "Dedicated support desk"] : ["Verified counter-parties", "Secure escrow settlement", "Real-time listing status"];
  const title = page === "mint" ? "Assets, made accessible." : page === "fractionalize" ? "Own what matters, your way." : page === "liquidate" ? "Liquidity, without the unknown." : "Discover the value you hold.";
  const icon = page === "mint" ? "RWA" : page === "fractionalize" ? "÷" : page === "liquidate" ? "$" : "↗";
  return <aside className="side-panel"><span className="panel-eyebrow">{page === "liquidate" ? "Settlement confidence" : page === "list" ? "Built for exchange" : "How it works"}</span><div className="panel-orbit"><i /><i /><b>{icon}</b></div><h3>{title}</h3><p className="panel-copy">Every action creates an auditable record, giving participants a clearer view of real-world value.</p><div className="benefit-list">{content.map((item, index) => <div key={item}><span>0{index + 1}</span>{item}</div>)}</div></aside>;
}

export default function RwaPlatform({ page }: { page: Page }) {
  const detail = pageDetails[page];
  const form = page === "mint" ? <MintForm /> : page === "fractionalize" ? <FractionalizeForm /> : page === "liquidate" ? <LiquidateForm /> : <ListForm />;
  return <div className="platform-shell"><header className="topbar"><Link href="/" className="brand"><span className="brand-mark"><i /><i /><i /></span><span>Vesper</span></Link><nav aria-label="Main navigation">{navItems.map((item) => <Link href={item.href} key={item.href} className={page === item.page ? "active" : ""}>{item.label}</Link>)}</nav><EternlWalletButton /></header><main className="page-main"><section className="hero"><div><span className="eyebrow"><span className="eyebrow-icon">{navItems.find((item) => item.page === page)?.icon}</span>{detail.eyebrow}</span><h1>{detail.title}</h1><p>{detail.description}</p></div>{page !== "wallets" && <div className="portfolio-pill"><span>Portfolio value</span><strong>$48,240.80</strong><small>+ 4.8% this month</small></div>}</section>{page === "wallets" ? <WalletDirectory /> : <div className="workspace">{form}<SidePanel page={page} /></div>}</main><footer><span>© 2025 Vesper Protocol</span><span>Built for real-world assets <b>•</b> Secured on-chain</span><div><a href="#">Terms</a><a href="#">Support</a></div></footer></div>;
}
