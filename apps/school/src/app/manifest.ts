import type { MetadataRoute } from "next";

/** Installable on Android (192 + 512 PNG, plus a maskable icon with its artwork inside the safe zone) and iOS ("Add to Home Screen"). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: "SmartSchool", short_name: "SmartSchool", description: "School management that works on your own network.",
    start_url: "/", scope: "/", display: "standalone", background_color: "#f4f7f6", theme_color: "#0f1b24",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
