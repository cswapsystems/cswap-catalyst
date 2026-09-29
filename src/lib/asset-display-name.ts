const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "mainnet" ? "mainnet" : "preprod";
const prefix = `cswap.asset-name.${network}.v1.`;

export function metadataDisplayName(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>).name;
  const name = Array.isArray(raw) && raw.every((part) => typeof part === "string") ? raw.join("") : typeof raw === "string" ? raw : "";
  const trimmed = name.trim();
  return trimmed.length <= 120 && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) ? trimmed : "";
}

export function cachedAssetName(unit: string): string {
  if (typeof window === "undefined" || !/^[0-9a-f]{56,120}$/i.test(unit)) return "";
  try { return metadataDisplayName({ name: window.localStorage.getItem(prefix + unit.toLowerCase()) }); }
  catch { return ""; }
}

export function rememberAssetName(unit: string, metadata: unknown): string {
  const name = metadataDisplayName(metadata);
  if (name && typeof window !== "undefined" && /^[0-9a-f]{56,120}$/i.test(unit)) {
    try { window.localStorage.setItem(prefix + unit.toLowerCase(), name); } catch { /* Private browsing can disable storage. */ }
  }
  return name;
}

export async function loadAssetNames(units: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all([...new Set(units.filter((unit) => /^[0-9a-f]{56,120}$/i.test(unit)))].map(async (unit) => {
    const cached = cachedAssetName(unit);
    if (cached) { result[unit] = cached; return; }
    try {
      const response = await fetch("/api/blockfrost/assets/" + encodeURIComponent(unit));
      if (!response.ok) return;
      const asset = await response.json() as { onchain_metadata?: unknown };
      const name = rememberAssetName(unit, asset.onchain_metadata);
      if (name) result[unit] = name;
    } catch { /* Fall back to the token name when metadata is unavailable. */ }
  }));
  return result;
}

export function assetDisplayName(unit: string, fallback: string, names: Record<string, string>, originalUnit?: string): string {
  if (names[unit]) return names[unit];
  if (originalUnit && names[originalUnit]) return names[originalUnit] + " fractions";
  return fallback;
}
