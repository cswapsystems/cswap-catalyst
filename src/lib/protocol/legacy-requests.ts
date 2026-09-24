import type { LucidEvolution, Script, UTxO } from "@lucid-evolution/lucid";
import { marketAddressData, marketAsset, marketUnit, outputRef } from "../marketplace";
import { decodeCardanoAddress } from "../address-codec";
type Tools = typeof import("@lucid-evolution/lucid");
export type LegacyRequest = { id: string; utxo: UTxO; seller: string; key: string; unit: string; quantity: bigint; script: Script };
export async function readLegacyRequests(lucid: LucidEvolution, tools: Tools, owner: string) {
  const response = await fetch("/api/marketplace-recovery", { cache: "no-store" });
  if (!response.ok) throw new Error("Legacy request recovery archive unavailable.");
  const archive = await response.json();
  const script: Script = { type: "PlutusV3", script: tools.applyParamsToScript(archive.requestCode, [marketAddressData(tools, archive.poolAddress)]) };
  const key = tools.getAddressDetails(owner).paymentCredential?.hash;
  const found: LegacyRequest[] = [];
  let skipped = 0;
  for (const utxo of await lucid.utxosAt(tools.validatorToAddress("Preprod", script))) {
    try {
      if (!utxo.datum) continue;
      const raw = tools.Data.from(utxo.datum);
      if (!(raw instanceof tools.Constr) || raw.index !== 0 || raw.fields.length !== 7 || raw.fields[1] !== key || typeof raw.fields[4] !== "bigint") continue;
      if (marketUnit(marketAsset(raw.fields[2])) !== archive.poolToken) continue;
      found.push({ id: outputRef(utxo), utxo, seller: decodeCardanoAddress(raw.fields[0], tools), key: raw.fields[1] as string, unit: marketUnit(marketAsset(raw.fields[3])), quantity: raw.fields[4], script });
    } catch { skipped++; }
  }
  return { requests: found, skipped };
}
