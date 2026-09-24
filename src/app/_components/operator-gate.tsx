"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import ModulePage from "./module-page";
import { useWallet } from "./wallet-context";

export default function OperatorGate({ children }: { children: ReactNode }) {
  const { operatorAccess, status, error, connect, disconnect } = useWallet();
  if (operatorAccess === "allowed") return children;
  const checking = operatorAccess === "checking" || status === "connecting";
  return <ModulePage title="Operator console" description="This workspace is available only to the configured operator or Team wallet.">
    <section className="operator-access-card" aria-labelledby="operator-access-title">
      <h2 id="operator-access-title">{checking ? "Checking wallet access…" : status === "connected" ? "This wallet does not have operator access" : "Connect an operator or Team wallet"}</h2>
      <p role="status">{checking ? "Controls remain locked until the connected payment key is verified." : "Use the marketplace operator, configured Team recovery wallet, or DEX Team creator. Switching accounts requires reconnecting the wallet."}</p>
      {error && <p role="alert">{error}</p>}
      <div>{status === "connected" ? <button type="button" className="primary-button" onClick={disconnect}>Disconnect wallet</button> : <button type="button" className="primary-button" disabled={checking} onClick={() => void connect()}>Connect Eternl</button>}<Link href="/my-assets">Back to Portfolio</Link></div>
    </section>
  </ModulePage>;
}
