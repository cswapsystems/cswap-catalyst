import ModulePage from "../_components/module-page";
import FractionalizeForm from "../_components/fractionalize-form";

export default async function FractionalizePage({ searchParams }: { searchParams: Promise<{ asset?: string; mode?: string }> }) {
  const query = await searchParams;
  const asset = typeof query.asset === "string" && /^[0-9a-f]{56,120}$/.test(query.asset) && query.asset.length % 2 === 0 ? query.asset : "";
  return <ModulePage title="Manage fractional ownership" description="Split an original asset or combine its full fraction supply."><FractionalizeForm initialAssetUnit={asset} initialMode={query.mode === "combine" ? "combine" : "split"} /></ModulePage>;
}
