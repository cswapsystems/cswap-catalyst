"use client";

import { useId } from "react";
import { formatAda } from "@/lib/ada";
import { findSwapMarket, swapTargets, swapTokens } from "@/lib/dex-swap";
import { type AssetClass, type Pool, assetUnit, displayName, format } from "@/lib/protocol/dex-client";

type Props = {
  pools: Pool[];
  pool?: Pool;
  reverse: boolean;
  amount: string;
  estimate: bigint | null;
  balances: Record<string, bigint>;
  connected: boolean;
  onAmount: (value: string) => void;
  onPair: (id: string, action: "swap-a" | "swap-b") => void;
};

const showAmount = (value: bigint, asset?: AssetClass) => asset && !asset.policyId ? formatAda(value) : format(value);
const tokenLabel = (asset: AssetClass) => displayName(asset) + (asset.policyId ? ` · ${asset.policyId.slice(0, 6)}…` : "");

export default function DexSwapFields({ pools, pool, reverse, amount, estimate, balances, connected, onAmount, onPair }: Props) {
  const id = useId();
  const from = reverse ? pool?.assetB : pool?.assetA;
  const to = reverse ? pool?.assetA : pool?.assetB;
  const fromUnit = from ? assetUnit(from) : "";
  const toUnit = to ? assetUnit(to) : "";
  const tokens = swapTokens(pools);
  const targets = swapTargets(pools, fromUnit);
  function changeFrom(value: string) {
    const preferredTo = value === toUnit ? fromUnit : toUnit;
    const next = findSwapMarket(pools, value, preferredTo, pool?.id) ?? findSwapMarket(pools, value);
    if (next) onPair(next.id, next.action);
  }
  function changeTo(value: string) {
    const next = findSwapMarket(pools, fromUnit, value, pool?.id);
    if (next) onPair(next.id, next.action);
  }
  const balance = (asset?: AssetClass) => connected && asset ? showAmount(balances[assetUnit(asset)] ?? BigInt(0), asset) : "—";

  return <div className="swap-fields">
    <div className="swap-token-panel">
      <div className="swap-panel-caption"><label htmlFor={`${id}-from-amount`}>From</label><span>Balance: {balance(from)}</span></div>
      <div className="swap-panel-entry">
        <input id={`${id}-from-amount`} aria-label="From amount" type="text" inputMode={from?.policyId ? "numeric" : "decimal"} autoComplete="off" spellCheck={false} placeholder="0" value={amount} onChange={(event) => onAmount(event.target.value)} disabled={!pool} required />
        <div className="swap-token-picker"><span className="swap-token-icon" aria-hidden="true">{from ? from.policyId ? displayName(from).slice(0, 1) : "₳" : "?"}</span><select aria-label="From token" title={fromUnit || "Select token"} value={fromUnit} onChange={(event) => changeFrom(event.target.value)} disabled={!tokens.length}>{tokens.length ? tokens.map((token) => <option key={assetUnit(token)} value={assetUnit(token)}>{tokenLabel(token)}</option>) : <option value="">Select token</option>}</select></div>
      </div>
      <div className="swap-panel-note">{from?.policyId ? "Amount in token base units" : "Amount in tADA"}</div>
    </div>
    <button type="button" className="swap-direction" aria-label="Reverse swap direction" title="Reverse swap direction" disabled={!pool} onClick={() => { if (pool) onPair(pool.id, reverse ? "swap-a" : "swap-b"); }}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4" /></svg></button>
    <div className="swap-token-panel swap-token-panel-output">
      <div className="swap-panel-caption"><label htmlFor={`${id}-to-amount`}>To <small>(estimated)</small></label><span>Balance: {balance(to)}</span></div>
      <div className="swap-panel-entry">
        <input id={`${id}-to-amount`} aria-label="To amount" type="text" readOnly placeholder="0" value={estimate && estimate > BigInt(0) ? showAmount(estimate, to) : ""} />
        <div className="swap-token-picker"><span className="swap-token-icon" aria-hidden="true">{to ? to.policyId ? displayName(to).slice(0, 1) : "₳" : "?"}</span><select aria-label="To token" title={toUnit || "Select token"} value={toUnit} onChange={(event) => changeTo(event.target.value)} disabled={!targets.length}>{targets.length ? targets.map((token) => <option key={assetUnit(token)} value={assetUnit(token)}>{tokenLabel(token)}</option>) : <option value="">Select token</option>}</select></div>
      </div>
      <div className="swap-panel-note">{to?.policyId ? "Amount in token base units" : to ? "Amount in tADA" : "Choose a pair to see your quote"}</div>
    </div>
    {pool && estimate !== null && estimate > BigInt(0) && <dl className="swap-quote-details" aria-live="polite"><div><dt>Minimum received</dt><dd>{showAmount(estimate, to)} {to ? displayName(to) : ""}{to?.policyId ? " base units" : ""}</dd></div><div><dt>Pool fee · included</dt><dd>{Number(pool.feeD - pool.feeN) / Number(pool.feeD) * 100}%</dd></div></dl>}
  </div>;
}
