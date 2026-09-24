"use client";
import { useCallback, useEffect, useState } from "react";
import { readLegacyRequests, type LegacyRequest } from "@/lib/protocol/legacy-requests";
import { useWallet } from "./wallet-context";
import { useMarketTransaction } from "./use-market-transaction";
import MarketTransactionStatus from "./market-transaction-status";
export default function LegacyRequestRecovery() {
  const { lucid, address } = useWallet();
  const [requests, setRequests] = useState<LegacyRequest[]>([]), [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setRequests([]); setError(""); if (!lucid || !address) return;
    try { const tools = await import("@lucid-evolution/lucid"); const result = await readLegacyRequests(lucid, tools, address); setRequests(result.requests); if (result.skipped) setError(result.skipped + " unreadable historical outputs skipped."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Legacy recovery unavailable."); }
  }, [lucid, address]);
  useEffect(() => { void refresh(); }, [refresh]);
  const transaction = useMarketTransaction(refresh);
  async function cancel(request: LegacyRequest) {
    if (!lucid) return;
    await transaction.run(async () => {
      const tools = await import("@lucid-evolution/lucid");
      if (tools.getAddressDetails(address).paymentCredential?.hash !== request.key) throw new Error("Connect the request owner.");
      const current = (await lucid.utxosByOutRef([request.utxo]))[0];
      if (!current || current.datum !== request.utxo.datum) throw new Error("Request no longer available.");
      return lucid.newTx().collectFrom([current], tools.Data.to(new tools.Constr(1, []))).attach.SpendingValidator(request.script).pay.ToAddress(request.seller, current.assets).addSigner(address);
    });
  }
  if (!lucid) return null;
  return <section className="marketplace-book"><h3>Legacy request recovery · cancellation only</h3><p>Old request escrows are never settled through the new pool. Owners may cancel with the exact archived validator.</p>{error && <p role="status">{error}</p>}{requests.map((request) => <article className="position-card" key={request.id}><div><code>{request.unit}</code><p>{request.quantity.toString()} base units</p></div><button type="button" disabled={transaction.busy || Boolean(transaction.hash)} onClick={() => void cancel(request)}>Cancel legacy request</button></article>)}{!requests.length && !error && <p>No legacy requests found for this wallet.</p>}<MarketTransactionStatus {...transaction} /></section>;
}
