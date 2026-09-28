import type { PoolPrice } from "./marketplace";

const LOVELACE_PER_ADA = BigInt(1_000_000);

function parseAdaAmount(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error("ADA amount must use up to six decimal places.");
  return BigInt(match[1]) * LOVELACE_PER_ADA + BigInt((match[2] ?? "").padEnd(6, "0"));
}

export function positiveBaseUnits(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value.trim())) throw new Error(`${label} must be a positive whole number of base units.`);
  return BigInt(value.trim());
}

export function parseQuoteAmount(value: string, adaQuote: boolean): bigint {
  const amount = adaQuote ? parseAdaAmount(value) : positiveBaseUnits(value, "Quote amount");
  if (amount <= BigInt(0)) throw new Error("Quote amount must be greater than zero.");
  return amount;
}

export function displayQuoteAmount(amount: bigint, adaQuote: boolean): string {
  if (!adaQuote) return amount.toString();
  const fraction = (amount % LOVELACE_PER_ADA).toString().padStart(6, "0").replace(/0+$/, "");
  return (amount / LOVELACE_PER_ADA).toString() + (fraction ? "." + fraction : "");
}

export function makePoolPrice(unit: string, buyAmount: string, buyQuantity: string, sellAmount: string, sellQuantity: string, adaQuote: boolean): PoolPrice {
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) throw new Error("Select an exact approved asset.");
  return {
    asset: { policyId: unit.slice(0, 56), assetName: unit.slice(56) },
    buy: { numerator: parseQuoteAmount(buyAmount, adaQuote), denominator: positiveBaseUnits(buyQuantity, "Buy asset quantity") },
    sell: { numerator: parseQuoteAmount(sellAmount, adaQuote), denominator: positiveBaseUnits(sellQuantity, "Sell asset quantity") },
  };
}

export function samePoolPrice(a: PoolPrice, b: PoolPrice): boolean {
  return a.buy.numerator === b.buy.numerator && a.buy.denominator === b.buy.denominator
    && a.sell.numerator === b.sell.numerator && a.sell.denominator === b.sell.denominator;
}

export function eligibleRegistryUnits(entries: readonly string[], quoteUnit: string): string[] {
  return entries.filter((unit) => unit !== quoteUnit);
}

export function changedPriceUnits(previous: readonly PoolPrice[], next: readonly PoolPrice[]): string[] {
  const oldPrices = new Map(previous.map((price) => [price.asset.policyId + price.asset.assetName, price]));
  return next.filter((price) => {
    const unit = price.asset.policyId + price.asset.assetName;
    const old = oldPrices.get(unit);
    return !old || !samePoolPrice(old, price);
  }).map((price) => price.asset.policyId + price.asset.assetName);
}
