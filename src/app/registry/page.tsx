import RegistryWorkbench from "../_components/registry-workbench";
import OperatorGate from "../_components/operator-gate";

export default function RegistryPage() {
  return <OperatorGate><RegistryWorkbench audience="operator" /></OperatorGate>;
}
