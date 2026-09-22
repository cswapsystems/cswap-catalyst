import type { PriceUpdate } from "./price-book";
import type { SignedMessage } from "@lucid-evolution/lucid";

export async function verifyPriceSignature(address: string, signature: SignedMessage, update: PriceUpdate, operatorKey: string): Promise<boolean> {
  try {
    const tools = await import("@lucid-evolution/lucid");
    const details = tools.getAddressDetails(address);
    return details.networkId === 0 && details.paymentCredential?.type === "Key" && details.paymentCredential.hash === operatorKey && tools.verifyData(details.address.hex, operatorKey, tools.fromText(JSON.stringify(update)), signature);
  } catch { return false; }
}
