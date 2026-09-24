function readLength(bytes, state, additional) {
  if (additional < 24) return additional;
  const widths = { 24: 1, 25: 2, 26: 4, 27: 8 };
  const width = widths[additional];
  if (!width) throw new Error("Unsupported CBOR length.");
  if (state.offset + width > bytes.length) throw new Error("Truncated CBOR value.");
  let value = 0n;
  for (let i = 0; i < width; i += 1) value = (value << 8n) | BigInt(bytes[state.offset++]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR value exceeds safe integer range.");
  return Number(value);
}

function decodeItem(bytes, state) {
  if (state.offset >= bytes.length) throw new Error("Truncated CBOR data.");
  const head = bytes[state.offset++];
  if (head === 0xff) return { break: true };
  const major = head >> 5;
  const additional = head & 31;
  const indefinite = additional === 31;
  if (major === 0 || major === 1) {
    const value = readLength(bytes, state, additional);
    return major === 0 ? BigInt(value) : -1n - BigInt(value);
  }
  if (major === 2) {
    if (indefinite) throw new Error("Indefinite byte strings are not supported.");
    const length = readLength(bytes, state, additional);
    const end = state.offset + length;
    if (end > bytes.length) throw new Error("Truncated CBOR bytes.");
    const value = bytes.slice(state.offset, end);
    state.offset = end;
    return value;
  }
  if (major === 4) {
    const length = indefinite ? null : readLength(bytes, state, additional);
    const result = [];
    while (length === null || result.length < length) {
      const value = decodeItem(bytes, state);
      if (value && value.break === true) {
        if (length !== null) throw new Error("Unexpected CBOR break.");
        return result;
      }
      result.push(value);
    }
    return result;
  }
  if (major === 6) {
    const tag = readLength(bytes, state, additional);
    return { tag, value: decodeItem(bytes, state) };
  }
  throw new Error(`Unsupported CBOR major type ${major}.`);
}

export function decodePlutusData(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("Datum must be non-empty CBOR hex.");
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  const state = { offset: 0 };
  const result = decodeItem(bytes, state);
  if (state.offset !== bytes.length) throw new Error("Trailing CBOR data.");
  return result;
}

function constructorFields(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.value)) throw new Error("Expected Plutus constructor.");
  if (!((value.tag >= 121 && value.tag <= 127) || (value.tag >= 1280 && value.tag <= 1400))) throw new Error("Unsupported Plutus constructor tag.");
  return value.value;
}

const maxRegistryEntries = 50;

// Mirrors decodeRegistryDatum in src/lib/asset-registry.ts: Constr 0 [version >= 0, [Constr 0 [policy, name]]].
export function decodeRegistryDatum(hex) {
  const decoded = decodePlutusData(hex);
  const root = constructorFields(decoded);
  if (decoded.tag !== 121 || root.length !== 2 || typeof root[0] !== "bigint" || root[0] < 0n || !Array.isArray(root[1]) || root[1].length > maxRegistryEntries) throw new Error("Invalid registry datum.");
  const assets = root[1].map((entry) => {
    const fields = constructorFields(entry);
    if (entry.tag !== 121 || fields.length !== 2 || !(fields[0] instanceof Uint8Array) || !(fields[1] instanceof Uint8Array) || fields[0].length !== 28 || fields[1].length > 32) throw new Error("Invalid registry asset.");
    return Buffer.from(fields[0]).toString("hex") + Buffer.from(fields[1]).toString("hex");
  });
  if (new Set(assets).size !== assets.length) throw new Error("Duplicate registry entries.");
  return { version: root[0].toString(), assets };
}
