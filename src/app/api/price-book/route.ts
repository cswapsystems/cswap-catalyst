import { NextResponse } from "next/server";
import { marketplaceDeployment } from "@/lib/protocol/marketplace-deployment";
import { priceUpdate } from "@/lib/price-book";
import { verifyPriceSignature } from "@/lib/price-book-auth";
import { readPriceBook, storageMode, writePriceBook } from "@/lib/server/price-book-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  try {
    return NextResponse.json({ book: (await readPriceBook()).book, operatorKey: marketplaceDeployment.batcher, storage: storageMode }, { headers });
  } catch { return NextResponse.json({ error: "Price storage unavailable. Configure PRICE_BOOK_BUCKET, AWS_REGION and server IAM access in production." }, { status: 503, headers }); }
}
export async function PUT(request: Request) {
  try {
    const text = await request.text();
    if (text.length > 100_000) throw new Error("Price book is too large.");
    const body = JSON.parse(text);
    const payload = priceUpdate(marketplaceDeployment.pool.token, body.update?.revision, body.update?.entries, body.update?.issuedAt);
    if (JSON.stringify(body.update) !== JSON.stringify(payload) || Math.abs(Date.now() - payload.issuedAt) > 300_000) throw new Error("Invalid or expired price update. Sign a fresh update.");
    if (!await verifyPriceSignature(body.address, body.signature, payload, marketplaceDeployment.batcher)) {
      return NextResponse.json({ error: "A valid signature from the configured operator wallet is required." }, { status: 403, headers });
    }
    const book = { revision: payload.revision + 1, entries: payload.entries, updatedAt: new Date().toISOString(), updatedBy: body.address as string };
    await writePriceBook(book, payload.revision);
    return NextResponse.json({ book }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to publish prices.";
    const status = message.includes("changed") ? 409 : message.includes("Configure") ? 503 : 400;
    return NextResponse.json({ error: status === 503 ? "Durable price storage is not configured." : message }, { status, headers });
  }
}
