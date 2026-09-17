export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CID_PATTERN = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/;

export async function GET(_request: Request, context: RouteContext<"/api/ipfs/gateway/[cid]">) {
  const { cid } = await context.params;
  if (!CID_PATTERN.test(cid)) return new Response("Invalid IPFS content identifier.", { status: 400 });

  const response = await fetch(`https://ipfs.io/ipfs/${cid}`, { cache: "force-cache" });
  if (!response.ok) return new Response("IPFS content is unavailable.", { status: response.status });

  return new Response(response.body, {
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
