import type { ProtocolParameters } from "@lucid-evolution/lucid";

type Tools = Pick<typeof import("@lucid-evolution/lucid"), "Blockfrost">;

export async function readProtocolParameters(url: string, request: typeof fetch = fetch): Promise<ProtocolParameters> {
  let response: Response;
  try {
    response = await request(`${url}/epochs/latest/parameters`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("Cannot reach the Preprod chain service. Please retry wallet connection shortly.");
  }
  // Never feed an error document into Lucid's unchecked BigInt conversions.
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403
      ? "The site's Blockfrost credentials were rejected. The operator must check the Preprod BLOCKFROST_PROJECT_ID and redeploy."
      : response.status === 429 || response.status === 402
        ? "The chain provider's request limit has been reached. Retry later or ask the operator to check its quota."
        : response.status === 404
          ? "The site's chain API endpoint is unavailable. The operator must check the Preprod deployment."
          : "The site's chain service is unavailable or not configured. Retry shortly; if it persists, the operator must check BLOCKFROST_PROJECT_ID and the server logs.";
    throw new Error(`Wallet connection could not load Preprod protocol parameters (HTTP ${response.status}). ${reason}`);
  }
  let raw: unknown;
  try { raw = await response.json(); }
  catch { throw new Error("The Preprod chain API returned an invalid response instead of protocol parameters. Check the site's API routing."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "error" in raw) throw new Error("The Preprod chain API returned an error instead of protocol parameters. The operator must check the chain service.");
  const data = raw as Record<string, unknown>;
  const invalid = (field: string): never => { throw new Error(`The Preprod chain API returned missing or invalid protocol parameter '${field}'. No wallet connection was established; retry or contact the operator.`); };
  const integer = (field: string) => {
    const value = data[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    return invalid(field);
  };
  const number = (field: string, whole = true) => {
    const value = data[field];
    if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return invalid(field);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || (whole && !Number.isSafeInteger(parsed))) return invalid(field);
    return parsed;
  };
  const models = data.cost_models_raw;
  if (!models || typeof models !== "object" || Array.isArray(models)) return invalid("cost_models_raw");
  for (const version of ["PlutusV1", "PlutusV2", "PlutusV3"]) {
    const values = (models as Record<string, unknown>)[version];
    if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "number" && Number.isSafeInteger(value))) return invalid(`cost_models_raw.${version}`);
  }
  return {
    protocolMajorVersion: number("protocol_major_ver"), protocolMinorVersion: number("protocol_minor_ver"),
    minFeeA: number("min_fee_a"), minFeeB: number("min_fee_b"), maxTxSize: number("max_tx_size"), maxValSize: number("max_val_size"),
    keyDeposit: integer("key_deposit"), poolDeposit: integer("pool_deposit"), drepDeposit: integer("drep_deposit"), govActionDeposit: integer("gov_action_deposit"),
    priceMem: number("price_mem", false), priceStep: number("price_step", false), maxTxExMem: integer("max_tx_ex_mem"), maxTxExSteps: integer("max_tx_ex_steps"),
    coinsPerUtxoByte: integer("coins_per_utxo_size"), collateralPercentage: number("collateral_percent"), maxCollateralInputs: number("max_collateral_inputs"),
    minFeeRefScriptCostPerByte: number("min_fee_ref_script_cost_per_byte", false), costModels: models as ProtocolParameters["costModels"],
  };
}

export function createBrowserChainProvider(tools: Tools, url = "/api/blockfrost", request: typeof fetch = fetch) {
  return new class extends tools.Blockfrost {
    override getProtocolParameters() { return readProtocolParameters(url, request); }
  }(url, "");
}
