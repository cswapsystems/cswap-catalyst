export type PendingMarketTransaction = {
  version: 1;
  network: "preprod";
  wallet: string;
  operation: string;
  hash: string;
  submittedAt: number;
};

export const PENDING_MARKET_PREFIX = "cswap.pending-market.preprod.v1.";
export const PENDING_MARKET_EVENT = "cswap:pending-market-changed";

type PendingResult =
  | { kind: "empty" }
  | { kind: "pending"; transaction: PendingMarketTransaction }
  | { kind: "unavailable"; message: string };

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function pendingMarketKey(wallet: string) {
  if (!wallet) throw new Error("A connected wallet is required for transaction recovery.");
  return PENDING_MARKET_PREFIX + wallet;
}

export function readPendingMarket(storage: StorageReader, wallet: string): PendingResult {
  let raw: string | null;
  try { raw = storage.getItem(pendingMarketKey(wallet)); }
  catch { return { kind: "unavailable", message: "Local transaction recovery storage is unavailable. Enable browser storage before signing." }; }
  if (raw === null) return { kind: "empty" };
  try {
    const value = JSON.parse(raw) as PendingMarketTransaction;
    if (value?.version !== 1 || value.network !== "preprod" || value.wallet !== wallet || typeof value.operation !== "string" || !/^[a-zA-Z][a-zA-Z -]{0,79}$/.test(value.operation) || typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash) || !Number.isSafeInteger(value.submittedAt) || value.submittedAt <= 0) throw new Error("invalid");
    return { kind: "pending", transaction: value };
  } catch {
    return { kind: "unavailable", message: "A saved transaction record is invalid. Signing is blocked so a submitted transaction is not accidentally repeated. Preserve browser storage and contact support." };
  }
}

export function savePendingMarket(storage: StorageWriter, transaction: PendingMarketTransaction) {
  const current = readPendingMarket(storage, transaction.wallet);
  if (current.kind === "unavailable") throw new Error(current.message);
  if (current.kind === "pending" && current.transaction.hash !== transaction.hash) throw new Error("Another Marketplace transaction is awaiting confirmation. Check it before signing again.");
  storage.setItem(pendingMarketKey(transaction.wallet), JSON.stringify(transaction));
  const saved = readPendingMarket(storage, transaction.wallet);
  if (saved.kind !== "pending" || saved.transaction.hash !== transaction.hash) throw new Error("Transaction recovery record could not be verified.");
}

export function clearPendingMarket(storage: StorageWriter, wallet: string, hash: string) {
  const current = readPendingMarket(storage, wallet);
  if (current.kind === "unavailable") throw new Error(current.message);
  if (current.kind === "pending" && current.transaction.hash !== hash) throw new Error("A different transaction is now pending. Refresh before continuing.");
  if (current.kind === "pending") storage.removeItem(pendingMarketKey(wallet));
}
