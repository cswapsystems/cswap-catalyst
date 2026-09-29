import AssetPlatform from "../_components/asset-platform";

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ asset?: string }> }) {
  const query = await searchParams;
  return <AssetPlatform initialAssetId={typeof query.asset === "string" ? query.asset : ""} />;
}
