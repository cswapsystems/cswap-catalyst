import { detectMediaType, hasAllowedUploadFields, isUploadKind, MAX_FILE_BYTES, safeFilename, uploadLengthError } from "@/lib/ipfs-upload";
import { isRwaManifestDocument } from "@/lib/rwa-metadata";

export const runtime = "nodejs";

const IPFS_API_URL = "https://ipfs.blockfrost.io/api/v0";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? fallback;
}

export async function POST(request: Request) {
  const projectId = process.env.BLOCKFROST_IPFS_PROJECT_ID;
  if (!projectId) {
    return Response.json({ error: "IPFS uploads are not configured. Add BLOCKFROST_IPFS_PROJECT_ID to .env.local." }, { status: 503 });
  }

  const lengthError = uploadLengthError(request.headers.get("content-length"));
  if (lengthError) return Response.json({ error: lengthError.error }, { status: lengthError.status });

  const formData = await request.formData().catch(() => null);
  if (formData && !hasAllowedUploadFields(formData)) {
    return Response.json({ error: "Upload exactly one file and its kind." }, { status: 400 });
  }
  const file = formData?.get("file");
  const kind = formData?.get("kind") ?? null;
  if (!(file instanceof File) || !isUploadKind(kind)) {
    return Response.json({ error: "Provide an image, proof, or metadata file." }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "Each file must be between 1 byte and 5 MB." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = detectMediaType(kind, bytes, isRwaManifestDocument);
  if (!mediaType) {
    const description = kind === "image" ? "a valid PNG, JPEG, or WebP image" : kind === "proof" ? "a valid PDF document" : "a valid cswap.rwa-manifest/v1 JSON document";
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
