import type { ReactNode } from "react";
import PlatformHeader from "./platform-header";

export default function ModulePage({ title, description, children, compact = false }: { title: string; description: string; children: ReactNode; compact?: boolean }) {
  return <div className="platform-shell"><PlatformHeader /><main className="page-main"><section className={compact ? "sr-only" : "hero"}><div><span className="eyebrow">CSWAP · Preprod</span><h1>{title}</h1><p>{description}</p></div></section>{children}</main></div>;
}
