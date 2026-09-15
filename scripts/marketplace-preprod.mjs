import { readFile, writeFile } from "node:fs/promises";
import { Blockfrost } from "@lucid-evolution/provider";
import { AddressSchema, Constr, Data, Lucid, applyParamsToScript, fromText, getAddressDetails, mintingPolicyToId, validatorToAddress } from "@lucid-evolution/lucid";

const NETWORK = "Preprod";
const API = "https://cardano-preprod.blockfrost.io/api/v0";
const DEPLOYMENT_FILE = new URL("../marketplace-deployment.preprod.json", import.meta.url);

function parseEnv(source) { return Object.fromEntries(source.split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; })); }
function asset(policyId, assetName = "") { return { policyId, assetName }; }
function unit(value) { return value.policyId ? value.policyId + value.assetName : "lovelace"; }
function assetData(value) { return new Constr(0, [value.policyId, value.assetName]); }
function addressData(address) {
  const details = getAddressDetails(address);
  if (!details.paymentCredential) throw new Error("Address has no payment credential.");
  const credential = (item) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
  return Data.from(Data.to({ addressCredential: credential(details.paymentCredential), addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null }, AddressSchema));
}
async function context() {
  const env = parseEnv(await readFile(new URL("../.env.local", import.meta.url), "utf8"));
  if (!env.CARDANO_WALLET_SEED || !env.BLOCKFROST_PROJECT_ID) throw new Error("CARDANO_WALLET_SEED and BLOCKFROST_PROJECT_ID are required.");
  const lucid = await Lucid(new Blockfrost(API, env.BLOCKFROST_PROJECT_ID), NETWORK);
  lucid.selectWallet.fromSeed(env.CARDANO_WALLET_SEED);
  const walletAddress = await lucid.wallet().address();
  const credential = getAddressDetails(walletAddress).paymentCredential;
  if (!credential || credential.type !== "Key") throw new Error("Team wallet requires a payment key.");
  const blueprint = JSON.parse(await readFile(new URL("../contracts/marketplace/plutus.json", import.meta.url), "utf8"));
  return { lucid, walletAddress, teamKey: credential.hash, code: Object.fromEntries(blueprint.validators.map((validator) => [validator.title, validator.compiledCode])) };
}
function scripts(ctx, deployment = {}) {
  const orderbook = { type: "PlutusV3", script: ctx.code["p2p_listing_simple.p2p_listing_simple.spend"] };
  const orderbookAddress = validatorToAddress(NETWORK, orderbook);
  const result = { orderbook, orderbookAddress };
  if (deployment.registry?.token) {
    const registryAsset = asset(deployment.registry.token.slice(0, 56), deployment.registry.token.slice(56));
    result.registry = { type: "PlutusV3", script: applyParamsToScript(ctx.code["asset_registry.asset_registry.spend"], [assetData(registryAsset), deployment.registry.issuer]) };
    result.registryAddress = validatorToAddress(NETWORK, result.registry);
  }
  if (deployment.pool?.token) {
    const poolToken = asset(deployment.pool.token.slice(0, 56), deployment.pool.token.slice(56));
    result.pool = { type: "PlutusV3", script: applyParamsToScript(ctx.code["quote_pool.quote_pool.spend"], [addressData(orderbookAddress)]) };
    result.poolAddress = validatorToAddress(NETWORK, result.pool);
    result.lp = { type: "PlutusV3", script: applyParamsToScript(ctx.code["lp_policy.lp_policy.mint"], [assetData(poolToken), deployment.pool.lpToken.slice(56)]) };
    result.inventory = { type: "PlutusV3", script: applyParamsToScript(ctx.code["inventory_policy.inventory_policy.mint"], [assetData(poolToken), deployment.pool.inventoryToken.slice(56), deployment.batcher]) };
  }
  return result;
}
async function submit(ctx, builder, label) {
  const hash = await (await (await builder.complete()).sign.withWallet().complete()).submit();
  console.log(`${label}: ${hash}`);
  if (!await ctx.lucid.awaitTx(hash)) throw new Error(`${label} was submitted but not confirmed: ${hash}`);
  return hash;
}
async function loadDeployment() { return readFile(DEPLOYMENT_FILE, "utf8").then(JSON.parse); }

async function deploy() {
  const existing = await readFile(DEPLOYMENT_FILE, "utf8").then(JSON.parse).catch(() => null);
  if (existing?.pool?.token || existing?.registry?.token) throw new Error("Marketplace deployment already exists.");
  const ctx = await context(); const base = scripts(ctx);
  const walletUtxos = await ctx.lucid.wallet().getUtxos();
  const adaOnly = walletUtxos.filter((utxo) => Object.keys(utxo.assets).length === 1);
  const registrySeed = adaOnly.find((utxo) => utxo.assets.lovelace >= 10_000_000n);
  const poolSeed = adaOnly.find((utxo) => utxo !== registrySeed && utxo.assets.lovelace >= 30_000_000n);
  if (!registrySeed || !poolSeed) throw new Error("Separate ADA-only UTxOs containing at least 10 and 30 tADA are required.");

  const registryName = fromText("CSWAP_REGISTRY");
  const registryIdentity = { type: "PlutusV3", script: applyParamsToScript(ctx.code["one_shot.one_shot.mint"], [new Constr(0, [registrySeed.txHash, BigInt(registrySeed.outputIndex)]), registryName]) };
  const registryToken = unit(asset(mintingPolicyToId(registryIdentity), registryName));
  const poolName = fromText("CSWAP_QUOTE_POOL"); const lpName = fromText("CSWAP_POOL_LP"); const inventoryName = fromText("CSWAP_INVENTORY");
  const poolIdentity = { type: "PlutusV3", script: applyParamsToScript(ctx.code["one_shot.one_shot.mint"], [new Constr(0, [poolSeed.txHash, BigInt(poolSeed.outputIndex)]), poolName]) };
  const poolToken = unit(asset(mintingPolicyToId(poolIdentity), poolName));
  const poolAsset = asset(poolToken.slice(0, 56), poolToken.slice(56));
  const poolScript = { type: "PlutusV3", script: applyParamsToScript(ctx.code["quote_pool.quote_pool.spend"], [addressData(base.orderbookAddress)]) };
  const poolAddress = validatorToAddress(NETWORK, poolScript);
  const lpPolicy = { type: "PlutusV3", script: applyParamsToScript(ctx.code["lp_policy.lp_policy.mint"], [assetData(poolAsset), lpName]) };
  const inventoryPolicy = { type: "PlutusV3", script: applyParamsToScript(ctx.code["inventory_policy.inventory_policy.mint"], [assetData(poolAsset), inventoryName, ctx.teamKey]) };
  const lpToken = mintingPolicyToId(lpPolicy) + lpName; const inventoryToken = mintingPolicyToId(inventoryPolicy) + inventoryName;
  const minCashReserve = 20_000_000n;
  const datum = new Constr(0, [ctx.teamKey, ctx.teamKey, assetData(poolAsset), assetData(asset(lpToken.slice(0, 56), lpToken.slice(56))), assetData(asset(inventoryToken.slice(0, 56), inventoryToken.slice(56))), assetData(asset("")), 0n, minCashReserve, new Constr(0, []), 0n]);
  const deployment = {
    network: "preprod", team: ctx.teamKey, batcher: ctx.teamKey, orderbookAddress: base.orderbookAddress,
    registry: { token: registryToken, issuer: ctx.teamKey, address: "", transaction: "" },
    pool: { token: poolToken, address: poolAddress, lpToken, inventoryToken, quoteUnit: "lovelace", minCashReserve: minCashReserve.toString(), transaction: "" },
  };
  const derived = scripts(ctx, deployment); deployment.registry.address = derived.registryAddress;
  const deploymentTx = ctx.lucid.newTx()
    .collectFrom([registrySeed, poolSeed])
    .mintAssets({ [registryToken]: 1n }, Data.to(new Constr(0, [])))
    .mintAssets({ [poolToken]: 1n }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy(registryIdentity)
    .attach.MintingPolicy(poolIdentity)
    .pay.ToContract(derived.registryAddress, { kind: "inline", value: Data.to(new Constr(0, [0n, []])) }, { lovelace: 5_000_000n, [registryToken]: 1n })
    .pay.ToContract(poolAddress, { kind: "inline", value: Data.to(datum) }, { lovelace: minCashReserve, [poolToken]: 1n });
  const deploymentHash = await submit(ctx, deploymentTx, "marketplace-deployment");
  deployment.registry.transaction = deploymentHash;
  deployment.pool.transaction = deploymentHash;
  await writeFile(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(deployment, null, 2));
}

function decodePool(raw) {
  const datum = Data.from(raw);
  if (!(datum instanceof Constr) || datum.fields.length !== 10) throw new Error("Invalid shared-pool datum.");
  return datum;
}
async function fund(amount) {
  const ctx = await context(); const deployment = await loadDeployment(); const derived = scripts(ctx, deployment);
  const poolUtxo = await ctx.lucid.utxoByUnit(deployment.pool.token); if (!poolUtxo.datum) throw new Error("Pool datum missing.");
  const before = decodePool(poolUtxo.datum); const reserve = BigInt(amount); const supply = before.fields[6]; const cash = poolUtxo.assets.lovelace;
  const minted = supply === 0n ? reserve : reserve * supply / cash; if (minted <= 0n) throw new Error("Deposit is too small.");
  const next = new Constr(0, [...before.fields.slice(0, 6), supply + minted, ...before.fields.slice(7)]);
  const builder = ctx.lucid.newTx().collectFrom([poolUtxo], Data.to(new Constr(0, [reserve, minted, addressData(ctx.walletAddress), ctx.teamKey, next]))).mintAssets({ [deployment.pool.lpToken]: minted }, Data.to(new Constr(0, []))).attach.SpendingValidator(derived.pool).attach.MintingPolicy(derived.lp).pay.ToContract(deployment.pool.address, { kind: "inline", value: Data.to(next) }, { ...poolUtxo.assets, lovelace: cash + reserve }).pay.ToAddress(ctx.walletAddress, { [deployment.pool.lpToken]: minted }).addSigner(ctx.walletAddress);
  const hash = await submit(ctx, builder, "fund-pool"); deployment.pool.fundingTransaction = hash; await writeFile(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n", "utf8");
}
async function register(assetUnit) {
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(assetUnit ?? "")) throw new Error("Valid exact asset unit required.");
  const ctx = await context(); const deployment = await loadDeployment(); const derived = scripts(ctx, deployment);
  const state = await ctx.lucid.utxoByUnit(deployment.registry.token); if (!state.datum) throw new Error("Registry datum missing.");
  const before = Data.from(state.datum); if (!(before instanceof Constr) || before.fields.length !== 2 || !Array.isArray(before.fields[1])) throw new Error("Invalid registry datum.");
  const item = asset(assetUnit.slice(0, 56), assetUnit.slice(56)); const next = new Constr(0, [before.fields[0] + 1n, [assetData(item), ...before.fields[1]]]);
  const builder = ctx.lucid.newTx().collectFrom([state], Data.to(new Constr(0, [assetData(item)]))).attach.SpendingValidator(derived.registry).pay.ToContract(deployment.registry.address, { kind: "inline", value: Data.to(next) }, { ...state.assets }).addSigner(ctx.walletAddress);
  const hash = await submit(ctx, builder, "register-asset"); deployment.registry.lastUpdateTransaction = hash; await writeFile(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n", "utf8");
}

async function status() {
  const ctx = await context(); const deployment = await loadDeployment();
  const [registry, pool] = await Promise.all([ctx.lucid.utxoByUnit(deployment.registry.token), ctx.lucid.utxoByUnit(deployment.pool.token)]);
  const registryState = registry.datum ? Data.from(registry.datum) : null;
  const poolState = pool.datum ? decodePool(pool.datum) : null;
  console.log(JSON.stringify({
    registry: { ref: `${registry.txHash}#${registry.outputIndex}`, version: registryState?.fields?.[0]?.toString(), entries: registryState?.fields?.[1]?.length },
    pool: { ref: `${pool.txHash}#${pool.outputIndex}`, lovelace: pool.assets.lovelace.toString(), lpSupply: poolState?.fields?.[6]?.toString(), inventoryValue: poolState?.fields?.[9]?.toString() },
  }, null, 2));
}

const command = process.argv[2];
if (command === "deploy") await deploy(); else if (command === "fund") await fund(process.argv[3]); else if (command === "register") await register(process.argv[3]); else if (command === "status") await status(); else throw new Error("Usage: node scripts/marketplace-preprod.mjs deploy|fund <amount>|register <asset-unit>|status");
