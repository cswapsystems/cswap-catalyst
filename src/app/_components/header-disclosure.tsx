"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

// These are ordinary navigation links, not an ARIA application menu.
export default function HeaderDisclosure({ label, children, active = false }: { label: ReactNode; children: ReactNode; active?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, []);
  return <details key={pathname} ref={ref} className="header-disclosure" onKeyDown={event => {
    if (event.key === "Escape" && ref.current?.open) {
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
      event.stopPropagation();
    }
  }}>
    <summary className={active ? "is-active" : undefined}>{label}<span aria-hidden="true" className="disclosure-chevron">⌄</span></summary>
    <div className="header-disclosure-panel" onClick={event => {
      if (event.target instanceof Element && event.target.closest("a") && ref.current) ref.current.open = false;
    }}>{children}</div>
  </details>;
}
