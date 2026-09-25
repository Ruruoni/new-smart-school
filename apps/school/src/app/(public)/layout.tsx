import type { ReactNode } from "react";
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-paper">{children}</div>;
}
