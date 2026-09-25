"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PortalShell } from "./shell";
import { ChildProvider } from "./children";
import { useSession } from "./session";
import type { NavGroup } from "@/lib/nav";

const STUDENT_TABS = [
  { label: "Exams", href: "/student", icon: "grid" as const }, { label: "Practice", href: "/student/practice", icon: "target" as const },
  { label: "Progress", href: "/student/progress", icon: "chart" as const }, { label: "Results", href: "/student/results", icon: "file" as const },
  { label: "More", href: "/student/more", icon: "menu" as const },
];

/** Parents get the family portal; students get the exam hub. Both are the same mobile-first shell. */
export function PortalGate({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const path = usePathname();
  const isStudent = me.user.userType === "STUDENT" || path.startsWith("/student");
  return (
    <PortalShell tabs={isStudent ? STUDENT_TABS : undefined} basePath={isStudent ? "/student" : "/portal"}>
      <ChildProvider>{children}</ChildProvider>
    </PortalShell>
  );
}
export type { NavGroup };
