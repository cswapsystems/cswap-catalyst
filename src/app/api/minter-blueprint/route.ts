import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const blueprint = JSON.parse(await readFile(path.join(process.cwd(), "contracts", "minter", "plutus.json"), "utf8")) as { validators: { title: string; compiledCode: string }[] };
  const validator = blueprint.validators.find((item) => item.title === "multi_nft_policy.multi_oneshot.mint");
  if (!validator) return Response.json({ error: "Minter NFT policy is unavailable." }, { status: 500 });
  return Response.json({ compiledCode: validator.compiledCode });
}
