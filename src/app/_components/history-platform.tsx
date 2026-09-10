"use client";

import { useEffect, useMemo, useState } from "react";
import PlatformHeader from "./platform-header";
import { useWallet } from "./wallet-context";

const historyStyles = `
.history-board { padding: clamp(25px, 4vw, 46px); border: 1px solid var(--line); border-radius: 14px; background: var(--cream); box-shadow: 0 22px 50px rgba(38,50,40,.07); }
.history-board-head { display: flex; align-items: start; justify-content: space-between; gap: 20px; }
.history-board h2 { margin-top: 8px; font-family: var(--font-financial); font-size: 29px; font-weight: 750; letter-spacing: -1px; }
.history-intro { max-width: 680px; margin-top: 17px; color: var(--muted); font-size: 16px; line-height: 1.6; }
.history-wallet { display: flex; align-items: center; gap: 9px; min-width: 230px; padding: 11px 13px; color: #65736b; border: 1px solid #dce2d8; border-radius: 7px; background: #f6f8f3; font-size: 13px; }
.history-wallet i { width: 7px; height: 7px; flex: 0 0 auto; background: #82b865; border-radius: 50%; }
.history-wallet code { overflow: hidden; color: var(--deep-moss); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.history-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px 0 15px; margin-top: 28px; border-top: 1px solid var(--line); }
.history-filters { display: flex; flex-wrap: wrap; gap: 5px; }
.history-filter { padding: 8px 11px; color: #7c8780; border: 1px solid #dbe1d8; border-radius: 999px; background: white; font-size: 13px; font-weight: 800; }
.history-filter.active { color: var(--deep-moss); border-color: var(--deep-moss); background: #eaf0e5; }
.history-refresh { padding: 8px 11px; color: var(--moss); border: 1px solid #cfd8c9; border-radius: 5px; background: white; font-size: 13px; font-weight: 800; }
.history-refresh:disabled { cursor: wait; opacity: .65; }
.history-list { overflow: hidden; border: 1px solid #e0e5dc; border-radius: 8px; background: white; }
.history-row { display: grid; grid-template-columns: 42px minmax(150px, 1.4fr) minmax(100px, .9fr) minmax(92px, .65fr) auto; align-items: center; gap: 16px; padding: 17px 18px; border-bottom: 1px solid #edf0eb; }
.history-row:last-child { border-bottom: 0; }
.history-icon { display: grid; place-items: center; width: 35px; height: 35px; color: var(--deep-moss); background: var(--lime); border-radius: 50%; font-size: 14px; font-weight: 900; }
.history-icon.fractionalize { background: #dce9c7; }.history-icon.combine { background: #f5dea1; color: #765d21; }.history-icon.list { background: #cbe5e7; color: #356a70; }.history-icon.buy { background: #ffd2c8; color: #994b3b; }
.history-action strong, .history-action small { display: block; }.history-action strong { font-size: 15px; }.history-action small { margin-top: 5px; color: #89928d; font-size: 13px; }
.history-detail span, .history-meta span { display: block; color: #9aa39d; font-size: 12px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase; }.history-detail strong, .history-meta strong { display: block; margin-top: 5px; color: #536158; font-size: 14px; }
.history-meta { text-align: right; }.history-link { color: var(--moss); font-size: 14px; font-weight: 800; text-decoration: none; white-space: nowrap; }.history-link:hover { color: var(--deep-moss); }
.history-empty { display: grid; justify-items: center; padding: 55px 25px; text-align: center; border: 1px dashed #bdc8ba; border-radius: 8px; background: #f7f9f3; }.history-empty-mark { display: grid; place-items: center; width: 55px; height: 55px; color: var(--deep-moss); background: var(--lime); border-radius: 50%; font-size: 24px; }.history-empty strong { margin-top: 17px; font-size: 17px; }.history-empty p { max-width: 480px; margin-top: 7px; color: #89928d; font-size: 14px; line-height: 1.6; }.history-empty .primary-button { margin-top: 19px; }
.history-error { padding: 12px 14px; margin-bottom: 15px; color: #843728; background: #fff0ec; border-radius: 5px; font-size: 14px; line-height: 1.45; }.history-note { margin-top: 13px; color: #9aa39d; font-size: 13px; }
.history-mint-name { color: var(--moss) !important; font-weight: 800; }.history-metadata { grid-column: 2 / -1; margin-top: 3px; }.history-metadata summary { color: var(--moss); cursor: pointer; font-size: 13px; font-weight: 800; }.history-metadata pre { max-height: 220px; padding: 12px; margin-top: 9px; overflow: auto; color: #536158; background: #f5f7f2; border-radius: 6px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
@media (max-width: 800px) { .history-board-head { flex-direction: column; }.history-wallet { min-width: 0; width: 100%; }.history-row { grid-template-columns: 35px minmax(0, 1fr) auto; gap: 11px; }.history-detail { grid-column: 2; }.history-meta { grid-column: 3; grid-row: 1 / span 2; }.history-link { grid-column: 2 / -1; }.history-toolbar { align-items: start; flex-direction: column; gap: 12px; } }
@media (max-width: 480px) { .history-board { padding: 26px 20px; }.history-row { padding: 14px 12px; }.history-detail strong { font-size: 13px; }.history-action strong { font-size: 14px; } }
`;

type ActionType = "Mint" | "Fractionalize" | "Combine" | "List" | "Buy";
type Filter = "All" | ActionType;
type AddressTransaction = { tx_hash: string; block_time?: number; block_height?: number };
type TxDetails = { fees?: string };
type MintRecord = { asset?: string; quantity?: string };
type MetadataRecord = { label?: string; json_metadata?: unknown };
type RedeemerRecord = { redeemer_data?: unknown };
type HistoryTransaction = { hash: string; type: ActionType; timestamp?: number; block?: number; fee?: string; asset?: string; quantity?: string; metadata?: MetadataRecord[] };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function formatQuantity(value: string | undefined) { if (!value) return "—"; const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(Math.abs(number)) : value; }
function formatAda(lovelace: string | undefined) { if (!lovelace) return "—"; const number = Number(lovelace) / 1000000; return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(number) + " ₳" : "—"; }
function findMetadataValue(value: unknown, key: string): string | null { if (isRecord(value)) { const match = value[key]; if (typeof match === "string") return match; for (const child of Object.values(value)) { const found = findMetadataValue(child, key); if (found) return found; } } else if (Array.isArray(value)) { for (const child of value) { const found = findMetadataValue(child, key); if (found) return found; } } return null; }
function mintMetadataName(metadata: MetadataRecord[] | undefined) { const label721 = metadata?.find((entry) => entry.label === "721"); return findMetadataValue(label721?.json_metadata, "name"); }
function formatDate(timestamp: number | undefined) { return timestamp ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(timestamp * 1_000) : "Unknown date"; }
function shortAsset(value: string | undefined) { return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "Native asset movement"; }
function explorerUrl(hash: string) { return `${process.env.NEXT_PUBLIC_CARDANO_NETWORK === "preprod" ? "https://preprod." : "https://"}cexplorer.io/tx/${hash}`; }

function constructorIndexes(value: unknown): number[] {
  if (typeof value === "string") { try { return constructorIndexes(JSON.parse(value)); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(constructorIndexes);
  if (!isRecord(value)) return [];
  const constructor = value["constructor"];
  return (typeof constructor === "number" ? [constructor] : []).concat(Object.values(value).flatMap(constructorIndexes));
}

function classify(metadata: MetadataRecord[], mints: MintRecord[], redeemers: RedeemerRecord[]): ActionType | null {
  const text = JSON.stringify(metadata).toLowerCase();
  if (/fractionaliz|combine|withdraw|burn/.test(text)) return /fractionaliz/.test(text) ? "Fractionalize" : "Combine";
  if (/buyrwa|"buy"|purchase/.test(text)) return "Buy";
  if (/sellrwa|listing|"list"/.test(text)) return "List";

  const quantities = mints.map((mint) => Number(mint.quantity ?? 0)).filter(Number.isFinite);
  if (quantities.some((quantity) => quantity < 0)) return "Combine";
  if (metadata.some((entry) => entry.label === "721")) return "Mint";
  if (quantities.some((quantity) => quantity > 1)) return "Fractionalize";
  if (quantities.some((quantity) => quantity > 0)) return "Mint";

  const indexes = redeemers.flatMap((redeemer) => constructorIndexes(redeemer.redeemer_data));
  if (indexes.includes(3)) return "Buy";
  if (indexes.includes(2)) return "List";
  if (indexes.includes(0)) return "Buy";
  return null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  return response.json().catch(() => null) as Promise<T | null>;
}

async function loadHistory(address: string): Promise<HistoryTransaction[]> {
  const transactions = await fetchJson<AddressTransaction[]>(`/api/blockfrost/addresses/${encodeURIComponent(address)}/transactions?order=desc&count=50`);
  if (!transactions) throw new Error("Unable to load transactions for this wallet.");

  const history: Array<HistoryTransaction | null> = await Promise.all(transactions.map(async (transaction) => {
    const [details, metadata, mints, redeemers] = await Promise.all([
      fetchJson<TxDetails>(`/api/blockfrost/txs/${transaction.tx_hash}`),
      fetchJson<MetadataRecord[]>(`/api/blockfrost/txs/${transaction.tx_hash}/metadata`),
      fetchJson<MintRecord[]>(`/api/blockfrost/txs/${transaction.tx_hash}/mints`),
      fetchJson<RedeemerRecord[]>(`/api/blockfrost/txs/${transaction.tx_hash}/redeemers`),
    ]);
    const safeMints = mints ?? [];
    const type = classify(metadata ?? [], safeMints, redeemers ?? []);
    if (!type) return null;
    const firstMint = safeMints[0];
    return { hash: transaction.tx_hash, type, timestamp: transaction.block_time, block: transaction.block_height, fee: details?.fees, asset: firstMint?.asset, quantity: firstMint?.quantity, metadata: type === "Mint" ? metadata ?? [] : undefined };
  }));
  return history.filter((transaction): transaction is HistoryTransaction => transaction !== null);
}

const actionIcons: Record<ActionType, string> = { Mint: "◇", Fractionalize: "◒", Combine: "↙", List: "□", Buy: "↗" };

function HistoryBoard() {
  const { address, status, connect } = useWallet();
  const [transactions, setTransactions] = useState<HistoryTransaction[]>([]);
  const [filter, setFilter] = useState<Filter>("All");
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) { setLoadStatus("loading"); setError(""); } });
    void loadHistory(address).then((history) => { if (!cancelled) { setTransactions(history); setLoadStatus("ready"); } }).catch((cause) => { if (!cancelled) { setLoadStatus("error"); setError(cause instanceof Error ? cause.message : "Unable to load transaction history."); } });
    return () => { cancelled = true; };
  }, [address, refreshKey]);

  const visibleTransactions = useMemo(() => filter === "All" ? transactions : transactions.filter((transaction) => transaction.type === filter), [filter, transactions]);
  const counts = useMemo(() => transactions.reduce<Record<string, number>>((result, transaction) => { result[transaction.type] = (result[transaction.type] ?? 0) + 1; return result; }, {}), [transactions]);
  const isLoading = Boolean(address) && (loadStatus === "loading" || loadStatus === "idle");

  return <section className="history-board"><div className="history-board-head"><div><span className="section-kicker">On-chain activity</span><h2>Your transaction trail</h2><p className="history-intro">Review the RWA actions signed by your connected wallet. Each entry links to its confirmed Cardano transaction for independent verification.</p></div>{address ? <span className="history-wallet"><i /> <code>{address}</code></span> : <span className="network-badge"><i /> Connect to begin</span>}</div>
    {!address && <div className="history-empty"><span className="history-empty-mark">⌁</span><strong>Connect Eternl to view your history</strong><p>Your wallet address is only used to read its public transaction activity from Cardano Preprod. No signing request is made on this page.</p><button type="button" className="primary-button" onClick={() => void connect()} disabled={status === "connecting"}>{status === "connecting" ? "Connecting…" : "Connect Eternl"} <span className="button-arrow">↗</span></button></div>}
    {address && <><div className="history-toolbar"><div className="history-filters">{(["All", "Mint", "Fractionalize", "Combine", "List", "Buy"] as Filter[]).map((item) => <button type="button" key={item} className={`history-filter ${filter === item ? "active" : ""}`} onClick={() => setFilter(item)}>{item}{item !== "All" && ` · ${counts[item] ?? 0}`}</button>)}</div><button type="button" className="history-refresh" onClick={() => setRefreshKey((key) => key + 1)} disabled={isLoading}>{loadStatus === "loading" ? "Refreshing…" : "↻ Refresh"}</button></div>{error && <p className="history-error" role="alert">{error}</p>}{isLoading && <div className="history-empty"><span className="history-empty-mark">…</span><strong>Reading your on-chain activity</strong><p>Looking for confirmed lifecycle actions on Cardano Preprod.</p></div>}{loadStatus === "ready" && visibleTransactions.length === 0 && <div className="history-empty"><span className="history-empty-mark">◇</span><strong>{transactions.length ? "No actions match this filter" : "No tracked actions yet"}</strong><p>{transactions.length ? "Choose another activity type to see more of this wallet’s history." : "Mint, fractionalize, combine, list, or buy an RWA asset and the confirmed transaction will appear here."}</p></div>}{loadStatus === "ready" && visibleTransactions.length > 0 && <div className="history-list">{visibleTransactions.map((transaction) => <article className="history-row" key={transaction.hash}><span className={`history-icon ${transaction.type.toLowerCase()}`}>{actionIcons[transaction.type]}</span><div className="history-action"><strong>{transaction.type}</strong><small>{formatDate(transaction.timestamp)}</small>{transaction.type === "Mint" && mintMetadataName(transaction.metadata) && <small className="history-mint-name">{mintMetadataName(transaction.metadata)}</small>}</div><div className="history-detail"><span>Asset activity</span><strong>{transaction.quantity ? `${Number(transaction.quantity) >= 0 ? "+" : "−"}${formatQuantity(transaction.quantity)} ${transaction.type === "Mint" ? "NFT" : "units"}` : shortAsset(transaction.asset)}</strong></div><div className="history-meta"><span>Network fee</span><strong>{transaction.fee ? formatAda(transaction.fee) : "—"}</strong></div><a className="history-link" href={explorerUrl(transaction.hash)} target="_blank" rel="noreferrer">View tx ↗</a>{transaction.type === "Mint" && transaction.metadata && transaction.metadata.length > 0 && <details className="history-metadata"><summary>View mint metadata</summary><pre>{JSON.stringify(transaction.metadata, null, 2)}</pre></details>}</article>)}</div>}{loadStatus === "ready" && transactions.length > 0 && <p className="history-note">Showing {visibleTransactions.length} of {transactions.length} tracked actions from the latest wallet activity.</p>}</>}
  </section>;
}

export default function HistoryPlatform() {
  return <div className="platform-shell"><style>{historyStyles}</style><PlatformHeader /><main className="page-main"><section className="hero"><div><span className="eyebrow"><span className="eyebrow-icon">◷</span>Transaction history</span><h1>Every action, accounted for.</h1><p>Follow the on-chain trail of your real-world asset positions, from first mint to secondary-market purchase.</p></div><div className="portfolio-pill"><span>Tracked actions</span><strong>Mint · Trade · Own</strong><small>Verified on Cardano</small></div></section><HistoryBoard /></main><footer><span>© 2025 CSWAP Systems</span><span>Built for real-world assets <b>•</b> Secured on-chain</span><div><a href="#">Terms</a><a href="#">Support</a></div></footer></div>;
}
