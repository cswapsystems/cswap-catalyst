import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowed = new Set([
  "marketplace_listing_escrow.marketplace_listing_escrow.spend",
  "shared_reserve_pool.shared_reserve_pool.spend",
  "pool_share_policy.pool_share_policy.mint",
  "pool_inventory_receipt_policy.pool_inventory_receipt_policy.mint",
  "one_shot.one_shot.mint",
]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const title = params.get("validator") ?? "";
  if (!allowed.has(title)) return Response.json({ error: "Unknown marketplace validator." }, { status: 400 });
  const scriptHash = params.get("scriptHash") ?? "";
  if (title === "marketplace_listing_escrow.marketplace_listing_escrow.spend" && scriptHash === "e8ec60e7c858bc7eadfc7e49cecd4acd970f15316c31dcb0cdef12fd") {
    const legacy = JSON.parse(await readFile(path.join(process.cwd(), "contracts", "marketplace", "legacy-p2p-listing-simple.json"), "utf8")) as { compiledCode?: string };
    if (!legacy.compiledCode) return Response.json({ error: "Legacy Marketplace validator is unavailable." }, { status: 500 });
    return Response.json({ compiledCode: legacy.compiledCode });
  }
  const blueprint = JSON.parse(await readFile(path.join(process.cwd(), "contracts", "marketplace", "plutus.json"), "utf8")) as { validators: { title: string; compiledCode: string }[] };
  const validator = blueprint.validators.find((item) => item.title === title);
  if (!validator) return Response.json({ error: "Marketplace validator is unavailable." }, { status: 500 });
  return Response.json({ compiledCode: validator.compiledCode });
}
