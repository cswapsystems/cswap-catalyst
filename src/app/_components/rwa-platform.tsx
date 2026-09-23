"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import PlatformHeader from "./platform-header";
import Cip25MintForm from "./cip25-mint-form";
import MarketplaceWorkbench from "./marketplace-workbench";
import { formatAda } from "@/lib/ada";

type Page = "mint" | "marketplace" | "wallets";

const pageIcons: Record<Page, string> = { mint: "◇", marketplace: "□", wallets: "⌘" };

const pageDetails: Record<Page, { eyebrow: string; title: string; description: string }> = {
  mint: { eyebrow: "Create", title: "Mint an asset", description: "Create an asset token with its supporting metadata. Minting does not automatically approve it for trading." },
  marketplace: { eyebrow: "Secondary market", title: "Marketplace", description: "Buy listed RWA and fraction tokens, or edit and cancel your listings. Create sales from Portfolio." },
  wallets: { eyebrow: "Operational directory", title: "Wallets & custody", description: "Inspect the public addresses that support each part of the RWA lifecycle." },
};

function Arrow() { return <span aria-hidden="true" className="button-arrow">↗</span>; }

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
  const content = page === "mint" ? ["Add the asset details", "Attach supporting documents", "Review and sign in Eternl"] : ["Review the asset and price", "Connect your wallet", "Review and sign the purchase"];
  const title = page === "mint" ? "From asset to token." : "Know what you are buying.";
  const icon = page === "mint" ? "RWA" : "↗";
  return <aside className="side-panel"><span className="panel-eyebrow">How it works</span><div className="panel-orbit"><i /><i /><b>{icon}</b></div><h3>{title}</h3><p className="panel-copy">Review the asset documentation and exact token identity. An on-chain token does not independently verify the underlying asset.</p><div className="benefit-list">{content.map((item, index) => <div key={item}><span>0{index + 1}</span>{item}</div>)}</div></aside>;
}

export default function RwaPlatform({ page }: { page: Page }) {
  const detail = pageDetails[page];
  const form = page === "mint" ? <Cip25MintForm /> : <MarketplaceWorkbench />;
  return <div className="platform-shell"><PlatformHeader /><main id="main-content" tabIndex={-1} className="page-main"><section className="hero"><div><span className="eyebrow"><span className="eyebrow-icon">{pageIcons[page]}</span>{detail.eyebrow}</span><h1>{detail.title}</h1><p>{detail.description}</p></div></section>{page === "wallets" ? <WalletDirectory /> : <div className="workspace">{form}<SidePanel page={page} /></div>}</main><footer><span>CSWAP Systems</span><span>Preprod testnet <b>•</b> Test assets only</span><div><Link href="/protocol">Protocol status</Link><Link href="/asset-registry">Approved assets</Link></div></footer></div>;
}
