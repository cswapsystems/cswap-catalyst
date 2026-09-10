import type { LucidEvolution, WalletApi } from "@lucid-evolution/lucid";

export const WALLET_STORAGE_KEY = "cswap.wallet.preprod";
export type WalletSnapshot = {
  address: string;
  lucid: LucidEvolution | null;
  status: "idle" | "connecting" | "connected" | "error";
  error: string;
};
const initialSnapshot: WalletSnapshot = { address: "", lucid: null, status: "idle", error: "" };

type Dependencies = {
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  extension: () => { isEnabled: () => Promise<boolean>; enable: () => Promise<WalletApi> } | undefined;
  initialize: (api: WalletApi) => Promise<{ address: string; lucid: LucidEvolution }>;
};

// Storage remembers a preference, never a wallet API or an authenticated address.
export function createWalletSession(dependencies: Dependencies) {
  let snapshot = initialSnapshot;
  let generation = 0;
  let pending: Promise<LucidEvolution | null> | null = null;
  const listeners = new Set<() => void>();
  function publish(next: WalletSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  function remember(connected: boolean) {
    try {
      const storage = dependencies.storage();
      if (connected) storage.setItem(WALLET_STORAGE_KEY, "eternl");
      else storage.removeItem(WALLET_STORAGE_KEY);
    } catch { /* Storage restrictions must not prevent a wallet connection. */ }
  }
  function remembered() {
    try { return dependencies.storage().getItem(WALLET_STORAGE_KEY) === "eternl"; }
    catch { return false; }
  }
  function connect(automatic = false): Promise<LucidEvolution | null> {
    if (pending) return pending;
    const attempt = ++generation;
    publish({ ...initialSnapshot, status: "connecting" });
    pending = Promise.resolve().then(async () => {
      try {
        if (attempt !== generation) return null;
        const extension = dependencies.extension();
        if (!extension) {
          if (automatic) { publish(initialSnapshot); return null; }
          throw new Error("Install Eternl and switch it to Preprod.");
        }
        if (automatic && !await extension.isEnabled()) {
          if (attempt !== generation) return null;
          remember(false);
          publish(initialSnapshot);
          return null;
        }
        if (attempt !== generation) return null;
        const api = await extension.enable();
        if (attempt !== generation) return null;
        if (await api.getNetworkId() !== 0) throw new Error("Eternl must be set to Cardano Preprod.");
        if (attempt !== generation) return null;
        const connection = await dependencies.initialize(api);
        if (attempt !== generation) return null;
        remember(true);
        publish({ ...connection, status: "connected", error: "" });
        return connection.lucid;
      } catch (cause) {
        if (attempt !== generation) return null;
        remember(false);
        publish({ ...initialSnapshot, status: "error", error: cause instanceof Error ? cause.message : "Eternl connection was declined." });
        return null;
      } finally {
        if (attempt === generation) pending = null;
      }
    });
    return pending;
  }
  function reset() {
    generation++;
    pending = null;
    publish(initialSnapshot);
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initialSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect: () => connect(),
    restore: () => remembered() ? connect(true) : Promise.resolve(null),
    disconnect() { reset(); remember(false); },
    cancel: reset,
  };
}
