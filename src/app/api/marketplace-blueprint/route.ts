import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowed = new Set([
  "p2p_listing_simple.p2p_listing_simple.spend",
  "p2p_listing.p2p_listing.spend",
  "quote_pool.quote_pool.spend",
  "lp_policy.lp_policy.mint",
]);

export async function GET(request: Request) {
  const title = new URL(request.url).searchParams.get("validator") ?? "";
  if (!allowed.has(title)) return Response.json({ error: "Unknown marketplace validator." }, { status: 400 });
  const blueprint = JSON.parse(await readFile(path.join(process.cwd(), "contracts", "marketplace", "plutus.json"), "utf8")) as { validators: { title: string; compiledCode: string }[] };
  const validator = blueprint.validators.find((item) => item.title === title);
  if (!validator) return Response.json({ error: "Marketplace validator is unavailable." }, { status: 500 });
  return Response.json({ compiledCode: validator.compiledCode });
}
