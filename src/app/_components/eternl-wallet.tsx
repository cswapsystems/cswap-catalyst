"use client";

import { useWallet } from "./wallet-context";

export default function EternlWalletButton() {
  const { address, status, error, connect } = useWallet();

  if (status === "connected") return <span className="wallet-connected" title={address}><span className="wallet-glyph">⌁</span>Eternl · {address.slice(0, 9)}…{address.slice(-5)}</span>;

  return <span className="wallet-connect-wrap"><button type="button" className="wallet-button" onClick={() => void connect()} disabled={status === "connecting"}><span className="wallet-glyph">⌁</span>{status === "connecting" ? "Connecting…" : "Connect Eternl"}</button>{status === "error" && <span className="wallet-error">{error}</span>}</span>;
}
