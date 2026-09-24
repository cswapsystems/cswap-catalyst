"use client";
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./wallet-context";
import { readSharedPool, assertFreshPool } from "@/lib/protocol/shared-pool-client";
import { readInventory } from "@/lib/protocol/inventory";
import { buildMarketAction, lpDeposit, lpWithdrawal, marketUnit, type MarketAction } from "@/lib/marketplace";
import { formatAda } from "@/lib/ada";
import { useMarketTransaction } from "./use-market-transaction";
import MarketTransactionStatus from "./market-transaction-status";

export default function ReservesWorkbench({ revision = 0 }: { revision?: number }) {
  const { lucid, address, connect } = useWallet();
  const [pool, setPool] = useState<Awaited<ReturnType<typeof readSharedPool>> | null>(null);
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof readInventory>> | null>(null);
  const [held, setHeld] = useState(BigInt(0));
  const [mode, setMode] = useState<"deposit" | "withdraw" | "topup">("deposit");
  const [amount, setAmount] = useState(""), [acceptZero, setAcceptZero] = useState(false), [acceptExit, setAcceptExit] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setPool(null); setInventory(null); setHeld(BigInt(0)); setError("");
    if (!lucid || !address) return;
    setLoading(true);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const current = await readSharedPool(lucid, tools); setPool(current);
      setHeld((await lucid.wallet().getUtxos()).reduce((sum, utxo) => sum + (utxo.assets[current.lpUnit] || BigInt(0)), BigInt(0)));
      setInventory(await readInventory(lucid, tools, current));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reserves unavailable."); }
    finally { setLoading(false); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  const transaction = useMarketTransaction(refresh);
  const blocked = transaction.busy || Boolean(transaction.hash) || loading;
  const display = (value: bigint) => pool?.quote.policyId ? value.toString() + " quote base units" : formatAda(value) + " ADA";
  let preview = "", invalid = "", final = false;
  try {
    if (pool && amount) {
      if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("Use positive whole base units.");
      if (mode === "deposit") preview = "LP shares minted: " + lpDeposit(pool, BigInt(amount));
      else if (mode === "withdraw") {
        const result = lpWithdrawal(pool, BigInt(amount)); final = result.final;
        if (BigInt(amount) > held) throw new Error("Burn exceeds your wallet LP balance.");
        if (result.amount === BigInt(0) && !acceptZero) throw new Error("Confirm the zero-cash burn explicitly.");
        if (final && !pool.scripts.identity) throw new Error("Final exit is blocked: the handover does not include a reviewed burn-capable pool identity policy. Existing one_shot identities cannot burn.");
        if (final && !acceptExit) throw new Error("Confirm final exit and inventory recovery.");
        preview = "Burn " + amount + " LP units for " + display(result.amount) + (final ? ". Starts final LP exit." : ". This is cash-only; unsold inventory stays in the pool.");
      } else preview = "Donate " + display(BigInt(amount)) + " to reserve cash. No LP shares minted.";
    }
  } catch (cause) { invalid = cause instanceof Error ? cause.message : "Invalid amount."; }
  async function execute(action: MarketAction) {
    if (!lucid || !pool) return;
    const tools = await import("@lucid-evolution/lucid");
    await transaction.run(async () => {
      const fresh = await assertFreshPool(lucid, tools, pool);
      return buildMarketAction(lucid, tools, fresh.scripts, address, action, fresh);
    }, () => assertFreshPool(lucid, tools, pool));
  }
  return <section className="work-card form-card">
    <div className="section-heading"><h2>Shared reserves & LP exits</h2><button type="button" className="refresh-button" disabled={blocked} onClick={() => void refresh()}>Refresh state</button></div>
    {!lucid && <button type="button" className="primary-button" onClick={() => void connect()}>Connect wallet</button>}
    {error && <p role="alert" className="form-message error-message">{error}</p>}
    {pool && <>
      <div className="execution-preview"><code>{marketUnit(pool.quote)}</code><p>Cash: {display(pool.cash)} · Protected: {display(pool.minimum)}</p><p>Available cash: {display(pool.cash > pool.minimum ? pool.cash - pool.minimum : BigInt(0))}</p><p>Inventory cost basis: {display(pool.cost)} · Ask value: {display(pool.inventory)} · Open listings: {pool.count.toString()}</p><p>LP supply: {pool.supply.toString()} · Your wallet: {held.toString()} LP units</p><p>Deposit equity is cash + acquisition cost. Ask value is not cash. Partial withdrawals give up burned shares’ inventory exposure and pay only available cash.</p>{pool.paused && <p>Pool paused. Deposits and trading stop; cash-only withdrawals and top-ups remain available.</p>}</div>
      {pool.closing ? <section className="execution-preview"><h3>Final LP exit in progress</h3><code>{pool.closing.recipient}</code><p>{pool.count.toString()} listings still to return, one transaction per listing. Only the recorded LP signs recovery.</p>
        {inventory?.listings.map((listing) => <div className="position-card" key={listing.id}><div><code>{listing.unit}</code><p>{listing.quantity.toString()} units</p></div><button type="button" disabled={blocked || address !== pool.closing?.recipient} onClick={() => void execute({ kind: "return", listing })}>Return to exiting LP</button></div>)}
        <button type="button" className="primary-button" disabled={blocked || Boolean(pool.count || pool.cost || pool.inventory) || address !== pool.closing.recipient || !pool.scripts.identity} onClick={() => void execute({ kind: "complete" })}>Complete exit</button>
        {!pool.scripts.identity && <p role="alert">Completion requires a reviewed burn-capable identity policy. The current one_shot policy cannot burn; no safe completion script is configured.</p>}
      </section> : <fieldset className="module-fieldset" disabled={blocked}>
        <div className="segmented-control">{(["deposit", "withdraw", "topup"] as const).map((item) => <button type="button" className={mode === item ? "selected" : ""} key={item} onClick={() => { setMode(item); setAmount(""); setAcceptZero(false); setAcceptExit(false); }}>{item === "deposit" ? "LP deposit" : item === "withdraw" ? "Cash-only LP withdrawal" : "Top up (no shares)"}</button>)}</div>
        <label className="field"><span>{mode === "withdraw" ? "LP base units to burn" : "Quote base units to add"}</span><input inputMode="numeric" value={amount} onChange={(event) => { setAmount(event.target.value); setAcceptZero(false); setAcceptExit(false); }} /></label>
        <p className="wallet-assets-note">{pool.quote.policyId ? "Use the exact native quote asset's base units." : "ADA input is lovelace: 1 ADA = 1,000,000 lovelace."}</p>
        {mode === "withdraw" && <><label><input type="checkbox" checked={acceptZero} onChange={(event) => setAcceptZero(event.target.checked)} /> I accept burning these shares even if the cash payout is zero.</label><label><input type="checkbox" checked={acceptExit} onChange={(event) => setAcceptExit(event.target.checked)} /> If this burns the final supply, I accept starting the multi-transaction inventory recovery and exit.</label></>}
        {preview && <p className="execution-preview">{preview}</p>}{invalid && <p role="status">{invalid}</p>}
        <button type="button" className="primary-button" disabled={!amount || Boolean(invalid) || (mode === "deposit" && pool.paused)} onClick={() => void execute(mode === "withdraw" ? { kind: "withdraw", burned: BigInt(amount), acceptZero } : { kind: mode, amount: BigInt(amount) })}>Sign {mode === "withdraw" && final ? "final LP exit" : mode}</button>
      </fieldset>}
    </>}
    <MarketTransactionStatus {...transaction} />
  </section>;
}
