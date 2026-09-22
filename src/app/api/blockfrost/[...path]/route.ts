export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const baseUrl = "https://cardano-preprod.blockfrost.io/api/v0";

async function proxy(request: Request, context: RouteContext<"/api/blockfrost/[...path]">) {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!projectId) return Response.json({ error: "Blockfrost is not configured." }, { status: 503 });
  const { path } = await context.params;
  const incoming = new URL(request.url);
  const endpoint = `${baseUrl}/${path.join("/")}${incoming.search}`;
  try {
  const response = await fetch(endpoint, {
    method: request.method,
    headers: { project_id: projectId, "content-type": request.headers.get("content-type") ?? "application/json" },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
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
