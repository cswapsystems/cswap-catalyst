import ModulePage from "../../_components/module-page";
import PriceBookPanel from "../../_components/price-book-panel";
export default function InventoryPage() {
  return <ModulePage title="Inventory & prices" description="Manage the operator price book, acquisition limits and shared pool inventory."><PriceBookPanel /></ModulePage>;
}
