type Tools = typeof import("@lucid-evolution/lucid");
export function decodeCardanoAddress(raw: unknown, tools: Pick<Tools, "credentialToAddress">, network: "Preprod" | "Mainnet" = "Preprod"): string {
  const constr = (value: unknown) => {
    if (!value || typeof value !== "object" || !("index" in value) || !("fields" in value) || !Array.isArray(value.fields)) throw new Error("Malformed address datum.");
    return value as { index: number; fields: unknown[] };
  };
  const credential = (value: unknown) => {
    const c = constr(value);
    if (![0, 1].includes(c.index) || c.fields.length !== 1 || typeof c.fields[0] !== "string" || !/^[0-9a-f]{56}$/i.test(c.fields[0])) throw new Error("Malformed address credential.");
    return { type: c.index === 0 ? "Key" as const : "Script" as const, hash: c.fields[0] };
  };
  const root = constr(raw);
  if (root.index !== 0 || root.fields.length !== 2) throw new Error("Malformed address datum.");
  const payment = credential(root.fields[0]);
  if (root.fields[1] === null) return tools.credentialToAddress(network, payment);
  const option = constr(root.fields[1]);
  if (option.index === 1 && option.fields.length === 0) return tools.credentialToAddress(network, payment);
  if (option.index !== 0 || option.fields.length !== 1) throw new Error("Malformed staking option.");
  const staking = constr(option.fields[0]);
  if (staking.index !== 0 || staking.fields.length !== 1) throw new Error("Unsupported staking credential.");
  return tools.credentialToAddress(network, payment, credential(staking.fields[0]));
}
