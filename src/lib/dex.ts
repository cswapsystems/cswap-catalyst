const LOVELACE_PER_ADA = BigInt(1_000_000);

export function parseAdaToLovelace(value: string): bigint {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) throw new Error("ADA amount must use up to six decimal places.");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  const amount = whole * LOVELACE_PER_ADA + fraction;
  if (amount <= BigInt(0)) throw new Error("ADA amount must be greater than zero.");
  return amount;
}

export function quoteConstantProduct(input: bigint, reserveIn: bigint, reserveOut: bigint, feeNumerator: bigint, feeDenominator: bigint): bigint {
  if (input <= BigInt(0) || reserveIn <= BigInt(0) || reserveOut <= BigInt(0) || feeNumerator <= BigInt(0) || feeDenominator <= BigInt(0) || feeNumerator > feeDenominator) throw new Error("Pool reserves or fee configuration are invalid.");
  const output = input * feeNumerator * reserveOut / (reserveIn * feeDenominator + input * feeNumerator);
  if (output <= BigInt(0) || output >= reserveOut) throw new Error("Swap output rounds to zero.");
  return output;
}
