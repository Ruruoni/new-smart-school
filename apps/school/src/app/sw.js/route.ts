import { serviceWorkerSource } from "@/lib/sw-source";

export const dynamic = "force-static";

/** /sw.js — generated so its cache version is the build id (see lib/sw-source.ts). */
export function GET() {
  return new Response(serviceWorkerSource(process.env.SW_BUILD ?? "dev"), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate", // the browser must re-check the worker on every load so updates roll out
      "service-worker-allowed": "/",
    },
  });
}
