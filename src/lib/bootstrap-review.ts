export type AssetClass = { policyId: string; assetName: string };

export type BootstrapReviewInput = {
  offer: {
    id: string;
    owner: string;
    ownerKey: string;
    factoryToken: AssetClass;
    fraction: AssetClass;
    fractionAmount: bigint;
    quote: AssetClass;
    quoteAmount: bigint;
    poolLovelace: bigint;
    ownerShareBps: bigint;
  };
  factory: { id: string; nextPoolId: bigint };
  deployment: { admin: string; factoryAddress: string; ammAddress: string; lpPolicyId: string; poolPolicyId: string };
  provider: { address: string; key: string };
  transaction: {
    inputs: string[];
    teamWalletInputs: string[];
    requiredSigners: string[];
    mint: Record<string, string>;
    withdrawals: number;
    certificates: number;
    pool: { address: string; assets: Record<string, string>; datum: { poolNft: AssetClass; assetA: AssetClass; assetB: AssetClass; lpToken: AssetClass; feeN: bigint; feeD: bigint; reserveA: bigint; reserveB: bigint; liquidity: bigint; poolLovelace: bigint } } | null;
    lpPaid: Record<string, bigint>;
  };
};

export type BootstrapReview = { ok: boolean; issues: string[]; poolName: string; ownerLp: bigint; providerLp: bigint };

export function assetUnit(asset: AssetClass) { return asset.policyId ? asset.policyId + asset.assetName : "lovelace"; }
export function poolName(id: bigint) { return id.toString(16).padStart(16, "0"); }
export function integerSqrt(value: bigint) { if (value < BigInt(0)) throw new Error("Negative square root."); if (value < BigInt(2)) return value; let current = value; let next = (current + BigInt(1)) / BigInt(2); while (next < current) { current = next; next = (current + value / current) / BigInt(2); } return current; }

function sameAsset(left: AssetClass, right: AssetClass) { return left.policyId === right.policyId && left.assetName === right.assetName; }
function sameAssets(left: Record<string, string>, right: Record<string, string>) {
  const leftEntries = Object.entries(left).filter(([, quantity]) => quantity !== "0").sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).filter(([, quantity]) => quantity !== "0").sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length && leftEntries.every(([unit, quantity], index) => unit === rightEntries[index][0] && quantity === rightEntries[index][1]);
}

export function reviewBootstrapPlan(input: BootstrapReviewInput): BootstrapReview {
  const { offer, factory, deployment, provider, transaction } = input;
  const issues: string[] = [];
  if (offer.fractionAmount <= BigInt(0) || offer.quoteAmount <= BigInt(0) || offer.poolLovelace < BigInt(2_000_000) || offer.ownerShareBps <= BigInt(0) || offer.ownerShareBps >= BigInt(10_000)) throw new Error("Invalid bootstrap offer amounts or LP split.");
  const name = poolName(factory.nextPoolId);
  const poolNft = { policyId: deployment.poolPolicyId, assetName: name };
  const lpToken = { policyId: deployment.lpPolicyId, assetName: name };
  const liquidity = integerSqrt(offer.quoteAmount * offer.fractionAmount);
  const ownerLp = liquidity * offer.ownerShareBps / BigInt(10_000);
  const providerLp = liquidity - ownerLp;
  if (ownerLp <= BigInt(0) || providerLp <= BigInt(0)) issues.push("Both parties must receive a positive LP allocation.");

  if (!transaction.inputs.includes(offer.id)) issues.push("The selected bootstrap offer is not an input.");
  if (!transaction.inputs.includes(factory.id)) issues.push("The current factory state is not an input.");
  if (transaction.teamWalletInputs.length) issues.push("The request spends a Team-wallet UTxO and must not be signed.");
  if (transaction.withdrawals || transaction.certificates) issues.push("Bootstrap requests must not include withdrawals or certificates.");
  if (provider.address === offer.owner || provider.key === offer.ownerKey || provider.key === deployment.admin) issues.push("The liquidity provider must be distinct from the FT provider and Team creator.");
  if (offer.ownerKey === deployment.admin) issues.push("The FT provider must be distinct from the Team creator.");
  if (!offer.fraction.policyId || sameAsset(offer.fraction, offer.quote) || (!offer.quote.policyId && offer.poolLovelace > offer.quoteAmount)) issues.push("Invalid asset pair or ADA reserve below the locked buffer.");
  if (transaction.requiredSigners.length !== 2 || !transaction.requiredSigners.includes(provider.key) || !transaction.requiredSigners.includes(deployment.admin)) issues.push("The request must require exactly the liquidity-provider and Team-creator signatures.");

  const expectedMint = { [assetUnit(poolNft)]: "1", [assetUnit(lpToken)]: liquidity.toString() };
  if (!sameAssets(transaction.mint, expectedMint)) issues.push("The request mints assets other than the expected pool NFT and LP supply.");

  const pool = transaction.pool;
  if (!pool) {
    issues.push("The request does not create the expected pool output.");
  } else {
    const expectedValue = offer.quote.policyId
      ? { lovelace: offer.poolLovelace.toString(), [assetUnit(offer.quote)]: offer.quoteAmount.toString(), [assetUnit(offer.fraction)]: offer.fractionAmount.toString(), [assetUnit(poolNft)]: "1" }
      : { lovelace: offer.quoteAmount.toString(), [assetUnit(offer.fraction)]: offer.fractionAmount.toString(), [assetUnit(poolNft)]: "1" };
    if (pool.address !== deployment.ammAddress) issues.push("The pool output is not at the configured AMM address.");
    if (!sameAssets(pool.assets, expectedValue)) issues.push("The pool output value does not match the agreed reserves.");
    if (!sameAsset(pool.datum.poolNft, poolNft) || !sameAsset(pool.datum.lpToken, lpToken) || !sameAsset(pool.datum.assetA, offer.quote) || !sameAsset(pool.datum.assetB, offer.fraction)) issues.push("The pool datum does not match the configured pair and identities.");
    if (pool.datum.feeN !== BigInt(997) || pool.datum.feeD !== BigInt(1_000) || pool.datum.reserveA !== offer.quoteAmount || pool.datum.reserveB !== offer.fractionAmount || pool.datum.liquidity !== liquidity || pool.datum.poolLovelace !== (offer.quote.policyId ? offer.poolLovelace : offer.quoteAmount)) issues.push("The pool datum does not match the agreed reserves, fee, or liquidity.");
  }
  if ((transaction.lpPaid[offer.owner] ?? BigInt(0)) < ownerLp || (transaction.lpPaid[provider.address] ?? BigInt(0)) < providerLp) issues.push("The LP allocation does not match the agreed split.");

  return { ok: issues.length === 0, issues, poolName: name, ownerLp, providerLp };
}

type Tools = typeof import("@lucid-evolution/lucid");
type Lucid = import("@lucid-evolution/lucid").LucidEvolution;
type Deployment = BootstrapReviewInput["deployment"] & { factoryToken: string; bootstrapOfferAddress?: string };

export async function reviewBootstrapTransaction(
  tools: Tools, lucid: Lucid, transaction: string, deployment: Deployment,
  decodeAddress: (value: unknown, tools: Tools) => string,
) {
  const { parseTransactionCbor } = await import("@lucid-evolution/tx-graph");
  const trace = parseTransactionCbor(transaction);
  const tx = lucid.fromTx(transaction).toTransaction();
  const body = tx.body();
  if (!tx.is_valid() || body.voting_procedures() || body.proposal_procedures() || body.donation() !== undefined || body.current_treasury_value() !== undefined || trace.withdrawals.length || trace.certificates.length || trace.referenceInputs.length) throw new Error("Unexpected governance, certificate, withdrawal, reference input, or invalid transaction flag.");
  const constr = (value: unknown, count: number) => {
    if (!(value instanceof tools.Constr) || value.index !== 0 || value.fields.length !== count) throw new Error("Malformed bootstrap datum.");
    return value.fields;
  };
  const asset = (value: unknown): AssetClass => {
    const fields = constr(value, 2);
    if (typeof fields[0] !== "string" || typeof fields[1] !== "string") throw new Error("Malformed asset.");
    return { policyId: fields[0], assetName: fields[1] };
  };
  const id = (value: { txHash: string; outputIndex: number }) => `${value.txHash}#${value.outputIndex}`;
  const refs = [...trace.inputs, ...trace.collateralInputs];
  const resolved = await lucid.utxosByOutRef(refs);
  if (refs.some((ref) => !resolved.some((utxo) => id(utxo) === id(ref)))) throw new Error("An input is spent or unavailable. Rebuild the request.");
  const inputs = trace.inputs.map((ref) => resolved.find((utxo) => id(utxo) === id(ref))!);
  const offers = inputs.filter((utxo) => utxo.address === deployment.bootstrapOfferAddress);
  if (offers.length !== 1 || !offers[0].datum) throw new Error("Expected exactly one live bootstrap offer.");
  const offerInput = offers[0];
  const fields = constr(tools.Data.from(offerInput.datum!), 9);
  if (typeof fields[1] !== "string" || ![4, 6, 7, 8].every((index) => typeof fields[index] === "bigint")) throw new Error("Malformed bootstrap offer terms.");
  const offer: BootstrapReviewInput["offer"] = { id: id(offerInput), owner: decodeAddress(fields[0], tools), ownerKey: fields[1], factoryToken: asset(fields[2]), fraction: asset(fields[3]), fractionAmount: fields[4] as bigint, quote: asset(fields[5]), quoteAmount: fields[6] as bigint, poolLovelace: fields[7] as bigint, ownerShareBps: fields[8] as bigint };
  if (assetUnit(offer.factoryToken) !== deployment.factoryToken) throw new Error("The offer belongs to another factory.");
  const expectedOfferValue = { lovelace: offer.poolLovelace.toString(), [assetUnit(offer.fraction)]: offer.fractionAmount.toString() };
  if (!sameAssets(Object.fromEntries(Object.entries(offerInput.assets).map(([unit, amount]) => [unit, amount.toString()])), expectedOfferValue)) throw new Error("Offer escrow does not match its datum.");
  const spend = trace.redeemers.find((r) => r.tag === "spend" && BigInt(r.index) === BigInt(trace.inputs.findIndex((ref) => id(ref) === offer.id)));
  if (!spend) throw new Error("Missing offer acceptance redeemer.");
  const acceptance = constr(tools.Data.from(spend.data), 2);
  if (typeof acceptance[1] !== "string") throw new Error("Malformed provider key.");
  const provider = { address: decodeAddress(acceptance[0], tools), key: acceptance[1] };
  const keyOf = (address: string) => {
    const details = tools.getAddressDetails(address);
    if (details.networkId !== 0 || details.paymentCredential?.type !== "Key") throw new Error("Expected a Preprod payment-key address.");
    return details.paymentCredential.hash;
  };
  if (keyOf(provider.address) !== provider.key || keyOf(offer.owner) !== offer.ownerKey) throw new Error("Participant address/key mismatch.");
  const factory = await lucid.utxoByUnit(deployment.factoryToken);
  if (!factory.datum || factory.address !== deployment.factoryAddress || factory.assets[deployment.factoryToken] !== BigInt(1)) throw new Error("Factory identity mismatch.");
  const before = constr(tools.Data.from(factory.datum), 5);
  if (assetUnit(asset(before[0])) !== deployment.factoryToken || before[1] !== deployment.admin || before[2] !== deployment.poolPolicyId || typeof before[3] !== "bigint" || constr(before[4], 0).length !== 0) throw new Error("Factory is paused or its configuration is invalid.");
  const factoryOutputs = trace.outputs.filter((out) => out.assets[deployment.factoryToken] === "1");
  const expectedAfter = tools.Data.to(new tools.Constr(0, [before[0], before[1], before[2], before[3] + BigInt(1), before[4]]));
  if (factoryOutputs.length !== 1 || factoryOutputs[0].address !== deployment.factoryAddress || factoryOutputs[0].datum !== expectedAfter || !sameAssets(factoryOutputs[0].assets, Object.fromEntries(Object.entries(factory.assets).map(([unit, amount]) => [unit, amount.toString()])))) throw new Error("Factory continuation must preserve its configuration and value and advance by one.");
  const factorySpend = trace.redeemers.find((r) => r.tag === "spend" && BigInt(r.index) === BigInt(trace.inputs.findIndex((ref) => id(ref) === id(factory))));
  if (!factorySpend || factorySpend.data !== tools.Data.to(new tools.Constr(1, [])) || trace.redeemers.length !== 4 || trace.redeemers.filter((r) => r.tag === "mint").length !== 2) throw new Error("Unexpected bootstrap redeemers.");
  for (const input of inputs) {
    if (id(input) !== offer.id && id(input) !== id(factory) && keyOf(input.address) !== provider.key) throw new Error("Only the provider may fund this request; Team-wallet or unrelated inputs are forbidden.");
  }
  for (const ref of trace.collateralInputs) {
    if (keyOf(resolved.find((utxo) => id(utxo) === id(ref))!.address) !== provider.key) throw new Error("Only the provider may supply collateral.");
  }
  if (trace.collateralReturn && keyOf(trace.collateralReturn.address) !== provider.key) throw new Error("Collateral return must belong to the provider.");
  const name = poolName(before[3]);
  const poolOutputs = trace.outputs.filter((out) => out.assets[deployment.poolPolicyId + name] === "1");
  if (poolOutputs.length !== 1 || !poolOutputs[0].datum) throw new Error("Expected one pool output with inline datum.");
  const poolOutput = poolOutputs[0];
  const raw = constr(tools.Data.from(poolOutput.datum!), 10);
  if (!raw.slice(4).every((field) => typeof field === "bigint")) throw new Error("Malformed pool numbers.");
  for (const output of trace.outputs) {
    if (output.scriptRef || ![deployment.factoryAddress, deployment.ammAddress, offer.owner, provider.address].includes(output.address)) throw new Error("Unexpected output destination or reference script.");
  }
  const lpUnit = deployment.lpPolicyId + name;
  const lpPaid: Record<string, bigint> = {};
  for (const output of trace.outputs) lpPaid[output.address] = (lpPaid[output.address] ?? BigInt(0)) + BigInt(output.assets[lpUnit] ?? "0");
  const result = reviewBootstrapPlan({ offer, provider, deployment, factory: { id: id(factory), nextPoolId: before[3] }, transaction: {
    inputs: inputs.map(id), teamWalletInputs: [], requiredSigners: trace.requiredSigners, mint: trace.mint, withdrawals: trace.withdrawals.length, certificates: trace.certificates.length, lpPaid,
    pool: { address: poolOutput.address, assets: poolOutput.assets, datum: { poolNft: asset(raw[0]), assetA: asset(raw[1]), assetB: asset(raw[2]), lpToken: asset(raw[3]), feeN: raw[4] as bigint, feeD: raw[5] as bigint, reserveA: raw[6] as bigint, reserveB: raw[7] as bigint, liquidity: raw[8] as bigint, poolLovelace: raw[9] as bigint } },
  } });
  return { transaction, offer, provider, result, hash: trace.hash, fee: trace.fee };
}
