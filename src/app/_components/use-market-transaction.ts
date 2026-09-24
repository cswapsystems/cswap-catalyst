"use client";
import { useState } from "react";
import type { TxBuilder } from "@lucid-evolution/lucid";
import { assertMarketWallet } from "@/lib/protocol/shared-pool-client";
import { confirmTransaction } from "@/lib/transaction-confirmation";
import { useWallet } from "./wallet-context";

export function useMarketTransaction(onConfirmed: () => Promise<void>) {
  const { lucid, address } = useWallet();
  const [busy, setBusy] = useState(false), [hash, setHash] = useState(""), [message, setMessage] = useState("");
  async function run(prepare: () => Promise<TxBuilder>, revalidate?: () => Promise<unknown>, onSubmitted?: (hash: string) => void) {
    if (!lucid || !address || busy || hash) return;
    setBusy(true); setMessage("");
    try {
      await assertMarketWallet(lucid, address);
      const completed = await (await prepare()).complete();
      await revalidate?.();
      await assertMarketWallet(lucid, address);
      const submitted = await (await completed.sign.withWallet().complete()).submit();
      setHash(submitted); onSubmitted?.(submitted); setMessage("Submitted: " + submitted + ". Awaiting confirmation.");
      if (!await confirmTransaction(lucid, submitted)) throw new Error("Confirmation not yet verified. Check the submitted transaction before retrying.");
      setHash(""); await onConfirmed(); setMessage("Confirmed: " + submitted);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction could not be completed."); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!hash || busy) return; setBusy(true);
    try { const response = await fetch("/api/blockfrost/txs/" + hash, { cache: "no-store" }); if (!response.ok) throw new Error("Transaction is not confirmed yet."); setHash(""); await onConfirmed(); setMessage("Transaction confirmed."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Confirmation unavailable."); }
    finally { setBusy(false); }
  }
  return { busy, hash, message, setMessage, run, check };
}
