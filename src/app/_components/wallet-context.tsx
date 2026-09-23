"use client";

import { createContext, ReactNode, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { createWalletSession, WALLET_STORAGE_KEY, type WalletSnapshot } from "@/lib/wallet-session";
import { createBrowserChainProvider } from "@/lib/browser-chain-provider";

type WalletContextValue = WalletSnapshot & {
  connect: () => Promise<LucidEvolution | null>;
  disconnect: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => createWalletSession({
    storage: () => window.localStorage,
    extension: () => window.cardano?.eternl,
    initialize: async (api) => {
      const tools = await import("@lucid-evolution/lucid");
      const lucid = await tools.Lucid(createBrowserChainProvider(tools), "Preprod");
      lucid.selectWallet.fromAPI(api);
      return { lucid, address: await lucid.wallet().address() };
    },
  }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getServerSnapshot);

  useEffect(() => {
    // Extensions can inject after hydration. Retry discovery briefly, without
    // opening a permission request or repeatedly reconnecting an existing wallet.
    let retries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const restore = () => {
      if (session.getSnapshot().status !== "idle") return;
      if (!window.cardano?.eternl && retries++ < 10) { timer = setTimeout(restore, 200); return; }
      void session.restore();
    };
    timer = setTimeout(restore, 0);
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || (event.key === WALLET_STORAGE_KEY && event.newValue !== "eternl")) session.cancel();
    };
    window.addEventListener("storage", storageChanged);
    return () => { clearTimeout(timer); window.removeEventListener("storage", storageChanged); session.cancel(); };
  }, [session]);

  return <WalletContext.Provider value={{ ...snapshot, connect: session.connect, disconnect: session.disconnect }}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside WalletProvider.");
  return context;
}
