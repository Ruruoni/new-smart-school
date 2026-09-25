"use client";
import { ChildSelector, useChild } from "@/ui/children";
import { MyTimetable } from "@/ui/my-timetable";

export default function PortalTimetable() {
  const { child } = useChild();
  if (!child) return null;
  return <div className="space-y-4"><ChildSelector /><MyTimetable key={child.id} studentId={child.id} /></div>;
}
