import type { ReactNode } from "react";
import { ExamGate } from "@/ui/exam-gate";

/** Exam pages have no navigation chrome: nothing to distract, nothing to click away to. */
export default function ExamLayout({ children }: { children: ReactNode }) {
  return <ExamGate>{children}</ExamGate>;
}
