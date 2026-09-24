/** Keep pool identity, authorities, balances and LP accounting unchanged. */
export function sharedPoolUpdateFields<T>(fields: T[], minimum: bigint, cash: bigint, pauseFlag: T): (T | bigint)[] {
  if (fields.length !== 14 || typeof fields[7] !== "bigint" || typeof fields[8] !== "bigint" || typeof fields[10] !== "bigint") throw new Error("Malformed shared-pool state.");
  if (minimum < BigInt(0) || minimum > cash) throw new Error("Protected reserve must be between zero and current cash.");
  const next: (T | bigint)[] = [...fields];
  next[8] = minimum; next[9] = pauseFlag;
  return next;
}

export function factoryPauseFields<T>(fields: T[], pauseFlag: T): T[] {
  if (fields.length !== 5 || typeof fields[3] !== "bigint") throw new Error("Malformed factory state.");
  return [...fields.slice(0, 4), pauseFlag];
}

/** Smallest protected reserve for an ADA-quoted shared pool: keeps the pool output above min-UTxO. */
export const MIN_ADA_PROTECTED_RESERVE = BigInt(2_000_000);

/**
 * Parse the operator's protected-reserve input. Native-quote pools use whole
 * quote base units (zero allowed: the pool output still carries its own ADA).
 * ADA-quoted pools use ADA with up to six decimals and must keep at least 2 ADA,
 * otherwise cash withdrawals/settlement could leave the pool output below min-UTxO.
 */
export function parseProtectedReserve(input: string, nativeQuote: boolean): bigint {
  const value = input.trim();
  if (nativeQuote) {
    if (!/^\d+$/.test(value)) throw new Error("Use whole quote-asset base units.");
    return BigInt(value);
  }
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("Protected reserve must be an ADA amount with up to six decimal places.");
  const lovelace = BigInt(match[1]) * BigInt(1_000_000) + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (lovelace < MIN_ADA_PROTECTED_RESERVE) throw new Error("Protected reserve for an ADA-quoted pool must be at least 2 ADA so the pool output stays above the Cardano minimum UTxO.");
  return lovelace;
}
