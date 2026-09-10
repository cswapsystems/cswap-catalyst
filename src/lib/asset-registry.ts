import type { LucidEvolution, Script, UTxO } from "@lucid-evolution/lucid";

type Tools = typeof import("@lucid-evolution/lucid");
export type RegistryState = { utxo: UTxO; version: bigint; entries: string[]; script: Script; address: string; issuer: string; token: string };
export const MAX_REGISTRY_ENTRIES = 50;
export const registryToken = process.env.NEXT_PUBLIC_ASSET_REGISTRY_TOKEN ?? "";
export const registryIssuer = process.env.NEXT_PUBLIC_ASSET_REGISTRY_ISSUER ?? "";
export const registryConfigured = Boolean(registryToken && registryIssuer);

export function normalizeUnit(value: string): string {
  const unit = value.trim().toLowerCase();
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) throw new Error("Enter a policy ID followed by the asset name in hex.");
  return unit;
}

export function checkRegistryNetwork() {
  if (process.env.NEXT_PUBLIC_CARDANO_NETWORK !== "preprod") throw new Error("The asset registry currently requires NEXT_PUBLIC_CARDANO_NETWORK=preprod.");
}

export async function registryBlueprint(): Promise<{ registry: string; identity: string }> {
  const response = await fetch("/api/registry-blueprint", { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || !body.registry || !body.identity) throw new Error(body.error ?? "Registry blueprint unavailable.");
  return body;
}

export function assetData(tools: Tools, unit: string) {
  return new tools.Constr(0, [unit.slice(0, 56), unit.slice(56)]);
}

export function registryDatum(tools: Tools, version: bigint, entries: string[]) {
  return tools.Data.to(new tools.Constr(0, [version, entries.map((unit) => assetData(tools, unit))]));
}

export function decodeRegistryDatum(tools: Tools, raw: string): { version: bigint; entries: string[] } {
  const root = tools.Data.from(raw);
  if (!(root instanceof tools.Constr) || root.index !== 0 || root.fields.length !== 2) throw new Error("Invalid registry datum.");
  const [version, values] = root.fields;
  if (typeof version !== "bigint" || version < BigInt(0) || !Array.isArray(values) || values.length > MAX_REGISTRY_ENTRIES) throw new Error("Invalid registry state.");
  const entries = values.map((value) => {
    if (!(value instanceof tools.Constr) || value.index !== 0 || value.fields.length !== 2) throw new Error("Invalid registry entry.");
    const [policy, name] = value.fields;
    if (typeof policy !== "string" || policy.length !== 56 || typeof name !== "string") throw new Error("Invalid registry asset.");
    return normalizeUnit(policy + name);
  });
  if (new Set(entries).size !== entries.length) throw new Error("Duplicate registry entries.");
  return { version, entries };
}

export function registryScript(tools: Tools, code: string, token: string, issuer: string): Script {
  normalizeUnit(token);
  if (!/^[0-9a-f]{56}$/.test(issuer)) throw new Error("Invalid registry issuer key hash.");
  return { type: "PlutusV3", script: tools.applyParamsToScript(code, [assetData(tools, token), issuer]) };
}

export async function registryReader(): Promise<LucidEvolution> {
  checkRegistryNetwork();
  const tools = await import("@lucid-evolution/lucid");
  return tools.Lucid(new tools.Blockfrost("/api/blockfrost", ""), "Preprod");
}

export async function readRegistry(lucid?: LucidEvolution): Promise<RegistryState> {
  checkRegistryNetwork();
  if (!registryConfigured) throw new Error("Asset registry is not configured.");
  const tools = await import("@lucid-evolution/lucid");
  const blueprint = await registryBlueprint();
  const script = registryScript(tools, blueprint.registry, registryToken, registryIssuer);
  const address = tools.validatorToAddress("Preprod", script);
  const provider = lucid ?? await registryReader();
  const utxo = await provider.utxoByUnit(registryToken);
  if (!utxo || utxo.address !== address || utxo.assets[registryToken] !== BigInt(1) || !utxo.datum) throw new Error("Authenticated registry state was not found at its expected script address.");
  return { ...decodeRegistryDatum(tools, utxo.datum), utxo, address, script, token: registryToken, issuer: registryIssuer };
}

// The transaction's consumed inputs supply candidate parameters for our one-shot policy.
// Metadata and an asset's current holder do not establish minting provenance.
export async function verifyOriginalMint(unit: string): Promise<void> {
  checkRegistryNetwork();
  unit = normalizeUnit(unit);
  const get = async (url: string) => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to verify the original mint on-chain.");
    return response.json();
  };
  const details = await get(`/api/blockfrost/assets/${unit}`);
  if (details.asset !== unit || !/^[0-9a-f]{64}$/.test(details.initial_mint_tx_hash ?? "")) throw new Error("No confirmed mint found for this asset.");
  const [transaction, blueprint, tools] = await Promise.all([
    get(`/api/blockfrost/txs/${details.initial_mint_tx_hash}/utxos`),
    get("/api/minter-blueprint"),
    import("@lucid-evolution/lucid"),
  ]);
  if (!Array.isArray(transaction.inputs) || typeof blueprint.compiledCode !== "string") throw new Error("Mint verification data is incomplete.");
  const matches = transaction.inputs.some((input: { tx_hash?: string; output_index?: number; reference?: boolean; collateral?: boolean }) => {
    if (input.reference || input.collateral || !/^[0-9a-f]{64}$/.test(input.tx_hash ?? "") || !Number.isSafeInteger(input.output_index) || input.output_index! < 0) return false;
    const script = tools.applyParamsToScript(blueprint.compiledCode, [new tools.Constr(0, [input.tx_hash!, BigInt(input.output_index!)])]);
    return tools.mintingPolicyToId({ type: "PlutusV3", script }) === unit.slice(0, 56);
  });
  if (!matches) throw new Error("This asset was not minted with the supported CSWAP NFT policy.");
}
