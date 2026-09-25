import { errorResponse } from "./errors";

/**
 * Wrap an API route so that a failure while LOADING its code (missing configuration, unreachable database at import time)
 * comes back as a structured JSON error the Control Tower's pages can explain, not as a raw framework 500 with an empty body.
 * The handler itself is unchanged and runs exactly as before once it has loaded; this file imports nothing that needs configuration.
 */
export function safeRoute<C>(load: () => Promise<(req: Request, ctx: C) => Promise<Response>>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    let handler: (req: Request, ctx: C) => Promise<Response>;
    try { handler = await load(); } catch (err) { return errorResponse(err); }
    return handler(req, ctx);
  };
}
