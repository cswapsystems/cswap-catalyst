"use client";

import { createContext, ReactNode, useCallback, useContext, useState } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";

type WalletStatus = "idle" | "connecting" | "connected" | "error";

type WalletContextValue = {
  address: string;
  lucid: LucidEvolution | null;
  status: WalletStatus;
  error: string;
  connect: () => Promise<void>;
  registerAddress: (address: string) => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState("");
  const [lucid, setLucid] = useState<LucidEvolution | null>(null);
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [error, setError] = useState("");

  const registerAddress = useCallback((nextAddress: string) => {
    setAddress(nextAddress);
    setStatus("connected");
    setError("");
  }, []);

  const connect = useCallback(async () => {
    if (!window.cardano?.eternl) {
      setStatus("error");
      setError("Install Eternl and switch it to Preprod.");
      return;
    }

    setStatus("connecting");
    setError("");
    try {
      const api = await window.cardano.eternl.enable();
      const { Blockfrost, Lucid } = await import("@lucid-evolution/lucid");
      const lucid = await Lucid(new Blockfrost("/api/blockfrost", ""), "Preprod");
      lucid.selectWallet.fromAPI(api);
      setLucid(lucid);
      if (await api.getNetworkId() !== 0) throw new Error("Eternl must be set to Cardano Preprod.");
      registerAddress(await lucid.wallet().address());
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Eternl connection was declined.");
    }
  }, [registerAddress]);

  return <WalletContext.Provider value={{ address, lucid, status, error, connect, registerAddress }}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside WalletProvider.");
  return context;
}
