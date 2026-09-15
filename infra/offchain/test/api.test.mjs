import test from "node:test";
import assert from "node:assert/strict";
import { createApiHandler } from "../runtime/api.mjs";

const store = {
  get: async (pk, sk) => pk === "REGISTRY#SUPPORTED" ? { PK: pk, SK: sk, unit: sk.slice(6), entity: "supported-asset" } : { PK: pk, SK: sk, tipSlot: 42 },
  queryPartition: async () => ({ items: [{ PK: "REGISTRY#SUPPORTED", SK: "ASSET#abc", unit: "abc" }] }),
  queryKind: async (kind) => ({ items: [{ PK: "UTXO#x#0", SK: "STATE", GSI1PK: `KIND#${kind}`, GSI1SK: "UTXO#x#0", kind, reference: "x#0" }] }),
};
const handler = createApiHandler({ store, network: "preprod" });

test("health does not require database access", async () => {
  const result = await handler({ rawPath: "/health", requestContext: { http: { method: "GET" } } });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).network, "preprod");
});

test("returns supported assets without internal DynamoDB keys", async () => {
  const result = await handler({ rawPath: "/v1/registry/assets", requestContext: { http: { method: "GET" } } });
  assert.deepEqual(JSON.parse(result.body).items, [{ unit: "abc" }]);
});

test("lists typed chain state", async () => {
  const result = await handler({ rawPath: "/v1/state/dex-pool", requestContext: { http: { method: "GET" } }, queryStringParameters: { limit: "10" } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body).items, [{ kind: "dex-pool", reference: "x#0" }]);
});

test("rejects unknown state kinds", async () => {
  const result = await handler({ rawPath: "/v1/state/admin", requestContext: { http: { method: "GET" } } });
  assert.equal(result.statusCode, 404);
});
