import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, rename, writeFile, open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PriceBook } from "../price-book";

const file = path.join(process.cwd(), ".data", "instant-sell-preprod.json");
const bucket = process.env.PRICE_BOOK_BUCKET;
const key = process.env.PRICE_BOOK_KEY || "preprod/instant-sell.json";
const s3 = new S3Client({});
export const storageMode = bucket ? "S3" : "development file";
const empty = (): PriceBook => ({ revision: 0, entries: [], updatedAt: null, updatedBy: null });
function configured() {
  if (!bucket && process.env.NODE_ENV === "production") throw new Error("Configure PRICE_BOOK_BUCKET and AWS_REGION for durable operator prices.");
}
export async function readPriceBook(): Promise<{ book: PriceBook; etag?: string }> {
  configured();
  if (bucket) {
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { book: JSON.parse(await result.Body!.transformToString()), etag: result.ETag };
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return { book: empty() };
      throw error;
    }
  }
  try { return { book: JSON.parse(await readFile(file, "utf8")) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { book: empty() }; throw error; }
}
export async function writePriceBook(book: PriceBook, expectedRevision: number) {
  configured();
  const conflict = () => new Error("Price book changed. Reload before publishing again.");
  if (bucket) {
    const current = await readPriceBook();
    if (current.book.revision !== expectedRevision) throw conflict();
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(book), ContentType: "application/json", ...(current.etag ? { IfMatch: current.etag } : { IfNoneMatch: "*" }) }));
    } catch (error) {
      if ([409, 412].includes((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode || 0)) throw conflict();
      throw error;
    }
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  // Atomic lock and rename also protect concurrent development workers.
  const lock = await open(file + ".lock", "wx").catch(() => { throw conflict(); });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    if ((await readPriceBook()).book.revision !== expectedRevision) throw conflict();
    await writeFile(temporary, JSON.stringify(book));
    await rename(temporary, file);
  } finally {
    await lock.close();
    await unlink(file + ".lock");
    await unlink(temporary).catch(() => undefined);
  }
}
