import { readFile, writeFile, rename, access } from "node:fs/promises";
import { Blockfrost } from "@lucid-evolution/provider";
import { AddressSchema, Constr, Data, Lucid, applyParamsToScript, fromText, getAddressDetails, mintingPolicyToId, validatorToAddress } from "@lucid-evolution/lucid";

const NETWORK = "Preprod";
const API = "https://cardano-preprod.blockfrost.io/api/v0";
const DEPLOYMENT_FILE = new URL("../dex-deployment.preprod.json", import.meta.url);
const PENDING_FILE = new URL("../dex-deployment.preprod.pending.json", import.meta.url);

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; }));
}
function asset(policyId, assetName = "") { return { policyId, assetName }; }
function assetData(value) { return new Constr(0, [value.policyId, value.assetName]); }
function unit(value) { return value.policyId ? value.policyId + value.assetName : "lovelace"; }
function poolName(id) { return BigInt(id).toString(16).padStart(16, "0"); }
function integerSqrt(value) { if (value < 0n) throw new Error("Negative square root."); if (value < 2n) return value; let x = value; let y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + value / x) / 2n; } return x; }
function gcd(a, b) { while (b !== 0n) { const next = a % b; a = b; b = next; } return a; }
function addressData(address) {
  const details = getAddressDetails(address);
  if (!details.paymentCredential) throw new Error("Address has no payment credential.");
  const credential = (item) => item.type === "Key" ? { PubKeyCredential: [item.hash] } : { ScriptCredential: [item.hash] };
  return Data.from(Data.to({ addressCredential: credential(details.paymentCredential), addressStakingCredential: details.stakeCredential ? { StakingHash: [credential(details.stakeCredential)] } : null }, AddressSchema));
}
async function blueprint() {
  const raw = JSON.parse(await readFile(new URL("../contracts/dex/plutus.json", import.meta.url), "utf8"));
  return Object.fromEntries(raw.validators.map((validator) => [validator.title, validator.compiledCode]));
}
async function context() {
  const env = parseEnv(await readFile(new URL("../.env.local", import.meta.url), "utf8"));
  if (!env.CARDANO_WALLET_SEED || !env.BLOCKFROST_PROJECT_ID) throw new Error("CARDANO_WALLET_SEED and BLOCKFROST_PROJECT_ID are required.");
  const lucid = await Lucid(new Blockfrost(API, env.BLOCKFROST_PROJECT_ID), NETWORK);
  lucid.selectWallet.fromSeed(env.CARDANO_WALLET_SEED);
  const walletAddress = await lucid.wallet().address();
  const admin = getAddressDetails(walletAddress).paymentCredential;
  if (!admin || admin.type !== "Key") throw new Error("Admin wallet requires a key payment credential.");
  return { lucid, walletAddress, admin: admin.hash, code: await blueprint() };
}
function scripts(code, admin, factoryToken) {
  const bootstrapOffer = { type: "PlutusV3", script: code["bootstrap_offer.bootstrap_offer.spend"] };
  const bootstrapOfferAddress = validatorToAddress(NETWORK, bootstrapOffer);
  const factoryState = { type: "PlutusV3", script: applyParamsToScript(code["factory_state.factory_state.spend"], [admin, addressData(bootstrapOfferAddress)]) };
  const factoryAddress = validatorToAddress(NETWORK, factoryState);
  if (!factoryToken) return { factoryState, factoryAddress, bootstrapOffer, bootstrapOfferAddress };
  const amm = { type: "PlutusV3", script: applyParamsToScript(code["amm_pool.amm_pool.spend"], [assetData(factoryToken)]) };
  const ammAddress = validatorToAddress(NETWORK, amm);
  const lp = { type: "PlutusV3", script: applyParamsToScript(code["lp_policy.lp_policy.mint"], [assetData(factoryToken), addressData(ammAddress)]) };
  const lpPolicyId = mintingPolicyToId(lp);
  const poolFactory = { type: "PlutusV3", script: applyParamsToScript(code["pool_factory.pool_factory.mint"], [assetData(factoryToken), addressData(ammAddress), lpPolicyId]) };
  return { factoryState, factoryAddress, bootstrapOffer, bootstrapOfferAddress, amm, ammAddress, lp, lpPolicyId, poolFactory, poolPolicyId: mintingPolicyToId(poolFactory) };
}
async function deploy(replace = false) {
  if (await access(PENDING_FILE).then(() => true, () => false)) throw new Error("A pending deployment exists. Run confirm-deployment before attempting another deployment; if never submitted, inspect the pending transaction before removing its record.");
  const existing = await readFile(DEPLOYMENT_FILE, "utf8").then(JSON.parse).catch(() => null);
  if (existing?.factoryToken && !replace) throw new Error("A DEX deployment record already exists; verify it instead of creating a second factory. Use redeploy only for a validator migration.");
  const { lucid, walletAddress, admin, code } = await context();
  const state = scripts(code, admin);
  const utxos = await lucid.wallet().getUtxos();
  const seed = utxos.find((utxo) => Object.keys(utxo.assets).length === 1 && utxo.assets.lovelace >= 20_000_000n);
  if (!seed) throw new Error("An ADA-only UTxO containing at least 20 tADA is required.");
  const tokenName = fromText("CSWAP_DEX_FACTORY");
  const bootstrap = { type: "PlutusV3", script: applyParamsToScript(code["factory_bootstrap.factory_bootstrap.mint"], [new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]), addressData(state.factoryAddress), tokenName]) };
  const factoryToken = asset(mintingPolicyToId(bootstrap), tokenName);
  const derived = scripts(code, admin, factoryToken);
  const datum = new Constr(0, [assetData(factoryToken), admin, derived.poolPolicyId, 0n, new Constr(0, [])]);
  const deployment = { network: "preprod", admin, factoryToken: unit(factoryToken), factoryAddress: derived.factoryAddress, ammAddress: derived.ammAddress, lpPolicyId: derived.lpPolicyId, poolPolicyId: derived.poolPolicyId, bootstrapOfferAddress: derived.bootstrapOfferAddress, transaction: null, ...(replace && existing ? { supersedes: existing } : {}) };
  console.log("Building factory bootstrap transaction...");
  const tx = await lucid.newTx().collectFrom([seed]).mintAssets({ [unit(factoryToken)]: 1n }, Data.to(new Constr(0, []))).attach.MintingPolicy(bootstrap).pay.ToContract(derived.factoryAddress, { kind: "inline", value: Data.to(datum) }, { lovelace: 5_000_000n, [unit(factoryToken)]: 1n }).addSigner(walletAddress).complete();
  console.log("Signing and submitting factory bootstrap transaction...");
  deployment.transaction = tx.toHash();
  await writeFile(PENDING_FILE, JSON.stringify(deployment, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(`Prepared deployment: ${deployment.transaction}. Recovery record: dex-deployment.preprod.pending.json`);
  const hash = await (await tx.sign.withWallet().complete()).submit();
  console.log(`Submitted: ${hash}`);
  const confirmed = await lucid.awaitTxConfirmation(hash, { timeout: 120_000, checkInterval: 3_000 });
  if (!confirmed) throw new Error(`Factory bootstrap was submitted but not confirmed: ${hash}`);
  await rename(PENDING_FILE, DEPLOYMENT_FILE);
  console.log(JSON.stringify(deployment, null, 2));
}
async function confirmDeployment() {
  const deployment = JSON.parse(await readFile(PENDING_FILE, "utf8"));
  const { lucid, admin } = await context();
  if (deployment.network !== "preprod" || deployment.admin !== admin || !deployment.transaction) throw new Error("Pending deployment does not match the configured Preprod admin.");
  if (!await lucid.awaitTxConfirmation(deployment.transaction, { timeout: 120_000, checkInterval: 3_000 })) throw new Error("Pending deployment is not confirmed; do not deploy again until its status is resolved.");
  const state = await lucid.utxoByUnit(deployment.factoryToken);
  if (state.address !== deployment.factoryAddress || state.assets[deployment.factoryToken] !== 1n) throw new Error("Pending factory identity mismatch.");
  await rename(PENDING_FILE, DEPLOYMENT_FILE);
  console.log(`Deployment confirmed and published: ${deployment.transaction}`);
}
async function status() {
  const { lucid, walletAddress } = await context();
  const utxos = await lucid.wallet().getUtxos();
  const totals = {};
  for (const utxo of utxos) for (const [key, quantity] of Object.entries(utxo.assets)) totals[key] = (totals[key] ?? 0n) + quantity;
  console.log(JSON.stringify({ walletAddress, utxos: utxos.length, adaOnly: utxos.filter((utxo) => Object.keys(utxo.assets).length === 1).map((utxo) => ({ outputReference: `${utxo.txHash}#${utxo.outputIndex}`, lovelace: utxo.assets.lovelace.toString() })), assets: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()])) }, null, 2));
}
async function deploymentContext() {
  const base = await context();
  const deployment = JSON.parse(await readFile(DEPLOYMENT_FILE, "utf8"));
  const factoryToken = asset(deployment.factoryToken.slice(0, 56), deployment.factoryToken.slice(56));
  return { ...base, deployment, factoryToken, derived: scripts(base.code, base.admin, factoryToken) };
}
async function verifyDeployment() {
  const ctx = await deploymentContext();
  const { deployment, derived, lucid, admin } = ctx;
  if (deployment.network !== "preprod" || deployment.admin !== admin || deployment.bootstrapOfferAddress !== derived.bootstrapOfferAddress || deployment.factoryAddress !== derived.factoryAddress || deployment.ammAddress !== derived.ammAddress || deployment.lpPolicyId !== derived.lpPolicyId || deployment.poolPolicyId !== derived.poolPolicyId) throw new Error("Deployment manifest does not match the compiled validators and configured Team key.");
  const state = await lucid.utxoByUnit(deployment.factoryToken);
  if (state.address !== deployment.factoryAddress || state.assets[deployment.factoryToken] !== 1n || !state.datum) throw new Error("Factory NFT is missing or at the wrong address.");
  const datum = Data.from(state.datum);
  if (!(datum instanceof Constr) || datum.index !== 0 || datum.fields.length !== 5 || unit({ policyId: datum.fields[0].fields[0], assetName: datum.fields[0].fields[1] }) !== deployment.factoryToken || datum.fields[1] !== admin || datum.fields[2] !== deployment.poolPolicyId || !(datum.fields[4] instanceof Constr) || datum.fields[4].index !== 0) throw new Error("Factory datum does not match the deployment manifest or is paused.");
  console.log(JSON.stringify({ verified: true, transaction: deployment.transaction, factoryOutput: `${state.txHash}#${state.outputIndex}`, factoryAddress: deployment.factoryAddress, bootstrapOfferAddress: deployment.bootstrapOfferAddress, ammAddress: deployment.ammAddress, nextPoolId: datum.fields[3].toString() }, null, 2));
}
async function inspectCurrentDeployment() {
  const { lucid } = await context();
  const deployment = JSON.parse(await readFile(DEPLOYMENT_FILE, "utf8"));
  const [factory, offers, pools] = await Promise.all([
    lucid.utxoByUnit(deployment.factoryToken),
    lucid.utxosAt(deployment.bootstrapOfferAddress),
    lucid.utxosAt(deployment.ammAddress),
  ]);
  console.log(JSON.stringify({ transaction: deployment.transaction, factoryOutput: `${factory.txHash}#${factory.outputIndex}`, offers: offers.map((utxo) => `${utxo.txHash}#${utxo.outputIndex}`), pools: pools.map((utxo) => `${utxo.txHash}#${utxo.outputIndex}`) }, null, 2));
}
async function awaitTransaction(hash) {
  if (!hash) throw new Error("A transaction hash is required.");
  const { lucid } = await context();
  const confirmed = await lucid.awaitTx(hash);
  if (!confirmed) throw new Error(`Transaction was not confirmed: ${hash}`);
  console.log(`confirmed: ${hash}`);
}
async function createCollateral() {
  const ctx = await context();
  let builder = ctx.lucid.newTx();
  for (let index = 0; index < 5; index += 1) builder = builder.pay.ToAddress(ctx.walletAddress, { lovelace: 10_000_000n });
  const tx = await builder.complete();
  const hash = await (await tx.sign.withWallet().complete()).submit();
  const confirmed = await ctx.lucid.awaitTx(hash);
  if (!confirmed) throw new Error(`Collateral setup was submitted but not confirmed: ${hash}`);
  console.log(`collateral: ${hash}`);
}
function poolDatum(value) {
  if (!(value instanceof Constr) || value.fields.length !== 10) throw new Error("Invalid pool datum.");
  return { raw: value, poolNft: value.fields[0], assetA: value.fields[1], assetB: value.fields[2], lpToken: value.fields[3], feeN: value.fields[4], feeD: value.fields[5], reserveA: value.fields[6], reserveB: value.fields[7], liquidity: value.fields[8], lovelace: value.fields[9] };
}
async function currentPool(ctx, wantedUnit) {
  const pools = [];
  for (const utxo of await ctx.lucid.utxosAt(ctx.derived.ammAddress)) {
    if (!utxo.datum) continue;
    try { const decoded = poolDatum(Data.from(utxo.datum)); if (!wantedUnit || unit({ policyId: decoded.assetB.fields[0], assetName: decoded.assetB.fields[1] }) === wantedUnit) pools.push({ utxo, ...decoded }); } catch {}
  }
  if (pools.length !== 1) throw new Error(`Expected one matching pool, found ${pools.length}.`);
  return pools[0];
}
async function inspectPool(fractionUnit) {
  const ctx = await deploymentContext();
  const pool = await currentPool(ctx, fractionUnit);
  console.log(JSON.stringify({ outputReference: `${pool.utxo.txHash}#${pool.utxo.outputIndex}`, fractionUnit, reserveLovelace: pool.reserveA.toString(), reserveFractions: pool.reserveB.toString(), totalLiquidity: pool.liquidity.toString() }, null, 2));
}
function nextPoolRaw(pool, reserveA, reserveB, liquidity) {
  return new Constr(0, [pool.raw.fields[0], pool.raw.fields[1], pool.raw.fields[2], pool.raw.fields[3], pool.feeN, pool.feeD, reserveA, reserveB, liquidity, reserveA]);
}
async function submit(ctx, builder, label) {
  const completed = await builder.complete();
  const hash = await (await completed.sign.withWallet().complete()).submit();
  console.log(`${label}: ${hash}`);
  const confirmed = await ctx.lucid.awaitTx(hash);
  if (!confirmed) throw new Error(`${label} was submitted but not confirmed: ${hash}`);
  return hash;
}
async function createPool(fractionUnit, adaAmount, fractionAmount) {
  const ctx = await deploymentContext();
  const state = await ctx.lucid.utxoByUnit(ctx.deployment.factoryToken);
  if (!state.datum) throw new Error("Factory state datum is missing.");
  const before = Data.from(state.datum);
  if (!(before instanceof Constr) || before.fields.length !== 5) throw new Error("Invalid factory datum.");
  const id = before.fields[3];
  const name = poolName(id);
  const poolNft = asset(ctx.derived.poolPolicyId, name);
  const lpToken = asset(ctx.derived.lpPolicyId, name);
  const fraction = asset(fractionUnit.slice(0, 56), fractionUnit.slice(56));
  const reserveA = BigInt(adaAmount); const reserveB = BigInt(fractionAmount);
  const liquidity = integerSqrt(reserveA * reserveB);
  const afterFactory = new Constr(0, [before.fields[0], before.fields[1], before.fields[2], id + 1n, before.fields[4]]);
  const pool = new Constr(0, [assetData(poolNft), assetData(asset("")), assetData(fraction), assetData(lpToken), 997n, 1000n, reserveA, reserveB, liquidity, reserveA]);
  const builder = ctx.lucid.newTx().collectFrom([state], Data.to(new Constr(0, []))).mintAssets({ [unit(poolNft)]: 1n }, Data.to(new Constr(0, []))).mintAssets({ [unit(lpToken)]: liquidity }, Data.to(new Constr(0, [assetData(poolNft)]))).attach.SpendingValidator(ctx.derived.factoryState).attach.MintingPolicy(ctx.derived.poolFactory).attach.MintingPolicy(ctx.derived.lp).pay.ToContract(ctx.derived.factoryAddress, { kind: "inline", value: Data.to(afterFactory) }, { ...state.assets }).pay.ToContract(ctx.derived.ammAddress, { kind: "inline", value: Data.to(pool) }, { lovelace: reserveA, [fractionUnit]: reserveB, [unit(poolNft)]: 1n }).pay.ToAddress(ctx.walletAddress, { [unit(lpToken)]: liquidity }).addSigner(ctx.walletAddress);
  await submit(ctx, builder, "create-pool");
}
async function transition(action, fractionUnit, amount) {
  const ctx = await deploymentContext();
  const state = await ctx.lucid.utxoByUnit(ctx.deployment.factoryToken);
  const pool = await currentPool(ctx, fractionUnit);
  const poolNft = { policyId: pool.poolNft.fields[0], assetName: pool.poolNft.fields[1] };
  const lpToken = { policyId: pool.lpToken.fields[0], assetName: pool.lpToken.fields[1] };
  let a = pool.reserveA, b = pool.reserveB, liquidity = pool.liquidity;
  let redeemer; let mint = 0n; let lpRedeemer;
  if (action === "add") { const requestedA = BigInt(amount); const divisor = gcd(a, b); const ratioA = a / divisor; const ratioB = b / divisor; const multiplier = (requestedA + ratioA - 1n) / ratioA; const addA = ratioA * multiplier; const addB = ratioB * multiplier; mint = addA * liquidity / a; a += addA; b += addB; liquidity += mint; redeemer = new Constr(1, [mint]); lpRedeemer = new Constr(1, [assetData(poolNft)]); }
  else if (action === "swap") { const input = BigInt(amount); const output = input * pool.feeN * b / (a * pool.feeD + input * pool.feeN); if (output <= 0n) throw new Error("Swap output rounds to zero."); a += input; b -= output; redeemer = new Constr(0, [output]); }
  else if (action === "swap-b") { const input = BigInt(amount); const output = input * pool.feeN * a / (b * pool.feeD + input * pool.feeN); if (output <= 0n) throw new Error("Swap output rounds to zero."); b += input; a -= output; redeemer = new Constr(0, [output]); }
  else if (action === "remove") { const burn = BigInt(amount); const outA = burn * a / liquidity; const outB = burn * b / liquidity; a -= outA; b -= outB; liquidity -= burn; mint = -burn; redeemer = new Constr(2, [outA, outB]); lpRedeemer = new Constr(2, [assetData(poolNft)]); }
  else throw new Error("Unknown transition.");
  const next = nextPoolRaw(pool, a, b, liquidity);
  let builder = ctx.lucid.newTx().collectFrom([pool.utxo], Data.to(redeemer)).readFrom([state]).attach.SpendingValidator(ctx.derived.amm).pay.ToContract(ctx.derived.ammAddress, { kind: "inline", value: Data.to(next) }, { lovelace: a, [fractionUnit]: b, [unit(poolNft)]: 1n });
  if (mint !== 0n) builder = builder.mintAssets({ [unit(lpToken)]: mint }, Data.to(lpRedeemer)).attach.MintingPolicy(ctx.derived.lp);
  await submit(ctx, builder, action);
}
async function closePool(fractionUnit) {
  const ctx = await deploymentContext(); const state = await ctx.lucid.utxoByUnit(ctx.deployment.factoryToken); const pool = await currentPool(ctx, fractionUnit);
  const poolNft = { policyId: pool.poolNft.fields[0], assetName: pool.poolNft.fields[1] }; const lpToken = { policyId: pool.lpToken.fields[0], assetName: pool.lpToken.fields[1] };
  const builder = ctx.lucid.newTx().collectFrom([pool.utxo], Data.to(new Constr(3, [addressData(ctx.walletAddress)]))).readFrom([state]).mintAssets({ [unit(poolNft)]: -1n }, Data.to(new Constr(1, []))).mintAssets({ [unit(lpToken)]: -pool.liquidity }, Data.to(new Constr(3, [assetData(poolNft)]))).attach.SpendingValidator(ctx.derived.amm).attach.MintingPolicy(ctx.derived.poolFactory).attach.MintingPolicy(ctx.derived.lp).pay.ToAddress(ctx.walletAddress, { lovelace: pool.reserveA, [fractionUnit]: pool.reserveB }).addSigner(ctx.walletAddress);
  await submit(ctx, builder, "close-pool");
}
const command = process.argv[2] ?? "status";
if (command === "deploy") await deploy(); else if (command === "redeploy") await deploy(true); else if (command === "confirm-deployment") await confirmDeployment(); else if (command === "verify-deployment") await verifyDeployment(); else if (command === "inspect-current") await inspectCurrentDeployment(); else if (command === "await") await awaitTransaction(process.argv[3]); else if (command === "collateral") await createCollateral(); else if (command === "status") await status(); else if (command === "pool") await inspectPool(process.argv[3]); else if (command === "create") await createPool(process.argv[3], process.argv[4], process.argv[5]); else if (["add", "swap", "swap-b", "remove"].includes(command)) await transition(command, process.argv[3], process.argv[4]); else if (command === "close") await closePool(process.argv[3]); else throw new Error("Usage: npm run dex:preprod -- status|pool|deploy|redeploy|confirm-deployment|verify-deployment|inspect-current|await|collateral|create|add|swap|swap-b|remove|close");
