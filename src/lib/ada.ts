export const LOVELACE_PER_ADA = BigInt(1_000_000);

/** Formats a lovelace quantity as an exact, human-readable ADA amount. */
export function formatAda(lovelace: bigint): string {
  const negative = lovelace < BigInt(0);
  const value = negative ? -lovelace : lovelace;
  const whole = value / LOVELACE_PER_ADA;
  const fraction = (value % LOVELACE_PER_ADA).toString().padStart(6, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + new Intl.NumberFormat("en-US").format(whole) + (fraction ? "." + fraction : "");
}

export function formatAdaWithUnit(lovelace: bigint, unit = "ADA"): string {
  return formatAda(lovelace) + " " + unit;
}
