import ModulePage from "../_components/module-page";
import ProtocolStatistics from "../_components/protocol-statistics";
export default function ProtocolPage() {
  return <ModulePage title="Protocol" description="Public statistics for the configured CSWAP Preprod deployments. No wallet connection required."><ProtocolStatistics /></ModulePage>;
}
