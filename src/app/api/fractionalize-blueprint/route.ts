import { readFile } from "node:fs/promises";
import path from "node:path";
import { marketplaceTeamKey } from "@/lib/protocol/marketplace-deployment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const blueprint = JSON.parse(await readFile(path.join(process.cwd(), "contracts", "minter", "plutus.json"), "utf8")) as { validators: { title: string; compiledCode: string }[] };
  const ftPolicy = blueprint.validators.find((item) => item.title === "ft_policy.ft_oneshot.mint");
  const vault = blueprint.validators.find((item) => item.title === "vault.vault.spend");
  if (!ftPolicy || !vault) return Response.json({ error: "Fractionalization validators are unavailable." }, { status: 500 });
  const recoveryAdmin = marketplaceTeamKey;
  return Response.json({ ftCompiledCode: ftPolicy.compiledCode, vaultCompiledCode: vault.compiledCode, recoveryAdmin });
}
