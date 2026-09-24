// Endpoints used by src/ directly and by the @lucid-evolution/provider Blockfrost class. ":id" is one bech32/hex identifier.
const GET_ROUTES = [
  "epochs/latest/parameters",
  "network",
  "accounts/:id",
  "addresses/:id/utxos",
  "addresses/:id/utxos/:id",
  "addresses/:id/transactions",
  "assets/:id",
  "assets/:id/addresses",
  "assets/:id/metadata",
  "scripts/:id",
  "scripts/:id/cbor",
  "scripts/:id/json",
  "scripts/datum/:id/cbor",
  "txs/:id",
  "txs/:id/cbor",
  "txs/:id/utxos",
  "txs/:id/metadata",
  "txs/:id/mints",
  "txs/:id/redeemers",
].map((route) => route.split("/"));

// Submit carries raw CBOR (protocol max tx size is 16 KiB). Evaluate carries hex CBOR plus
// JSON-encoded additional UTxOs that may embed reference scripts, so it gets more headroom.
export const BLOCKFROST_POST_LIMITS: Record<string, number> = {
  "tx/submit": 64 * 1024,
  "utils/txs/evaluate": 256 * 1024,
  "utils/txs/evaluate/utxos": 256 * 1024,
};

const QUERY_KEYS = new Set(["page", "count", "order"]);
const IDENTIFIER = /^[A-Za-z0-9_]{1,256}$/;

export function isSafeBlockfrostPath(path: readonly string[]): boolean {
  return path.length > 0 && path.every((segment) => IDENTIFIER.test(segment));
}

export function isAllowedBlockfrostRequest(method: string, path: readonly string[]): boolean {
  if (!isSafeBlockfrostPath(path)) return false;
  if (method === "POST") return Object.hasOwn(BLOCKFROST_POST_LIMITS, path.join("/"));
  if (method !== "GET") return false;
  return GET_ROUTES.some((route) => route.length === path.length && route.every((part, index) => part === ":id" || part === path[index]));
}

export function blockfrostPostLimit(path: readonly string[]): number {
  const key = path.join("/");
  return Object.hasOwn(BLOCKFROST_POST_LIMITS, key) ? BLOCKFROST_POST_LIMITS[key] : 0;
}

export function blockfrostQuery(search: URLSearchParams): string {
  const allowed = new URLSearchParams();
  for (const [key, value] of search) if (QUERY_KEYS.has(key) && /^[A-Za-z0-9]{1,16}$/.test(value)) allowed.append(key, value);
  const query = allowed.toString();
  return query ? `?${query}` : "";
}
