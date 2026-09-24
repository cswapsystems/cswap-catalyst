"use client";
export default function MarketTransactionStatus({ busy, hash, message, check }: { busy: boolean; hash: string; message: string; check: () => Promise<void> }) {
  return <>{message && <p className="form-message" role="status">{message}</p>}{hash && <p className="registry-transaction"><a href={"https://preprod.cardanoscan.io/transaction/" + hash} target="_blank" rel="noreferrer">Inspect submitted transaction</a><button type="button" disabled={busy} onClick={() => void check()}>Check confirmation</button></p>}</>;
}
