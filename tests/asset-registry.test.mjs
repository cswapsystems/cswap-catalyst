import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tools from "@lucid-evolution/lucid";

const blueprint = JSON.parse(await readFile(new URL("../contracts/marketplace/plutus.json", import.meta.url), "utf8"));
const code = (title) => blueprint.validators.find((v) => v.title === title).compiledCode;
const registryCode = code("asset_registry.asset_registry.spend");
const identityCode = code("one_shot.one_shot.mint");
const issuer = tools.generateEmulatorAccount({ lovelace: 1000000000n });
const outsider = tools.generateEmulatorAccount({ lovelace: 1000000000n });
const emulator = new tools.Emulator([issuer, outsider]);
const wallet = await tools.Lucid(emulator, "Preprod");
wallet.selectWallet.fromSeed(issuer.seedPhrase);
const issuerKey = tools.getAddressDetails(issuer.address).paymentCredential.hash;
const seed = (await wallet.wallet().getUtxos())[0];
const tokenName = tools.fromText("CSWAP_REGISTRY");
const identity = { type: "PlutusV3", script: tools.applyParamsToScript(identityCode, [new tools.Constr(0, [seed.txHash, BigInt(seed.outputIndex)]), tokenName]) };
const token = tools.mintingPolicyToId(identity) + tokenName;
process.env.NEXT_PUBLIC_CARDANO_NETWORK = "preprod";
process.env.NEXT_PUBLIC_ASSET_REGISTRY_TOKEN = token;
process.env.NEXT_PUBLIC_ASSET_REGISTRY_ISSUER = issuerKey;
const registry = await import("../src/lib/asset-registry.ts");
const script = registry.registryScript(tools, registryCode, token, issuerKey);
const address = tools.validatorToAddress("Preprod", script);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(url, "/api/registry-blueprint");
  return Response.json({ registry: registryCode, identity: identityCode });
};

async function submit(tx) {
  const hash = await (await tx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  return hash;
}

async function update(state, asset, revoke = false) {
  const entries = revoke ? state.entries.filter((entry) => entry !== asset) : [asset, ...state.entries];
  return wallet.newTx().collectFrom([state.utxo], tools.Data.to(new tools.Constr(revoke ? 1 : 0, [registry.assetData(tools, asset)])))
    .attach.SpendingValidator(script)
    .pay.ToContract(address, { kind: "inline", value: registry.registryDatum(tools, state.version + 1n, entries) }, { ...state.utxo.assets })
    .addSigner(await wallet.wallet().address()).complete();
}

test("registry lifecycle: initialize, authenticate, register, reject outsider, revoke", async () => {
  try {
    const bootstrap = await wallet.newTx().collectFrom([seed]).mintAssets({ [token]: 1n }, tools.Data.to(new tools.Constr(0, [])))
      .attach.MintingPolicy(identity)
      .pay.ToContract(address, { kind: "inline", value: registry.registryDatum(tools, 0n, []) }, { lovelace: 5000000n, [token]: 1n })
      .addSigner(issuer.address).complete();
    await submit(bootstrap);
    let state = await registry.readRegistry(wallet);
    assert.deepEqual(state.entries, []);
    assert.equal(state.version, 0n);
    const unit = "ab".repeat(28) + "01";
    await submit(await update(state, unit));
    state = await registry.readRegistry(wallet);
    assert.deepEqual(state.entries, [unit]);
    assert.equal(state.version, 1n);
    await assert.rejects(update(state, unit), /./, "duplicate registration must fail validation");
    wallet.selectWallet.fromSeed(outsider.seedPhrase);
    await assert.rejects(update(state, unit, true), /./, "outsider must not revoke issuer approval");
    wallet.selectWallet.fromSeed(issuer.seedPhrase);
    await submit(await update(state, unit, true));
    state = await registry.readRegistry(wallet);
    assert.deepEqual(state.entries, []);
    assert.equal(state.version, 2n);

    await assert.rejects(registry.readRegistry({ utxoByUnit: async () => ({ ...state.utxo, address: outsider.address }) }), /expected script/);
    await assert.rejects(registry.readRegistry({ utxoByUnit: async () => ({ ...state.utxo, assets: { lovelace: 5000000n } }) }), /expected script/);
    assert.throws(() => registry.decodeRegistryDatum(tools, registry.registryDatum(tools, 1n, [unit, unit])), /Duplicate/);
    assert.throws(() => registry.decodeRegistryDatum(tools, registry.registryDatum(tools, -1n, [])), /Invalid/);
  } finally { globalThis.fetch = originalFetch; }
});

test("mint provenance verifies parameterized policy and rejects unrelated assets", async () => {
  const minter = JSON.parse(await readFile(new URL("../contracts/minter/plutus.json", import.meta.url), "utf8"));
  const compiledCode = minter.validators.find((v) => v.title === "multi_nft_policy.multi_oneshot.mint").compiledCode;
  const mintSeed = { tx_hash: "12".repeat(32), output_index: 2 };
  const applied = tools.applyParamsToScript(compiledCode, [new tools.Constr(0, [mintSeed.tx_hash, 2n])]);
  const unit = tools.mintingPolicyToId({ type: "PlutusV3", script: applied }) + "01";
  const hash = "34".repeat(32);
  let inputs = [mintSeed];
  globalThis.fetch = async (url) => {
    if (url === "/api/minter-blueprint") return Response.json({ compiledCode });
    if (url === `/api/blockfrost/txs/${hash}/utxos`) return Response.json({ inputs });
    if (url.startsWith("/api/blockfrost/assets/")) return Response.json({ asset: url.split("/").pop(), initial_mint_tx_hash: hash });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await registry.verifyOriginalMint(unit);
    await assert.rejects(registry.verifyOriginalMint("ff".repeat(28)), /not minted/);
    inputs = [{ ...mintSeed, reference: true }];
    await assert.rejects(registry.verifyOriginalMint(unit), /not minted/);
    inputs = [{ ...mintSeed, collateral: true }];
    await assert.rejects(registry.verifyOriginalMint(unit), /not minted/);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(registry.verifyOriginalMint(unit), /Unable to verify/);
  } finally { globalThis.fetch = originalFetch; }
});

test("full registry can be updated within ledger limits and rejects a 51st asset", async () => {
  const entries = Array.from({ length: 49 }, (_, i) => "cd".repeat(28) + i.toString(16).padStart(64, "0"));
  const datum = registry.registryDatum(tools, 49n, entries);
  const account = { ...issuer, address, assets: { lovelace: 20000000n, [token]: 1n }, outputData: { inline: datum } };
  const chain = new tools.Emulator([issuer, account]);
  const local = await tools.Lucid(chain, "Preprod");
  local.selectWallet.fromSeed(issuer.seedPhrase);
  const append = async (state, unit) => local.newTx()
    .collectFrom([state.utxo], tools.Data.to(new tools.Constr(0, [registry.assetData(tools, unit)])))
    .attach.SpendingValidator(script)
    .pay.ToContract(address, { kind: "inline", value: registry.registryDatum(tools, state.version + 1n, [unit, ...state.entries]) }, { ...state.utxo.assets })
    .addSigner(issuer.address).complete();
  globalThis.fetch = async () => Response.json({ registry: registryCode, identity: identityCode });
  try {
    let state = await registry.readRegistry(local);
    const tx = await append(state, "ab".repeat(28) + "ef".repeat(32));
    await (await tx.sign.withWallet().complete()).submit();
    chain.awaitBlock(1);
    state = await registry.readRegistry(local);
    assert.equal(state.entries.length, 50);
    await assert.rejects(append(state, "ef".repeat(28) + "ab".repeat(32)), /./);
  } finally { globalThis.fetch = originalFetch; }
});
