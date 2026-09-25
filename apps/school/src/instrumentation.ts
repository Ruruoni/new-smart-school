/**
 * Runs once when the server starts (not during `next build`). If the configuration is unusable, say so plainly in the server log
 * right now — with the names of what is wrong, never the values — instead of leaving it to surface later as a mysterious error on
 * the first request. The server still starts (it answers requests with an explanatory 503 and reports itself unhealthy).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    (await import("@/platform/env")).env();
  } catch (err) {
    const { logServerError } = await import("@/platform/errors");
    logServerError("startup", err, { check: "config" });
    console.error("[startup] The server's configuration is invalid — see the \"issues\" above. Every request will be answered with an explanatory error until it is fixed and the server restarted.");
  }
}
