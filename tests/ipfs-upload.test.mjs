import assert from "node:assert/strict";
import test from "node:test";
import { detectMediaType, hasAllowedUploadFields, MAX_UPLOAD_BYTES, safeFilename, uploadLengthError } from "../src/lib/ipfs-upload.ts";

test("Content-Length is required and capped before parsing", () => {
  assert.equal(uploadLengthError(null)?.status, 411);
  assert.equal(uploadLengthError("abc")?.status, 411);
  assert.equal(uploadLengthError(String(MAX_UPLOAD_BYTES + 1))?.status, 413);
  assert.equal(uploadLengthError(String(MAX_UPLOAD_BYTES)), null);
});

test("form must hold only one file and its kind", () => {
  const form = new FormData();
  form.set("file", new Blob(["x"]), "a.png");
  form.set("kind", "image");
  assert.equal(hasAllowedUploadFields(form), true);
  form.append("file", new Blob(["y"]), "b.png");
  assert.equal(hasAllowedUploadFields(form), false);
  const extra = new FormData();
  extra.set("other", "1");
  assert.equal(hasAllowedUploadFields(extra), false);
});

test("magic bytes decide the media type", () => {
  const never = () => false;
  assert.equal(detectMediaType("image", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), never), "image/png");
  assert.equal(detectMediaType("image", new Uint8Array([0xff, 0xd8, 0xff]), never), "image/jpeg");
  assert.equal(detectMediaType("image", new TextEncoder().encode("RIFF0000WEBP"), never), "image/webp");
  assert.equal(detectMediaType("image", new TextEncoder().encode("<svg/>"), never), null);
  assert.equal(detectMediaType("proof", new TextEncoder().encode("%PDF-1.7"), never), "application/pdf");
  assert.equal(detectMediaType("proof", new TextEncoder().encode("<html>"), never), null);
  assert.equal(detectMediaType("metadata", new TextEncoder().encode("{}"), () => true), "application/json");
  assert.equal(detectMediaType("metadata", new TextEncoder().encode("{}"), never), null);
  assert.equal(detectMediaType("metadata", new TextEncoder().encode("not json"), () => true), null);
  assert.equal(safeFilename("../evil name.svg", "image/png"), "-evil-name.png");
});
