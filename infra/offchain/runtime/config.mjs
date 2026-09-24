const addressKinds = new Set(["registry", "orderbook", "quote-pool", "vault", "dex-factory", "dex-pool"]);
const assetUnit = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;

export function parseWatchedAddresses(raw = process.env.WATCHED_ADDRESSES || "[]") {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WATCHED_ADDRESSES must be valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("WATCHED_ADDRESSES must be an array.");
  const seen = new Set();
  const watched = parsed.map((item) => {
    if (!item || typeof item !== "object" || !addressKinds.has(item.kind) || typeof item.address !== "string" || !item.address.startsWith("addr")) {
      throw new Error("Each watched address requires a supported kind and Cardano address.");
    }
    const key = `${item.kind}:${item.address}`;
    if (seen.has(key)) throw new Error(`Duplicate watched address: ${key}`);
    seen.add(key);
    if (item.kind !== "registry") return { kind: item.kind, address: item.address };
    // The registry identity NFT (manifest `registry.token`) authenticates the one output whose datum is trusted.
    const token = typeof item.token === "string" ? item.token.toLowerCase() : "";
    if (!assetUnit.test(token)) throw new Error("The registry watched address requires its identity token unit (policy ID + asset name hex).");
    return { kind: item.kind, address: item.address, token };
  });
  if (watched.filter((item) => item.kind === "registry").length > 1) throw new Error("Only one registry watched address is supported.");
  return watched;
}

export function requireEnvironment(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
