export const RWA_MANIFEST_SCHEMA = "cswap.rwa-manifest/v1" as const;

export type RwaCategory = "real-estate" | "collectible";

export type RwaMetadataInput = {
  category: "" | RwaCategory;
  name: string;
  tokenName: string;
  description: string;
  externalId: string;
  issuerName: string;
  issuerCountry: string;
  valuationAmount: string;
  valuationCurrency: string;
  valuationDate: string;
  propertyType: string;
  propertyAddress: string;
  titleReference: string;
  area: string;
  areaUnit: string;
  collectibleType: string;
  creator: string;
  productionYear: string;
  serialNumber: string;
  condition: string;
  publicDataConfirmed: boolean;
};

export type RwaDocumentSources = {
  image: { uri: string; mediaType: string };
  authenticityProof: { uri: string; mediaType: string };
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasStrings(value: unknown, fields: string[]): value is JsonObject {
  return isObject(value) && fields.every((field) => typeof value[field] === "string" && value[field].trim() !== "");
}

export function isRwaManifestDocument(value: unknown): boolean {
  if (!isObject(value) || value.schema !== RWA_MANIFEST_SCHEMA || (value.category !== "real-estate" && value.category !== "collectible")) return false;
  if (!hasStrings(value.asset, ["name", "tokenName", "externalId", "description"])) return false;
  if (!hasStrings(value.issuer, ["name", "country"]) || !/^[A-Z]{2}$/.test(String(value.issuer.country))) return false;
  if (!hasStrings(value.valuation, ["amount", "currency", "asOf"]) || !/^\d+(\.\d+)?$/.test(String(value.valuation.amount)) || !/^[A-Z]{3}$/.test(String(value.valuation.currency)) || !isStrictDate(String(value.valuation.asOf))) return false;
  if (!isObject(value.documents) || !hasStrings(value.documents.image, ["uri", "mediaType"]) || !hasStrings(value.documents.authenticityProof, ["uri", "mediaType"])) return false;
  if (!String(value.documents.image.uri).startsWith("ipfs://") || !String(value.documents.authenticityProof.uri).startsWith("ipfs://")) return false;
  if (!isObject(value.declarations) || value.declarations.publicDataApproved !== true || typeof value.declarations.generatedAt !== "string" || Number.isNaN(Date.parse(value.declarations.generatedAt))) return false;
  if (value.category === "real-estate") {
    if (!hasStrings(value.realEstate, ["propertyType", "publicLocation", "titleOrParcelReference"]) || !hasStrings(value.realEstate.area, ["value", "unit"])) return false;
    return /^\d+(\.\d+)?$/.test(String(value.realEstate.area.value)) && Number(value.realEstate.area.value) > 0;
  }
  return hasStrings(value.collectible, ["type", "makerOrCreator", "serialOrCatalogueNumber", "condition"])
    && Number.isInteger(value.collectible.productionYear) && Number(value.collectible.productionYear) >= 1000;
}

export const initialRwaMetadataInput: RwaMetadataInput = {
  category: "",
  name: "",
  tokenName: "",
  description: "",
  externalId: "",
  issuerName: "",
  issuerCountry: "",
  valuationAmount: "",
  valuationCurrency: "",
  valuationDate: "",
  propertyType: "",
  propertyAddress: "",
  titleReference: "",
  area: "",
  areaUnit: "sqm",
  collectibleType: "",
  creator: "",
  productionYear: "",
  serialNumber: "",
  condition: "",
  publicDataConfirmed: false,
};

const labels: Partial<Record<keyof RwaMetadataInput, string>> = {
  category: "Category",
  name: "Display name",
  tokenName: "Token name",
  description: "Description",
  externalId: "Asset reference",
  issuerName: "Issuer name",
  issuerCountry: "Issuer country",
  valuationAmount: "Valuation amount",
  valuationCurrency: "Valuation currency",
  valuationDate: "Valuation date",
  propertyType: "Property type",
  propertyAddress: "Property location",
  titleReference: "Title or parcel reference",
  area: "Property area",
  areaUnit: "Area unit",
  collectibleType: "Collectible type",
  creator: "Maker or creator",
  productionYear: "Production year",
  serialNumber: "Serial or catalogue number",
  condition: "Condition",
};

const commonRequired: (keyof RwaMetadataInput)[] = [
  "category", "name", "tokenName", "description", "externalId", "issuerName",
  "issuerCountry", "valuationAmount", "valuationCurrency", "valuationDate",
];
const realEstateRequired: (keyof RwaMetadataInput)[] = [
  "propertyType", "propertyAddress", "titleReference", "area", "areaUnit",
];
const collectibleRequired: (keyof RwaMetadataInput)[] = [
  "collectibleType", "creator", "productionYear", "serialNumber", "condition",
];

function isStrictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateRwaMetadata(input: RwaMetadataInput, today = new Date().toISOString().slice(0, 10)): string[] {
  const errors: string[] = [];
  const required = [
    ...commonRequired,
    ...(input.category === "real-estate" ? realEstateRequired : input.category === "collectible" ? collectibleRequired : []),
  ];

  for (const field of required) {
    if (typeof input[field] === "string" && !input[field].trim()) errors.push(`${labels[field] ?? field} is required.`);
  }

  if (new TextEncoder().encode(input.tokenName.trim()).length > 32) errors.push("Token name must be at most 32 UTF-8 bytes.");
  if (new TextEncoder().encode(input.name.trim()).length > 64) errors.push("Display name must be at most 64 UTF-8 bytes.");
  if (input.description.trim().length > 500) errors.push("Description must be at most 500 characters.");
  if (input.description.trim() && input.description.trim().length < 20) errors.push("Description must be at least 20 characters.");
  if (input.issuerCountry.trim() && !/^[A-Za-z]{2}$/.test(input.issuerCountry.trim())) errors.push("Issuer country must be a two-letter ISO country code.");
  if (input.valuationCurrency.trim() && !/^[A-Za-z]{3}$/.test(input.valuationCurrency.trim())) errors.push("Valuation currency must be a three-letter ISO currency code.");
  if (input.valuationAmount.trim() && (!/^\d+(\.\d+)?$/.test(input.valuationAmount.trim()) || Number(input.valuationAmount) <= 0)) errors.push("Valuation amount must be a positive number.");
  if (input.valuationDate.trim() && (!isStrictDate(input.valuationDate) || input.valuationDate > today)) errors.push("Valuation date must be a valid date that is not in the future.");
  if (input.category === "real-estate" && input.area.trim() && (!/^\d+(\.\d+)?$/.test(input.area.trim()) || Number(input.area) <= 0)) errors.push("Property area must be a positive number.");
  if (input.category === "collectible" && input.productionYear.trim()) {
    const year = Number(input.productionYear);
    const currentYear = Number(today.slice(0, 4));
    if (!/^\d{4}$/.test(input.productionYear.trim()) || year < 1000 || year > currentYear) errors.push("Production year must be a four-digit year that is not in the future.");
  }
  if (!input.publicDataConfirmed) errors.push("Confirm that the submitted information and documents are approved for public storage.");

  return [...new Set(errors)];
}

function normalized(input: RwaMetadataInput) {
  return {
    ...input,
    name: input.name.trim(),
    tokenName: input.tokenName.trim(),
    description: input.description.trim(),
    externalId: input.externalId.trim(),
    issuerName: input.issuerName.trim(),
    issuerCountry: input.issuerCountry.trim().toUpperCase(),
    valuationAmount: input.valuationAmount.trim(),
    valuationCurrency: input.valuationCurrency.trim().toUpperCase(),
    propertyType: input.propertyType.trim(),
    propertyAddress: input.propertyAddress.trim(),
    titleReference: input.titleReference.trim(),
    area: input.area.trim(),
    areaUnit: input.areaUnit.trim(),
    collectibleType: input.collectibleType.trim(),
    creator: input.creator.trim(),
    productionYear: input.productionYear.trim(),
    serialNumber: input.serialNumber.trim(),
    condition: input.condition.trim(),
  };
}

function assembleRwaManifest(input: RwaMetadataInput, documents: RwaDocumentSources, generatedAt: string) {
  const value = normalized(input);

  return {
    schema: RWA_MANIFEST_SCHEMA,
    category: value.category,
    asset: {
      name: value.name,
      tokenName: value.tokenName,
      externalId: value.externalId,
      description: value.description,
    },
    issuer: { name: value.issuerName, country: value.issuerCountry },
    ...(value.category === "real-estate" ? {
      realEstate: {
        propertyType: value.propertyType,
        publicLocation: value.propertyAddress,
        titleOrParcelReference: value.titleReference,
        area: { value: value.area, unit: value.areaUnit },
      },
    } : {
      collectible: {
        type: value.collectibleType,
        makerOrCreator: value.creator,
        productionYear: Number(value.productionYear),
        serialOrCatalogueNumber: value.serialNumber,
        condition: value.condition,
      },
    }),
    valuation: {
      amount: value.valuationAmount,
      currency: value.valuationCurrency,
      asOf: value.valuationDate,
    },
    documents: {
      image: documents.image,
      authenticityProof: documents.authenticityProof,
    },
    declarations: {
      publicDataApproved: true,
      generatedAt,
    },
  };
}

export function buildRwaManifest(input: RwaMetadataInput, documents: RwaDocumentSources, generatedAt = new Date().toISOString()) {
  const errors = validateRwaMetadata(input, generatedAt.slice(0, 10));
  if (errors.length) throw new Error(errors[0]);
  return assembleRwaManifest(input, documents, generatedAt);
}

export function buildRwaManifestPreview(input: RwaMetadataInput) {
  const example = (value: string, fallback: string) => value.trim() || fallback;
  const category = input.category || "real-estate";
  const previewInput: RwaMetadataInput = {
    ...input,
    category,
    name: example(input.name, "Example asset"),
    tokenName: example(input.tokenName, "RWA-001"),
    description: example(input.description, "Public description of the represented real-world asset."),
    externalId: example(input.externalId, "PUBLIC-REF-001"),
    issuerName: example(input.issuerName, "Example Issuer Ltd."),
    issuerCountry: example(input.issuerCountry, "US"),
    valuationAmount: example(input.valuationAmount, "100000"),
    valuationCurrency: example(input.valuationCurrency, "USD"),
    valuationDate: example(input.valuationDate, "2026-01-01"),
    propertyType: example(input.propertyType, "commercial"),
    propertyAddress: example(input.propertyAddress, "Public property location"),
    titleReference: example(input.titleReference, "TITLE-001"),
    area: example(input.area, "100"),
    areaUnit: example(input.areaUnit, "sqm"),
    collectibleType: example(input.collectibleType, "artwork"),
    creator: example(input.creator, "Example Creator"),
    productionYear: example(input.productionYear, "2020"),
    serialNumber: example(input.serialNumber, "CAT-001"),
    condition: example(input.condition, "excellent"),
    publicDataConfirmed: true,
  };
  return assembleRwaManifest(previewInput, {
    image: { uri: "ipfs://<image-cid>", mediaType: "image/jpeg" },
    authenticityProof: { uri: "ipfs://<proof-cid>", mediaType: "application/pdf" },
  }, "2026-01-01T00:00:00.000Z");
}
