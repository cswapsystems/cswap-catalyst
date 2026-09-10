import assert from "node:assert/strict";
import test from "node:test";
import { createWalletSession, WALLET_STORAGE_KEY } from "../src/lib/wallet-session.ts";

function fixture(options = {}) {
  const values = new Map();
  const calls = { enable: 0, initialize: 0, enabled: 0 };
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const lucid = {};
  const extension = {
    isEnabled: async () => { calls.enabled++; return options.authorized ?? true; },
    enable: async () => { calls.enable++; return { getNetworkId: async () => options.network ?? 0 }; },
  };
  const dependencies = {
    storage: () => storage,
    extension: () => options.missing ? undefined : extension,
    initialize: async () => { calls.initialize++; return { lucid, address: options.address ?? "current-wallet-address" }; },
    ...options.dependencies,
  };
  return { values, calls, lucid, session: createWalletSession(dependencies), dependencies };
}

test("successful connection stores only wallet selection and reload reads current wallet", async () => {
  const f = fixture();
  await f.session.connect();
  assert.deepEqual([...f.values], [[WALLET_STORAGE_KEY, "eternl"]]);
  assert.equal(f.session.getSnapshot().status, "connected");
  const restored = createWalletSession({ ...f.dependencies, initialize: async () => ({ lucid: f.lucid, address: "changed-account" }) });
  await restored.restore();
  assert.equal(restored.getSnapshot().address, "changed-account");
  assert.equal(f.calls.enabled, 1);
});

test("no preference or revoked permission never enables wallet automatically", async () => {
  const f = fixture({ authorized: false });
  await f.session.restore();
  assert.equal(f.calls.enabled, 0);
  f.values.set(WALLET_STORAGE_KEY, "eternl");
  await f.session.restore();
  assert.equal(f.calls.enable, 0);
  assert.equal(f.values.size, 0);
  assert.equal(f.session.getSnapshot().status, "idle");
});

test("missing extension preserves preference without reporting a connection", async () => {
  const f = fixture({ missing: true });
  f.values.set(WALLET_STORAGE_KEY, "eternl");
  await f.session.restore();
  assert.equal(f.session.getSnapshot().status, "idle");
  assert.equal(f.values.get(WALLET_STORAGE_KEY), "eternl");
});

test("wrong network clears wallet state and remembered selection", async () => {
  const f = fixture({ network: 1 });
  f.values.set(WALLET_STORAGE_KEY, "eternl");
  await f.session.restore();
  assert.equal(f.calls.initialize, 0);
  assert.equal(f.session.getSnapshot().status, "error");
  assert.equal(f.session.getSnapshot().lucid, null);
  assert.equal(f.session.getSnapshot().address, "");
  assert.equal(f.values.size, 0);
});

test("storage failures do not prevent manual connection or disconnect", async () => {
  const f = fixture({ dependencies: { storage: () => { throw new Error("Storage blocked"); } } });
  await f.session.restore();
  assert.equal(f.calls.enable, 0);
  await f.session.connect();
  assert.equal(f.session.getSnapshot().status, "connected");
  f.session.disconnect();
  assert.equal(f.session.getSnapshot().status, "idle");
});

test("disconnect clears storage and invalidates an in-flight reconnect", async () => {
  let resolve;
  const delayed = new Promise((done) => { resolve = done; });
  const f = fixture({ dependencies: { initialize: () => delayed } });
  f.values.set(WALLET_STORAGE_KEY, "eternl");
  const pending = f.session.restore();
  await new Promise((done) => setImmediate(done));
  f.session.disconnect();
  resolve({ lucid: {}, address: "late-wallet" });
  assert.equal(await pending, null);
  assert.equal(f.session.getSnapshot().status, "idle");
  assert.equal(f.session.getSnapshot().address, "");
  assert.equal(f.values.size, 0);
});

test("concurrent connect requests share one wallet permission request", async () => {
  const f = fixture();
  const first = f.session.connect();
  const second = f.session.connect();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(f.calls.enable, 1);
});

test("failed reconnect cannot leave the previous account connected", async () => {
  const f = fixture();
  await f.session.connect();
  f.dependencies.initialize = async () => { throw new Error("Wallet unavailable"); };
  await f.session.connect();
  assert.equal(f.session.getSnapshot().status, "error");
  assert.equal(f.session.getSnapshot().address, "");
  assert.equal(f.session.getSnapshot().lucid, null);
  assert.equal(f.values.size, 0);
});
