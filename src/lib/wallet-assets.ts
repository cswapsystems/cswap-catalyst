import type { UTxO } from "@lucid-evolution/lucid";

export type WalletAsset = { unit: string; policyId: string; nameHex: string; name: string; quantity: bigint };
export type WalletHoldings = { lovelace: bigint; assets: WalletAsset[]; utxoCount: number };

export function walletAssetName(nameHex: string): string {
  if (!nameHex) return "Unnamed token";
  try {
    if (!/^(?:[0-9a-f]{2})+$/i.test(nameHex)) return "Binary asset name";
    const bytes = Uint8Array.from(nameHex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return name.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(name) ? name : "Binary asset name";
  } catch { return "Binary asset name"; }
}

export function summarizeWalletAssets(utxos: Pick<UTxO, "assets">[]): WalletHoldings {
  const amounts = new Map<string, bigint>();
  for (const utxo of utxos) {
    for (const [unit, quantity] of Object.entries(utxo.assets)) {
      amounts.set(unit, (amounts.get(unit) ?? BigInt(0)) + quantity);
    }
  }
  const assets = [...amounts].filter(([unit, quantity]) => unit !== "lovelace" && quantity > BigInt(0)).map(([unit, quantity]) => {
    const nameHex = unit.slice(56);
    return { unit, policyId: unit.slice(0, 56), nameHex, name: walletAssetName(nameHex), quantity };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit));
  return { lovelace: amounts.get("lovelace") ?? BigInt(0), assets, utxoCount: utxos.length };
}

export function formatWalletAda(lovelace: bigint): string {
  const whole = lovelace / BigInt(1000000);
  const fraction = (lovelace % BigInt(1000000)).toString().padStart(6, "0").replace(/0+$/, "");
  return new Intl.NumberFormat("en-US").format(whole) + (fraction ? "." + fraction : "");
}
