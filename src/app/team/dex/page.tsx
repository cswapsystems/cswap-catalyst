import ModulePage from "../../_components/module-page";
import DexBootstrapWorkbench from "../../_components/dex-bootstrap-workbench";
import DexWorkbench from "../../_components/dex-workbench";
import ProtocolControls from "../../_components/protocol-controls";
export default function Page() { return <ModulePage title="DEX administration" description="Factory controls, three-party bootstrap coordination, and pool lifecycle actions for the configured administrator."><ProtocolControls protocol="dex" /><DexBootstrapWorkbench /><DexWorkbench mode="admin" /></ModulePage>; }
