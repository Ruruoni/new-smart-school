import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ToastProvider } from "@/ui/kit";
import { PwaRegister } from "@/ui/pwa";

export const metadata: Metadata = {
  title: { default: "SmartSchool", template: "%s · SmartSchool" },
  description: "School management for Nigerian secondary schools — works on your school's own network, with or without internet.",
  manifest: "/manifest.webmanifest",
  applicationName: "SmartSchool",
  appleWebApp: { capable: true, title: "SmartSchool", statusBarStyle: "black-translucent" },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }], apple: [{ url: "/icon-192.png", sizes: "192x192" }] },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f1b24" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NG">
      <body>
        <ToastProvider>{children}</ToastProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
