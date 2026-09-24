import { readFile } from "node:fs/promises";
import path from "node:path";
export const runtime = "nodejs";
export async function GET() {
  // Pinned historical script; deriving the old address from today's blueprint
  // would hide existing requests. This endpoint is for owner cancellation only.
  const archive = JSON.parse(await readFile(path.join(process.cwd(), "contracts/marketplace/legacy-request-recovery.json"), "utf8"));
  return Response.json(archive);
}
