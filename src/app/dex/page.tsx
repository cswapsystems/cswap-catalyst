import ModulePage from "../_components/module-page";
import DexWorkbench from "../_components/dex-workbench";

export default function DexPage() {
  return <ModulePage title="Swap fractions" description="Review your quote, price impact, and wallet balance before signing a direct AMM swap."><DexWorkbench mode="swap" /></ModulePage>;
}
