import ModulePage from "../../_components/module-page";
import DexPoolsDirectory from "../../_components/dex-pools-directory";

export default function PoolsPage() {
  return <ModulePage title="Trading pools" description="Browse every authenticated CSWAP trading pair and compare its current on-chain spot price and liquidity."><DexPoolsDirectory /></ModulePage>;
}
