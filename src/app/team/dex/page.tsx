import ModulePage from "../../_components/module-page";
import DexWorkbench from "../../_components/dex-workbench";
import ProtocolControls from "../../_components/protocol-controls";
export default function Page() { return <ModulePage title="DEX administration" description="Factory controls and pool lifecycle actions for the configured administrator."><ProtocolControls protocol="dex" /><DexWorkbench mode="admin" /></ModulePage>; }
