export const dynamic = "force-dynamic";

const walletAddressVariables = [
  "NEXT_PUBLIC_ISSUER_WALLET",
  "NEXT_PUBLIC_CUSTODY_WALLET",
  "NEXT_PUBLIC_TREASURY_WALLET",
  "NEXT_PUBLIC_SETTLEMENT_WALLET",
] as const;

type KoiosAddressInfo = { address: string; balance: string };

export async function GET() {
  const addresses = walletAddressVariables
    .map((variable) => process.env[variable])
    .filter((address): address is string => Boolean(address));

  if (addresses.length === 0) return Response.json({ balances: {} });

  const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK === "preprod" ? "preprod" : "mainnet";
  const baseUrl = network === "preprod" ? "https://preprod.koios.rest/api/v1" : "https://api.koios.rest/api/v1";

  try {
    const response = await fetch(`${baseUrl}/address_info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _addresses: addresses }),
      cache: "no-store",
    });

    if (!response.ok) throw new Error(`Koios returned ${response.status}`);

    const data: KoiosAddressInfo[] = await response.json();
    const balances = Object.fromEntries(data.map(({ address, balance }) => [address, balance]));
    return Response.json({ balances }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Unable to fetch wallet balances" }, { status: 502 });
  }
}
