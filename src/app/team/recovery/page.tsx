import ModulePage from "../../_components/module-page";
import FractionalizeForm from "../../_components/fractionalize-form";
export default function Page() { return <ModulePage title="Vault recovery" description="Recovery returns the original asset to its recorded owner. Remaining fractions lose their redemption claim; coordinate registry revocation and liquidity retirement."><FractionalizeForm initialMode="recover" /></ModulePage>; }
