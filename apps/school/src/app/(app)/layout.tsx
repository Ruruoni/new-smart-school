import type { ReactNode } from "react";
import { SessionProvider } from "@/ui/session";
import { StaffShell } from "@/ui/shell";

export default function StaffLayout({ children }: { children: ReactNode }) {
  return <SessionProvider><StaffShell>{children}</StaffShell></SessionProvider>;
}
