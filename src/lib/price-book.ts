export type AssetPrice = { unit: string; label: string; bid: string; ask: string; maxPerRequest: string; maxInventory: string; active: boolean };
export type PriceBook = { revision: number; entries: AssetPrice[]; updatedAt: string | null; updatedBy: string | null };
export type PriceUpdate = { domain: "cswap.instant-sell.v1"; network: "preprod"; poolToken: string; revision: number; issuedAt: number; entries: AssetPrice[] };

export function priceAda(lovelace: string): string {
  const amount = BigInt(lovelace);
  return `${amount / BigInt(1_000_000)}.${(amount % BigInt(1_000_000)).toString().padStart(6, "0")}`;
}

export function validatePrices(input: unknown): AssetPrice[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("A price book supports at most 100 assets.");
  const entries = input.map((raw): AssetPrice => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid asset price.");
    const { unit, label, bid, ask, maxPerRequest, maxInventory, active } = raw;
    if (typeof unit !== "string" || !/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) throw new Error("Use the exact policy ID and hexadecimal asset name.");
    if (typeof label !== "string" || label.length > 100 || typeof active !== "boolean") throw new Error("Invalid label or active setting.");
    for (const value of [bid, ask, maxPerRequest, maxInventory]) {
      if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error("Prices and limits must be positive integers (prices stored in lovelace).");
    }
    if (BigInt(maxPerRequest) > BigInt(maxInventory)) throw new Error("Request limit cannot exceed the inventory cap.");
    return { unit, label, bid, ask, maxPerRequest, maxInventory, active };
  }).sort((a, b) => a.unit.localeCompare(b.unit));
  if (new Set(entries.map((entry) => entry.unit)).size !== entries.length) throw new Error("Each exact asset may appear only once.");
  return entries;
}

export function priceUpdate(poolToken: string, revision: number, entries: unknown, issuedAt = Date.now()): PriceUpdate {
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(issuedAt)) throw new Error("Invalid price-book version.");
  return { domain: "cswap.instant-sell.v1", network: "preprod", poolToken, revision, issuedAt, entries: validatePrices(entries) };
}

export function instantSellQuote(book: PriceBook, unit: string, quantity: bigint, held: bigint) {
  const entry = book.entries.find((item) => item.unit === unit);
  if (!entry?.active) throw new Error("Instant Sell is not active for this asset.");
  if (quantity <= BigInt(0) || quantity > BigInt(entry.maxPerRequest)) throw new Error("Quantity exceeds the per-request limit of " + entry.maxPerRequest + " base units.");
  if (held < BigInt(0) || held + quantity > BigInt(entry.maxInventory)) throw new Error("This request would exceed the inventory cap of " + entry.maxInventory + " base units.");
  return { bid: BigInt(entry.bid) * quantity, ask: BigInt(entry.ask) * quantity, entry };
}

export async function fetchPriceBook(): Promise<{ book: PriceBook; operatorKey: string; storage: string }> {
  const response = await fetch("/api/price-book", { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Operator prices are unavailable.");
  return { ...body, book: { ...body.book, entries: validatePrices(body.book.entries) } };
}
