"use client";

import { useEffect, useState } from "react";
import PlatformHeader from "./platform-header";
import Cip25MintForm from "./cip25-mint-form";
import OnchainFractionalizeForm from "./fractionalize-form";
import MarketplaceWorkbench from "./marketplace-workbench";
import ReservesWorkbench from "./reserves-workbench";
import DexWorkbench from "./dex-workbench";
import { formatAda } from "@/lib/ada";

type Page = "mint" | "fractionalize" | "liquidate" | "marketplace" | "dex" | "reserves" | "wallets";

const pageIcons: Record<Page, string> = { mint: "◇", fractionalize: "◒", liquidate: "↘", marketplace: "□", dex: "DEX", reserves: "◈", wallets: "⌘" };

const pageDetails: Record<Page, { eyebrow: string; title: string; description: string }> = {
  mint: { eyebrow: "Asset origination", title: "Mint real-world value", description: "Create a verifiable on-chain representation of an off-chain asset." },
  fractionalize: { eyebrow: "Portfolio tooling", title: "Make ownership flexible", description: "Split an RWA into transferable units or reassemble units you hold." },
  liquidate: { eyebrow: "Redemption desk", title: "Exit with confidence", description: "Redeem eligible RWA tokens against the reserve and settle the position." },
  marketplace: { eyebrow: "Secondary market", title: "Buy and sell RWA tokens", description: "Trade verified real-world asset tokens through transparent on-chain escrow." },
  dex: { eyebrow: "Fraction exchange", title: "Trade fractional ownership", description: "Create and operate on-chain tADA liquidity pools for fractionalized RWA tokens." },
  reserves: { eyebrow: "Liquidity operations", title: "Fund Instant Sell", description: "Add or withdraw shared quote reserves used to settle approved RWA sales." },
  wallets: { eyebrow: "Operational directory", title: "Wallets & custody", description: "Inspect the public addresses that support each part of the RWA lifecycle." },
};

function Arrow() { return <span aria-hidden="true" className="button-arrow">↗</span>; }

function MintForm() {
  return <Cip25MintForm />;
}

function FractionalizeForm() {
  return <OnchainFractionalizeForm />;
}

function LiquidateForm() {
  return <section className="work-card form-card"><div className="section-heading"><div><span className="section-kicker">01 / Redemption request</span><h2>Choose a position to liquidate</h2></div><span className="step-badge">1 of 2</span></div><div className="asset-choice selected-choice"><div className="asset-monogram amber">SH</div><div><strong>Seaport Warehouse 04</strong><p>Commercial property · 42.5 RWA available</p></div><span className="asset-value">$12,750.00</span><span className="choice-check">✓</span></div><div className="asset-choice"><div className="asset-monogram moss">NS</div><div><strong>Northline Solar Project</strong><p>Renewable energy · 18.0 RWA available</p></div><span className="asset-value">$7,920.00</span></div><div className="liquidation-summary"><div><span>Requested amount</span><strong>42.5 RWA</strong></div><div><span>Estimated settlement</span><strong>$12,686.25</strong></div><div><span>Settlement window</span><strong>1–2 business days</strong></div></div><div className="form-footer"><p><span className="status-dot" /> Redemption eligibility verified.</p><button type="button" className="primary-button">Request liquidation <Arrow /></button></div></section>;
}

function MarketplaceForm() {
  return <MarketplaceWorkbench />;
}

function ReservesForm() {
  return <ReservesWorkbench />;
}

function DexForm() {
  return <DexWorkbench />;
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

  useEffect(() => { const timer = window.setTimeout(() => { void refreshBalances(); }, 0); return () => window.clearTimeout(timer); }, []);

  function formatBalance(lovelace: string | undefined) {
    return lovelace && /^\d+$/.test(lovelace) ? formatAda(BigInt(lovelace)) : "—";
  }

  async function copyAddress(name: string, address: string) {
    await navigator.clipboard.writeText(address);
    setCopied(name);
    window.setTimeout(() => setCopied(null), 1600);
  }

  return <section className="wallet-directory"><div className="wallet-directory-head"><div><span className="section-kicker">Public deployment addresses</span><h2>Inspect every operational wallet</h2></div><span className="network-badge"><i /> {network === "preprod" ? "Preprod" : "Mainnet"}</span></div><div className="directory-intro-row"><p className="directory-intro">Only public receiving addresses belong here—never seed phrases, signing keys, or private credentials. Select an address to inspect its balance and activity in Cexplorer.</p><button className="refresh-button" type="button" onClick={() => void refreshBalances()} disabled={balanceStatus === "loading"}>{balanceStatus === "loading" ? "Refreshing…" : "↻ Refresh balances"}</button></div><div className="wallet-grid">{walletRoles.map((wallet, index) => { const address = addresses[wallet.env]; const balance = address ? balances[address] : undefined; return <article className="wallet-card" key={wallet.name}><div className="wallet-card-top"><span className={`wallet-symbol ${wallet.tone}`}>0{index + 1}</span><span className="wallet-tag">{wallet.tag}</span></div><h3>{wallet.name}</h3><p>{wallet.purpose}</p><div className={address ? "address-box" : "address-box unconfigured"}>{address ? <code>{address}</code> : <span>Address not configured</span>}{address && <button type="button" aria-label={`Copy ${wallet.name} address`} onClick={() => copyAddress(wallet.name, address)}>{copied === wallet.name ? "Copied" : "Copy"}</button>}</div>{address && <div className="balance-row"><span>Available balance</span><strong>{balanceStatus === "error" ? "Unavailable" : `${formatBalance(balance)} tADA`}</strong></div>}{address ? <a className="explorer-link" href={`${cexplorerBase}${address}`} target="_blank" rel="noreferrer">View on Cexplorer <Arrow /></a> : <span className="explorer-link muted-link">Add {wallet.env} to enable inspection</span>}</article>; })}</div><div className="vault-callout"><span className="vault-callout-icon">◇</span><div><strong>The vault is a script address, not a user wallet.</strong><p>It secures the underlying RWA NFT while fractional tokens are in circulation.</p>{vaultAddress ? <a className="explorer-link vault-explorer-link" href={`${cexplorerBase}${vaultAddress}`} target="_blank" rel="noreferrer">Inspect vault on Cexplorer <Arrow /></a> : <span className="vault-config-hint">Add NEXT_PUBLIC_VAULT_ADDRESS once the validator is deployed.</span>}</div></div></section>;
}

function SidePanel({ page }: { page: Page }) {
  const content = page === "mint" ? ["Verified asset registry", "Independent valuation", "Proof-of-reserve record"] : page === "fractionalize" ? ["Flexible ownership sizes", "Transferable fractional units", "Full audit trail"] : page === "liquidate" ? ["Reserve-backed settlement", "Transparent pricing", "Dedicated support desk"] : ["Verified counter-parties", "Secure escrow settlement", "Real-time listing status"];
  const title = page === "mint" ? "Assets, made accessible." : page === "fractionalize" ? "Own what matters, your way." : page === "liquidate" ? "Liquidity, without the unknown." : "Discover the value you hold.";
  const icon = page === "mint" ? "RWA" : page === "fractionalize" ? "÷" : page === "liquidate" ? "$" : "↗";
  return <aside className="side-panel"><span className="panel-eyebrow">{page === "liquidate" ? "Settlement confidence" : page === "marketplace" || page === "reserves" ? "Built for exchange" : "How it works"}</span><div className="panel-orbit"><i /><i /><b>{icon}</b></div><h3>{title}</h3><p className="panel-copy">Every action creates an auditable record, giving participants a clearer view of real-world value.</p><div className="benefit-list">{content.map((item, index) => <div key={item}><span>0{index + 1}</span>{item}</div>)}</div></aside>;
}

export default function RwaPlatform({ page }: { page: Page }) {
  const detail = pageDetails[page];
  const form = page === "mint" ? <MintForm /> : page === "fractionalize" ? <FractionalizeForm /> : page === "liquidate" ? <LiquidateForm /> : page === "marketplace" ? <MarketplaceForm /> : page === "dex" ? <DexForm /> : <ReservesForm />;
  return <div className="platform-shell"><PlatformHeader /><main className="page-main"><section className="hero"><div><span className="eyebrow"><span className="eyebrow-icon">{pageIcons[page]}</span>{detail.eyebrow}</span><h1>{detail.title}</h1><p>{detail.description}</p></div></section>{page === "wallets" ? <WalletDirectory /> : <div className="workspace">{form}<SidePanel page={page} /></div>}</main><footer><span>© 2025 CSWAP Systems</span><span>Built for real-world assets <b>•</b> Secured on-chain</span><div><a href="#">Terms</a><a href="#">Support</a></div></footer></div>;
}
