// Anyone can pin arbitrary bytes to IPFS, and the gateway route serves them
// from the app origin. Never trust the upstream content type: HTML/SVG/JS would
// run with access to the connected wallet. Only the media types accepted by the
// upload route are recognised, by magic bytes; everything else is a download.
export type GatewayMedia = { type: string; inline: boolean };

const signatures: { media: GatewayMedia; bytes: (number | null)[] }[] = [
  { media: { type: "image/png", inline: true }, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { media: { type: "image/jpeg", inline: true }, bytes: [0xff, 0xd8, 0xff] },
  { media: { type: "image/webp", inline: true }, bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
  { media: { type: "application/pdf", inline: false }, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

export function sniffGatewayMedia(head: Uint8Array): GatewayMedia | null {
  return signatures.find(({ bytes }) => head.length >= bytes.length && bytes.every((byte, index) => byte === null || head[index] === byte))?.media ?? null;
}

export function gatewayHeaders(cid: string, media: GatewayMedia | null): Record<string, string> {
  return {
    "content-type": media?.type ?? "application/octet-stream",
    "content-disposition": media?.inline ? "inline" : `attachment; filename="${cid}"`,
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=31536000, immutable",
  };
}
