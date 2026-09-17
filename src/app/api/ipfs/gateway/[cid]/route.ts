export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CID_PATTERN = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/;
const gateways = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];

export async function GET(_request: Request, context: RouteContext<"/api/ipfs/gateway/[cid]">) {
  const { cid } = await context.params;
  if (!CID_PATTERN.test(cid)) return new Response("Invalid IPFS content identifier.", { status: 400 });

  for (const gateway of gateways) {
    try {
      const response = await fetch(gateway + cid, { cache: "force-cache" });
      if (!response.ok || !response.body) continue;
      return new Response(response.body, {
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      // Try the next gateway; the CID makes every successful response immutable.
    }
  }
  return new Response("IPFS content is unavailable.", { status: 502 });
}
