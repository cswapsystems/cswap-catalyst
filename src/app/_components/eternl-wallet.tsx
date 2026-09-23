"use client";

import { useWallet } from "./wallet-context";
import Link from "next/link";
import HeaderDisclosure from "./header-disclosure";

export default function EternlWalletButton() {
  const { address, status, error, connect, disconnect } = useWallet();

  if (status === "connected") return <HeaderDisclosure label={<><span className="wallet-status-dot" aria-hidden="true" /><span className="header-wallet-label">Wallet</span><span className="header-wallet-address">{address.slice(0, 9)}…{address.slice(-5)}</span></>}>
    <span className="header-menu-label">Connected with Eternl</span>
    <code className="header-wallet-full-address">{address}</code>
    <Link href="/wallet">Wallet details<small>Address and connection information</small></Link>
    <Link href="/history">Transaction activity</Link>
    <div className="header-menu-divider" />
    <button type="button" className="header-disconnect" onClick={disconnect}>Disconnect wallet</button>
  </HeaderDisclosure>;

  return <span className="wallet-connect-wrap"><button type="button" className="wallet-button" onClick={() => void connect()} disabled={status === "connecting"}><span className="wallet-glyph" aria-hidden="true">⌁</span>{status === "connecting" ? "Connecting…" : "Connect Eternl"}</button>{status === "error" && <span className="wallet-error" role="alert">{error}</span>}</span>;
}
