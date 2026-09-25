import type { ReactNode } from "react";
import { SessionProvider } from "@/ui/session";
import { PortalGate } from "@/ui/portal-gate";

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <SessionProvider><PortalGate>{children}</PortalGate></SessionProvider>;
}
