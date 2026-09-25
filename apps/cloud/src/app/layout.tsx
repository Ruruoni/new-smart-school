import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Control Tower", template: "%s · SmartSchool Control Tower" }, description: "SmartSchool developer control tower: installations, licences, monitoring.", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f1b24" };

export default function Root({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
