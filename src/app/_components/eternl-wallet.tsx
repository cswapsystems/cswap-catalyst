"use client";

import { useState } from "react";

type WalletState = "idle" | "connecting" | "connected" | "error";

export default function EternlWalletButton() {
  const [state, setState] = useState<WalletState>("idle");
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("");

  async function connect() {
    if (!window.cardano?.eternl) {
      setState("error");
      setMessage("Install Eternl and switch it to Preprod.");
      return;
    }

    setState("connecting");
    setMessage("");
    try {
      const api = await window.cardano.eternl.enable();
      const { Blockfrost, Lucid } = await import("@lucid-evolution/lucid");
      const lucid = await Lucid(new Blockfrost("/api/blockfrost", ""), "Preprod");
      lucid.selectWallet.fromAPI(api);
      const networkId = await api.getNetworkId();
      if (networkId !== 0) throw new Error("Eternl must be set to Cardano Preprod.");
      setAddress(await lucid.wallet().address());
      setState("connected");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Eternl connection was declined.");
    }
  }

  if (state === "connected") return <span className="wallet-connected" title={address}><span className="wallet-glyph">⌁</span>Eternl · {address.slice(0, 9)}…{address.slice(-5)}</span>;

  return <span className="wallet-connect-wrap"><button type="button" className="wallet-button" onClick={() => void connect()} disabled={state === "connecting"}><span className="wallet-glyph">⌁</span>{state === "connecting" ? "Connecting…" : "Connect Eternl"}</button>{state === "error" && <span className="wallet-error">{message}</span>}</span>;
}
