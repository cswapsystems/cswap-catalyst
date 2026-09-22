/** Keep pool identity, authorities, balances and LP accounting unchanged. */
export function sharedPoolUpdateFields<T>(fields: T[], minimum: bigint, cash: bigint, pauseFlag: T): (T | bigint)[] {
  if (fields.length !== 10 || typeof fields[6] !== "bigint" || typeof fields[7] !== "bigint" || typeof fields[9] !== "bigint") throw new Error("Malformed shared-pool state.");
  if (minimum < BigInt(0) || minimum > cash) throw new Error("Protected reserve must be between zero and current cash.");
  const next: (T | bigint)[] = [...fields];
  next[7] = minimum; next[8] = pauseFlag;
  return next;
}

export function factoryPauseFields<T>(fields: T[], pauseFlag: T): T[] {
  if (fields.length !== 5 || typeof fields[3] !== "bigint") throw new Error("Malformed factory state.");
  return [...fields.slice(0, 4), pauseFlag];
}
