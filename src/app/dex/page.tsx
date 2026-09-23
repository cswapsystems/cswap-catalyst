import ModulePage from "../_components/module-page";
import DexWorkbench from "../_components/dex-workbench";

export default function DexPage() {
  return <ModulePage compact title="Swap tokens" description="Swap between tADA and RWA fraction tokens, or other available pool pairs."><DexWorkbench mode="swap" /></ModulePage>;
}
