import type { ReactNode } from "react";
import OperatorGate from "../_components/operator-gate";

export default function TeamLayout({ children }: { children: ReactNode }) {
  return <OperatorGate>{children}</OperatorGate>;
}
