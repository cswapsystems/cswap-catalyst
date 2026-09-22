const LOVELACE_PER_ADA = BigInt(1_000_000);

export function quoteLiquidityDeposit(requestedA: bigint, reserveA: bigint, reserveB: bigint, supply: bigint) {
  if (requestedA <= BigInt(0) || reserveA <= BigInt(0) || reserveB <= BigInt(0) || supply <= BigInt(0)) throw new Error("Deposit and reserves must be positive.");
  let a = reserveA, b = reserveB;
  while (b !== BigInt(0)) { const remainder = a % b; a = b; b = remainder; }
  const ratioA = reserveA / a, ratioB = reserveB / a;
  const multiplier = (requestedA + ratioA - BigInt(1)) / ratioA;
  const amountA = ratioA * multiplier, amountB = ratioB * multiplier;
  const lp = amountA * supply / reserveA;
  if (lp <= BigInt(0)) throw new Error("Liquidity output rounds to zero.");
  return { amountA, amountB, lp };
}

export function quoteLiquidityWithdrawal(burn: bigint, reserveA: bigint, reserveB: bigint, supply: bigint) {
  if (burn <= BigInt(0) || burn >= supply || reserveA <= BigInt(0) || reserveB <= BigInt(0)) throw new Error("Withdrawal must burn less than the full LP supply.");
  const amountA = burn * reserveA / supply, amountB = burn * reserveB / supply;
  if (amountA === BigInt(0) || amountB === BigInt(0)) {
    const minimumA = (supply + reserveA - BigInt(1)) / reserveA;
    const minimumB = (supply + reserveB - BigInt(1)) / reserveB;
    throw new Error(`Withdrawal rounds to zero. Burn at least ${minimumA > minimumB ? minimumA : minimumB} LP units to receive both assets.`);
  }
  return { amountA, amountB, lp: burn };
}

// Includes the pool fee and integer rounding relative to the pre-trade spot rate.
export function priceImpactBps(input: bigint, output: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (input <= BigInt(0) || output <= BigInt(0) || reserveIn <= BigInt(0) || reserveOut <= BigInt(0)) throw new Error("Price impact inputs must be positive.");
  const impact = BigInt(10_000) - output * reserveIn * BigInt(10_000) / (input * reserveOut);
  return impact > BigInt(0) ? impact : BigInt(0);
}

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
