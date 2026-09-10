import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const blueprint = JSON.parse(await readFile(path.join(process.cwd(), "contracts/marketplace/plutus.json"), "utf8")) as { validators: { title: string; compiledCode: string }[] };
    const registry = blueprint.validators.find((v) => v.title === "asset_registry.asset_registry.spend");
    const identity = blueprint.validators.find((v) => v.title === "one_shot.one_shot.mint");
    if (!registry || !identity) throw new Error("Missing registry validators");
    return Response.json({ registry: registry.compiledCode, identity: identity.compiledCode });
  } catch {
    return Response.json({ error: "Registry blueprint unavailable. Build the marketplace contracts." }, { status: 503 });
  }
}
