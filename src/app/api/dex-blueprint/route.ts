import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const blueprint = JSON.parse(await readFile(path.join(process.cwd(), "contracts", "dex", "plutus.json"), "utf8")) as { validators: { title: string; compiledCode: string }[] };
  const deployment = await readFile(path.join(process.cwd(), "dex-deployment.preprod.json"), "utf8").then(JSON.parse).catch(() => null);
  return Response.json({ validators: Object.fromEntries(blueprint.validators.map((validator) => [validator.title, validator.compiledCode])), deployment });
}
