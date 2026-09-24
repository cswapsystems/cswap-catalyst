import { blockfrostPostLimit, blockfrostQuery, isAllowedBlockfrostRequest } from "@/lib/blockfrost-allowlist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const baseUrl = "https://cardano-preprod.blockfrost.io/api/v0";

async function proxy(request: Request, context: RouteContext<"/api/blockfrost/[...path]">) {
  const { path } = await context.params;
  if (!isAllowedBlockfrostRequest(request.method, path)) return Response.json({ error: "Not found." }, { status: 404 });
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!projectId) return Response.json({ error: "Blockfrost is not configured." }, { status: 503 });
  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const limit = blockfrostPostLimit(path);
    const declared = Number(request.headers.get("content-length"));
    if (!request.headers.has("content-length") || !Number.isSafeInteger(declared)) return Response.json({ error: "Content-Length is required." }, { status: 411 });
    if (declared > limit) return Response.json({ error: "Request body is too large." }, { status: 413 });
    body = await request.arrayBuffer();
    if (body.byteLength > limit) return Response.json({ error: "Request body is too large." }, { status: 413 });
  }
  const endpoint = `${baseUrl}/${path.join("/")}${blockfrostQuery(new URL(request.url).searchParams)}`;
  try {
  const response = await fetch(endpoint, {
    method: request.method,
    headers: { project_id: projectId, "content-type": request.headers.get("content-type") ?? "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  return new Response(await response.arrayBuffer(), { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
  } catch {
    return Response.json({ error: "Chain provider is temporarily unreachable. Retry shortly." }, { status: 503 });
  }
}

export const GET = proxy;
export const POST = proxy;
