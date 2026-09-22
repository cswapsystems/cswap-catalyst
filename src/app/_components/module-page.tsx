import type { ReactNode } from "react";
import PlatformHeader from "./platform-header";

export default function ModulePage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="platform-shell"><PlatformHeader /><main className="page-main"><section className="hero"><div><span className="eyebrow">CSWAP · Preprod</span><h1>{title}</h1><p>{description}</p></div></section>{children}</main></div>;
}
