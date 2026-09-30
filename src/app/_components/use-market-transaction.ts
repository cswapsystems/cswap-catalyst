"use client";
import { useEffect, useRef, useState } from "react";
import type { TxBuilder } from "@lucid-evolution/lucid";
import { assertMarketWallet } from "@/lib/protocol/shared-pool-client";
import { confirmTransaction } from "@/lib/transaction-confirmation";
import { clearPendingMarket, PENDING_MARKET_EVENT, PENDING_MARKET_PREFIX, readPendingMarket, savePendingMarket, type PendingMarketTransaction } from "@/lib/pending-market-transaction";
import { useWallet } from "./wallet-context";

type Recovery = { wallet: string; state: ReturnType<typeof readPendingMarket> };
const unavailable = { kind: "unavailable" as const, message: "Local transaction recovery storage is unavailable. Enable browser storage before signing." };
function stored(wallet: string): Recovery["state"] {
  try { return readPendingMarket(window.localStorage, wallet); }
  catch { return unavailable; }
}

export function useMarketTransaction(onConfirmed: () => Promise<void>, operation: string, onSuccess?: (transaction: PendingMarketTransaction) => boolean) {
  const { lucid, address } = useWallet();
  const [busy, setBusy] = useState(false), [recovery, setRecovery] = useState<Recovery | null>(null);
  const [message, setMessage] = useState(""), [recoveryWarning, setRecoveryWarning] = useState("");
  const addressRef = useRef(address);
  addressRef.current = address;
  useEffect(() => {
    if (!address) { setRecovery(null); return; }
    const refresh = () => setRecovery({ wallet: address, state: stored(address) });
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === PENDING_MARKET_PREFIX + address) refresh(); };
    refresh();
    window.addEventListener("storage", changed);
    window.addEventListener(PENDING_MARKET_EVENT, refresh);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener(PENDING_MARKET_EVENT, refresh); };
  }, [address]);
  const state = recovery?.wallet === address ? recovery.state : null;
  const pending = state?.kind === "pending" ? state.transaction : null;
  const hash = pending?.hash ?? "";
  const recoveryError = state?.kind === "unavailable" ? state.message : "";
  const ready = Boolean(address && state);
  const broadcast = () => window.dispatchEvent(new Event(PENDING_MARKET_EVENT));
  async function run(prepare: () => Promise<TxBuilder>, revalidate?: () => Promise<unknown>, onSubmitted?: (hash: string) => void, operationName = operation) {
    if (!lucid || !address || busy || !ready || pending || recoveryError) return;
    const owner = address;
    setBusy(true); setMessage("");
    try {
      const before = stored(owner);
      if (before.kind !== "empty") { setRecovery({ wallet: owner, state: before }); throw new Error(before.kind === "pending" ? "A Marketplace transaction is awaiting confirmation. Check it before signing again." : before.message); }
      await assertMarketWallet(lucid, address);
      const completed = await (await prepare()).complete();
      await revalidate?.();
      await assertMarketWallet(lucid, address);
      const latest = stored(owner);
      if (latest.kind !== "empty") { setRecovery({ wallet: owner, state: latest }); throw new Error(latest.kind === "pending" ? "A Marketplace transaction is awaiting confirmation. Check it before signing again." : latest.message); }
      const submitted = await (await completed.sign.withWallet().complete()).submit();
      const record: PendingMarketTransaction = { version: 1, network: "preprod", wallet: owner, operation: operationName, hash: submitted, submittedAt: Date.now() };
      setRecovery({ wallet: owner, state: { kind: "pending", transaction: record } });
      try { savePendingMarket(window.localStorage, record); broadcast(); }
      catch { setRecoveryWarning("This submitted hash could not be saved in browser storage. Keep this page open and copy the transaction hash before navigating away."); }
      onSubmitted?.(submitted); setMessage("Submitted: " + submitted + ". Awaiting confirmation.");
      if (!await confirmTransaction(lucid, submitted)) throw new Error("Confirmation not yet verified. Check the submitted transaction before retrying.");
      clearPendingMarket(window.localStorage, owner, submitted); broadcast(); setRecoveryWarning("");
      if (addressRef.current === owner) { setRecovery({ wallet: owner, state: { kind: "empty" } }); await onConfirmed(); setMessage(onSuccess?.(record) ? "" : "Confirmed: " + submitted); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction could not be completed."); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!pending || busy || !address) return; setBusy(true);
    const owner = address, submitted = pending.hash;
    try { const response = await fetch("/api/blockfrost/txs/" + submitted, { cache: "no-store" }); if (!response.ok) throw new Error("Transaction is not confirmed yet. Do not retry until its fate is known."); clearPendingMarket(window.localStorage, owner, submitted); broadcast(); setRecoveryWarning(""); if (addressRef.current === owner) { setRecovery({ wallet: owner, state: { kind: "empty" } }); await onConfirmed(); setMessage(onSuccess?.(pending) ? "" : "Transaction confirmed."); } }
    catch (error) { setMessage(error instanceof Error ? error.message : "Confirmation unavailable."); }
    finally { setBusy(false); }
  }
  return { busy: busy || !ready || Boolean(recoveryError), hash, message, setMessage, run, check, pendingOperation: pending?.operation ?? "", recoveryError, recoveryWarning, ready };
}
