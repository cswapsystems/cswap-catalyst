"use client";
import { useState } from "react";
import ProtocolControls from "./protocol-controls";
import ReservesWorkbench from "./reserves-workbench";
export default function SharedPoolWorkspace() {
  const [revision, setRevision] = useState(0);
  return <><ProtocolControls protocol="shared" onConfirmed={() => setRevision((value) => value + 1)} /><ReservesWorkbench revision={revision} /></>;
}
