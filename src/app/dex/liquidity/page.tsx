import ModulePage from "../../_components/module-page";
import DexWorkbench from "../../_components/dex-workbench";
export default function Page() { return <ModulePage title="DEX liquidity" description="Review your LP shares and both sides of a deposit or withdrawal."><DexWorkbench mode="liquidity" /></ModulePage>; }
