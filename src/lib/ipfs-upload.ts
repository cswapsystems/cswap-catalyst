export type UploadKind = "image" | "proof" | "metadata";
export type MediaType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "application/json";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
// One file plus the "kind" field; the overhead covers multipart boundaries, headers and the filename.
export const MAX_UPLOAD_FIELDS = 2;
export const MAX_UPLOAD_BYTES = MAX_FILE_BYTES + 16 * 1024;

export function isUploadKind(value: unknown): value is UploadKind {
  return value === "image" || value === "proof" || value === "metadata";
}

// Checked before request.formData() so oversized or unsized bodies are never buffered.
export function uploadLengthError(contentLength: string | null): { error: string; status: number } | null {
  if (contentLength === null || !/^\d+$/.test(contentLength)) return { error: "Content-Length is required.", status: 411 };
  if (Number(contentLength) > MAX_UPLOAD_BYTES) return { error: "Each file must be between 1 byte and 5 MB.", status: 413 };
  return null;
}

export function hasAllowedUploadFields(form: FormData): boolean {
  let count = 0;
  for (const [name] of form) if (++count > MAX_UPLOAD_FIELDS || (name !== "file" && name !== "kind")) return false;
  return true;
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

export function detectMediaType(kind: UploadKind, bytes: Uint8Array, isManifest: (value: unknown) => boolean): MediaType | null {
  if (kind === "image") return detectImageMediaType(bytes);
  if (kind === "proof") return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-" ? "application/pdf" : null;

  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return isManifest(value) ? "application/json" : null;
  } catch {
    return null;
  }
}

export function safeFilename(name: string, mediaType: MediaType): string {
  const extension = mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : mediaType === "application/pdf" ? "pdf" : "json";
  const stem = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "asset-file";
  return `${stem}.${extension}`;
}
