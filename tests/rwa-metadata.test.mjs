import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRwaManifest,
  buildRwaManifestPreview,
  initialRwaMetadataInput,
  isRwaManifestDocument,
  validateRwaMetadata,
} from "../src/lib/rwa-metadata.ts";

const documents = {
  image: { uri: "ipfs://image-cid", mediaType: "image/jpeg" },
  authenticityProof: { uri: "ipfs://proof-cid", mediaType: "application/pdf" },
};

function realEstateInput() {
  return {
    ...initialRwaMetadataInput,
    category: "real-estate",
    name: "Harbor View Unit 12",
    tokenName: "HVU-012",
    description: "A documented commercial unit represented by this one-shot native asset.",
    externalId: "PROP-2026-001",
    issuerName: "Catalyst Asset Services Ltd.",
    issuerCountry: "ph",
    valuationAmount: "250000.50",
    valuationCurrency: "usd",
    valuationDate: "2026-01-10",
    propertyType: "commercial",
    propertyAddress: "Makati City, Philippines",
    titleReference: "TCT-123456",
    area: "125.5",
    areaUnit: "sqm",
    publicDataConfirmed: true,
  };
}

test("builds a normalized real-estate manifest", () => {
  const manifest = buildRwaManifest(realEstateInput(), documents, "2026-02-01T00:00:00.000Z");
  assert.equal(manifest.schema, "cswap.rwa-manifest/v1");
  assert.equal(manifest.category, "real-estate");
  assert.deepEqual(manifest.issuer, { name: "Catalyst Asset Services Ltd.", country: "PH" });
  assert.deepEqual(manifest.valuation, { amount: "250000.50", currency: "USD", asOf: "2026-01-10" });
  assert.deepEqual(manifest.realEstate.area, { value: "125.5", unit: "sqm" });
  assert.equal("collectible" in manifest, false);
  assert.deepEqual(manifest.documents, documents);
  assert.equal(isRwaManifestDocument(manifest), true);
});

test("builds a collectible manifest with category-specific provenance", () => {
  const input = {
    ...realEstateInput(),
    category: "collectible",
    collectibleType: "watch",
    creator: "Example Watchmaker",
    productionYear: "1998",
    serialNumber: "WATCH-4471",
    condition: "excellent",
  };
  const manifest = buildRwaManifest(input, documents, "2026-02-01T00:00:00.000Z");
  assert.equal(manifest.category, "collectible");
  assert.equal(manifest.collectible.productionYear, 1998);
  assert.equal(manifest.collectible.serialOrCatalogueNumber, "WATCH-4471");
  assert.equal("realEstate" in manifest, false);
});

test("rejects missing category data and public-storage approval", () => {
  const input = { ...realEstateInput(), titleReference: "", publicDataConfirmed: false };
  const errors = validateRwaMetadata(input, "2026-02-01");
  assert.ok(errors.includes("Title or parcel reference is required."));
  assert.ok(errors.some((message) => message.includes("public storage")));
  assert.throws(() => buildRwaManifest(input, documents, "2026-02-01T00:00:00.000Z"), /Title or parcel reference/);
});

test("rejects malformed values and future dates", () => {
  const input = {
    ...realEstateInput(), issuerCountry: "Philippines", valuationCurrency: "US",
    valuationAmount: "-1", valuationDate: "2027-01-01", area: "0",
  };
  const errors = validateRwaMetadata(input, "2026-02-01");
  assert.equal(errors.length, 5);
});

test("preview provides a complete basic template before fields are filled", () => {
  const preview = buildRwaManifestPreview(initialRwaMetadataInput);
  assert.equal(preview.category, "real-estate");
  assert.equal(preview.documents.image.uri, "ipfs://<image-cid>");
  assert.ok(preview.realEstate.titleOrParcelReference);
});

test("server-side manifest guard rejects arbitrary JSON and invalid document URIs", () => {
  assert.equal(isRwaManifestDocument({ hello: "world" }), false);
  const manifest = buildRwaManifest(realEstateInput(), documents, "2026-02-01T00:00:00.000Z");
  assert.equal(isRwaManifestDocument({ ...manifest, documents: { ...manifest.documents, image: { uri: "https://example.com/image.jpg", mediaType: "image/jpeg" } } }), false);
});
