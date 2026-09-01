export const runtime = "nodejs";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IPFS_API_URL = "https://ipfs.blockfrost.io/api/v0";

type UploadKind = "image" | "proof" | "metadata";
type MediaType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "application/json";

function isUploadKind(value: FormDataEntryValue | null): value is UploadKind {
  return value === "image" || value === "proof" || value === "metadata";
}

function detectImageMediaType(bytes: Uint8Array): MediaType | null {
  const isPng = bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]);
  if (isPng) return "image/png";

  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isJpeg) return "image/jpeg";

  const webpHeader = new TextDecoder().decode(bytes.slice(0, 12));
  if (webpHeader.startsWith("RIFF") && webpHeader.slice(8, 12) === "WEBP") return "image/webp";

  return null;
}

function detectMediaType(kind: UploadKind, bytes: Uint8Array): MediaType | null {
  if (kind === "image") return detectImageMediaType(bytes);
  if (kind === "proof") return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-" ? "application/pdf" : null;

  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? "application/json" : null;
  } catch {
    return null;
  }
}

function safeFilename(name: string, mediaType: MediaType): string {
  const extension = mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : mediaType === "application/pdf" ? "pdf" : "json";
  const stem = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "asset-file";
  return `${stem}.${extension}`;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? fallback;
}

export async function POST(request: Request) {
  const projectId = process.env.BLOCKFROST_IPFS_PROJECT_ID;
  if (!projectId) {
    return Response.json({ error: "IPFS uploads are not configured. Add BLOCKFROST_IPFS_PROJECT_ID to .env.local." }, { status: 503 });
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  const kind = formData?.get("kind") ?? null;
  if (!(file instanceof File) || !isUploadKind(kind)) {
    return Response.json({ error: "Provide an image, proof, or metadata file." }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "Each file must be between 1 byte and 5 MB." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = detectMediaType(kind, bytes);
  if (!mediaType) {
    const description = kind === "image" ? "a valid PNG, JPEG, or WebP image" : kind === "proof" ? "a valid PDF document" : "a valid JSON object";
    return Response.json({ error: `Provide ${description}.` }, { status: 415 });
  }

  const uploadForm = new FormData();
  uploadForm.set("file", new Blob([bytes], { type: mediaType }), safeFilename(file.name, mediaType));
  const uploadResponse = await fetch(`${IPFS_API_URL}/ipfs/add`, {
    method: "POST",
    headers: { project_id: projectId },
    body: uploadForm,
    cache: "no-store",
  });
  if (!uploadResponse.ok) {
    return Response.json({ error: await errorMessage(uploadResponse, "IPFS upload failed.") }, { status: 502 });
  }

  const uploaded = await uploadResponse.json() as { ipfs_hash?: string };
  if (!uploaded.ipfs_hash) {
    return Response.json({ error: "IPFS upload did not return a content identifier." }, { status: 502 });
  }

  const pinResponse = await fetch(`${IPFS_API_URL}/ipfs/pin/add/${encodeURIComponent(uploaded.ipfs_hash)}`, {
    method: "POST",
    headers: { project_id: projectId },
    cache: "no-store",
  });
  if (!pinResponse.ok) {
    return Response.json({ error: await errorMessage(pinResponse, "File was uploaded but could not be pinned to IPFS.") }, { status: 502 });
  }

  return Response.json({ uri: `ipfs://${uploaded.ipfs_hash}`, mediaType }, { headers: { "Cache-Control": "no-store" } });
}
