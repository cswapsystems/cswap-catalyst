const addressKinds = new Set(["registry", "orderbook", "quote-pool", "vault", "dex-factory", "dex-pool"]);

export function parseWatchedAddresses(raw = process.env.WATCHED_ADDRESSES || "[]") {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WATCHED_ADDRESSES must be valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("WATCHED_ADDRESSES must be an array.");
  const seen = new Set();
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || !addressKinds.has(item.kind) || typeof item.address !== "string" || !item.address.startsWith("addr")) {
      throw new Error("Each watched address requires a supported kind and Cardano address.");
    }
    const key = `${item.kind}:${item.address}`;
    if (seen.has(key)) throw new Error(`Duplicate watched address: ${key}`);
    seen.add(key);
    return { kind: item.kind, address: item.address };
  });
}

export function requireEnvironment(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
