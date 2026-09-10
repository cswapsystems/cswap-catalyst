"use client";

import { useWallet } from "./wallet-context";

export default function EternlWalletButton() {
  const { address, status, error, connect, disconnect } = useWallet();

  if (status === "connected") return <span className="wallet-connect-wrap"><button type="button" onClick={disconnect} aria-label="Disconnect Eternl wallet" className="wallet-connected" title={`${address} — click to disconnect`}><span className="wallet-glyph">⌁</span>Eternl · {address.slice(0, 9)}…{address.slice(-5)} · Disconnect</button></span>;

  return <span className="wallet-connect-wrap"><button type="button" className="wallet-button" onClick={() => void connect()} disabled={status === "connecting"}><span className="wallet-glyph">⌁</span>{status === "connecting" ? "Connecting…" : "Connect Eternl"}</button>{status === "error" && <span className="wallet-error">{error}</span>}</span>;
}
