import type { LucidEvolution, Script, UTxO } from "@lucid-evolution/lucid";

type Tools = typeof import("@lucid-evolution/lucid");
export type RegistryState = { utxo: UTxO; version: bigint; entries: string[]; script: Script; address: string; issuer: string; token: string };
export type RegistryRequest = { id: string; utxo: UTxO; requester: string; requesterKey: string; assets: string[]; lockedLovelace: bigint };
export type RegistryRequestState = { address: string; script: Script; requests: RegistryRequest[] };
export const MAX_REGISTRY_ENTRIES = 50;
export const REGISTRY_REQUEST_DEPOSIT = BigInt(3_000_000);
// Environment overrides keep emulator/test deployments possible; the fallback
// is the authenticated identity recorded in marketplace-deployment.preprod.json.
export const registryToken = process.env.NEXT_PUBLIC_ASSET_REGISTRY_TOKEN || "24a243c3a921e55b01f865c002505f1262b179ccc4e4fb3ef16e82d643535741505f5245474953545259";
export const registryIssuer = process.env.NEXT_PUBLIC_ASSET_REGISTRY_ISSUER || "6b88f592b89de5b5fac9359aa273184519ea23a538d776565c7220a1";
export const registryConfigured = Boolean(registryToken && registryIssuer);

export function normalizeUnit(value: string): string {
  const unit = value.trim().toLowerCase();
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) throw new Error("Enter a policy ID followed by the asset name in hex.");
  return unit;
}

export function checkRegistryNetwork() {
  if (process.env.NEXT_PUBLIC_CARDANO_NETWORK !== "preprod") throw new Error("The asset registry currently requires NEXT_PUBLIC_CARDANO_NETWORK=preprod.");
}

export async function registryBlueprint(): Promise<{ registry: string; identity: string; request?: string }> {
  const response = await fetch("/api/registry-blueprint", { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || !body.registry || !body.identity) throw new Error(body.error ?? "Registry blueprint unavailable.");
  return body;
}

export function assetData(tools: Tools, unit: string) {
  return new tools.Constr(0, [unit.slice(0, 56), unit.slice(56)]);
}

type DataConstr = { index: number; fields: unknown[] };

function asConstr(value: unknown, label: string): DataConstr {
  if (typeof value !== "object" || value === null || !("index" in value) || !("fields" in value)) throw new Error("Invalid " + label + ".");
  const candidate = value as { index: unknown; fields: unknown };
  if (typeof candidate.index !== "number" || !Array.isArray(candidate.fields)) throw new Error("Invalid " + label + ".");
  return { index: candidate.index, fields: candidate.fields };
}

export function addressData(tools: Tools, value: string) {
  const details = tools.getAddressDetails(value);
  if (!details?.paymentCredential) throw new Error("Address has no supported payment credential.");
  const credential = (item: { type: "Key" | "Script"; hash: string }) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
  return tools.Data.from(tools.Data.to({
    addressCredential: credential(details.paymentCredential),
    addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null,
  } as never, tools.AddressSchema as never));
}

export function addressFromData(tools: Tools, value: unknown): string {
  const root = asConstr(value, "requester address");
  if (root.index !== 0 || root.fields.length !== 2) throw new Error("Invalid requester address.");
  const credential = (raw: unknown, label: string) => {
    const item = asConstr(raw, label);
    if ((item.index !== 0 && item.index !== 1) || item.fields.length !== 1 || typeof item.fields[0] !== "string") throw new Error("Invalid " + label + ".");
    return { type: item.index === 0 ? "Key" as const : "Script" as const, hash: item.fields[0] };
  };
  const payment = credential(root.fields[0], "payment credential");
  if (root.fields[1] === null) return tools.credentialToAddress("Preprod", payment);
  const stake = asConstr(root.fields[1], "staking credential");
  if (stake.index !== 0 || stake.fields.length !== 1) throw new Error("Invalid staking credential.");
  return tools.credentialToAddress("Preprod", payment, credential(asConstr(stake.fields[0], "staking hash").fields[0], "staking hash credential"));
}

export function registryDatum(tools: Tools, version: bigint, entries: string[]) {
  return tools.Data.to(new tools.Constr(0, [version, entries.map((unit) => assetData(tools, unit))]));
}

export function registryRequestDatum(tools: Tools, requester: string, requesterKey: string, units: string[]) {
  if (!/^[0-9a-f]{56}$/.test(requesterKey)) throw new Error("Invalid requester key hash.");
  if (!units.length || units.length > MAX_REGISTRY_ENTRIES) throw new Error("Request between one and 50 asset IDs.");
  const assets = units.map(normalizeUnit);
  if (new Set(assets).size !== assets.length) throw new Error("Requested asset IDs must be unique.");
  return tools.Data.to(new tools.Constr(0, [addressData(tools, requester), requesterKey, assets.map((unit) => assetData(tools, unit))]));
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


export function decodeRegistryRequestDatum(tools: Tools, raw: string): Omit<RegistryRequest, "id" | "utxo" | "lockedLovelace"> {
  const root = asConstr(tools.Data.from(raw), "registry request datum");
  if (root.index !== 0 || root.fields.length !== 3 || typeof root.fields[1] !== "string" || !/^[0-9a-f]{56}$/.test(root.fields[1]) || !Array.isArray(root.fields[2])) throw new Error("Invalid registry request datum.");
  const assets = root.fields[2].map((value) => {
    const asset = asConstr(value, "requested asset");
    if (asset.index !== 0 || asset.fields.length !== 2 || typeof asset.fields[0] !== "string" || typeof asset.fields[1] !== "string") throw new Error("Invalid requested asset.");
    return normalizeUnit(asset.fields[0] + asset.fields[1]);
  });
  if (!assets.length || assets.length > MAX_REGISTRY_ENTRIES || new Set(assets).size !== assets.length) throw new Error("Invalid requested assets.");
  return { requester: addressFromData(tools, root.fields[0]), requesterKey: root.fields[1], assets };
}
export function registryScript(tools: Tools, code: string, token: string, issuer: string): Script {
  normalizeUnit(token);
  if (!/^[0-9a-f]{56}$/.test(issuer)) throw new Error("Invalid registry issuer key hash.");
  return { type: "PlutusV3", script: tools.applyParamsToScript(code, [assetData(tools, token), issuer]) };
}

export function registryRequestScript(tools: Tools, code: string, registry: Pick<RegistryState, "address" | "token" | "issuer">): Script {
  if (!code) throw new Error("Registry request validator unavailable. Build and redeploy the marketplace contracts.");
  return { type: "PlutusV3", script: tools.applyParamsToScript(code, [addressData(tools, registry.address), assetData(tools, registry.token), registry.issuer]) };
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


export async function readRegistryRequests(lucid: LucidEvolution, registry: RegistryState): Promise<RegistryRequestState> {
  checkRegistryNetwork();
  const tools = await import("@lucid-evolution/lucid");
  const blueprint = await registryBlueprint();
  const script = registryRequestScript(tools, blueprint.request ?? "", registry);
  const address = tools.validatorToAddress("Preprod", script);
  const requests: RegistryRequest[] = [];
  for (const utxo of await lucid.utxosAt(address)) {
    if (!utxo.datum || utxo.assets.lovelace < BigInt(2_000_000) || Object.keys(utxo.assets).some((unit) => unit !== "lovelace" && utxo.assets[unit] !== BigInt(0))) continue;
    try {
      requests.push({ id: utxo.txHash + "#" + utxo.outputIndex, utxo, lockedLovelace: utxo.assets.lovelace, ...decodeRegistryRequestDatum(tools, utxo.datum) });
    } catch {
      // Leave malformed/unrelated outputs untouched; the validator will reject them too.
    }
  }
  return { address, script, requests };
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
