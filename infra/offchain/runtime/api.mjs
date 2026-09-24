import { createStore } from "./store.mjs";
import { requireEnvironment } from "./config.mjs";

const allowedKinds = new Set(["registry", "orderbook", "quote-pool", "vault", "dex-factory", "dex-pool"]);
const headers = { "content-type": "application/json", "cache-control": "public, max-age=5, stale-while-revalidate=25" };
function response(statusCode, body, extraHeaders = {}) { return { statusCode, headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) }; }
function publicItem(item) {
  if (!item) return item;
  const { PK, SK, GSI1PK, GSI1SK, ...value } = item;
  return value;
}
// "synced" = authenticated (possibly empty) registry; "failed" = serving the last good set; "unavailable" = never synced.
async function registryStatus(store) {
  const status = await store.get("REGISTRY#STATUS", "STATUS");
  return status ? publicItem(status) : { state: "unavailable" };
}
function encodeCursor(key) { return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null; }
function decodeCursor(raw) {
  if (!raw) return undefined;
  try { return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid pagination cursor."); }
}

export function createApiHandler({ store, network }) {
  return async function api(event) {
    try {
      const method = event.requestContext?.http?.method || event.httpMethod;
      const path = event.rawPath || event.path || "/";
      if (method !== "GET") return response(405, { error: "Method not allowed." }, { allow: "GET" });
      if (path === "/health") return response(200, { status: "ok", service: "cswap-offchain", network, time: new Date().toISOString() }, { "cache-control": "no-store" });
      if (path === "/v1/status") {
        const checkpoint = await store.get(`NETWORK#${network}`, "CHECKPOINT");
        return checkpoint ? response(200, publicItem(checkpoint), { "cache-control": "no-store" }) : response(503, { error: "Indexer has not completed its first sync.", network }, { "cache-control": "no-store" });
      }
      if (path === "/v1/registry/assets") {
        const [result, registry] = await Promise.all([store.queryPartition("REGISTRY#SUPPORTED"), registryStatus(store)]);
        return response(200, { network, registry, items: result.items.map(publicItem), count: result.items.length });
      }
      const assetMatch = path.match(/^\/v1\/registry\/assets\/([0-9a-fA-F]{56,120})$/);
      if (assetMatch) {
        const item = await store.get("REGISTRY#SUPPORTED", `ASSET#${assetMatch[1].toLowerCase()}`);
        return item ? response(200, publicItem(item)) : response(404, { error: "Asset is not in the supported registry.", registry: await registryStatus(store) });
      }
      const stateMatch = path.match(/^\/v1\/state\/([a-z-]+)$/);
      if (stateMatch && allowedKinds.has(stateMatch[1])) {
        const limit = Number(event.queryStringParameters?.limit || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return response(400, { error: "limit must be an integer from 1 to 100." });
        const result = await store.queryKind(stateMatch[1], { Limit: limit, ExclusiveStartKey: decodeCursor(event.queryStringParameters?.cursor) });
        return response(200, { network, items: result.items.map(publicItem), cursor: encodeCursor(result.cursor) });
      }
      return response(404, { error: "Route not found." });
    } catch (error) {
      console.error("API request failed", error);
      const clientError = error?.message === "Invalid pagination cursor.";
      return response(clientError ? 400 : 500, { error: clientError ? error.message : "Internal server error." }, { "cache-control": "no-store" });
    }
  };
}

let api;
export async function handler(event) {
  api ||= createApiHandler({ store: createStore(), network: requireEnvironment("CARDANO_NETWORK") });
  return api(event);
}
