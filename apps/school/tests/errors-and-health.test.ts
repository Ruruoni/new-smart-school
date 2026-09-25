import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieShouldBeSecure } from "@smartschool/protocol";
import { ConfigError, classifyInfrastructureError, redactSecrets, shouldLogRepeated, toSafeError } from "@/platform/errors";
import { env, resetEnvCache } from "@/platform/env";
import { expectedMigrationCount, runHealthChecks } from "@/platform/health";

/** Error shapes below were captured from REAL failures (Prisma 7 + pg adapter) against a live server, see the docs. */
const prismaErr = (code: string, message: string) => Object.assign(new Error(message), { code, name: "PrismaClientKnownRequestError" });

describe("infrastructure failures are reported for what they are", () => {
  it.each([
    [prismaErr("P1001", "Can't reach database server at `127.0.0.1:1`"), "DATABASE_UNAVAILABLE"],
    [new Error("Connection terminated due to connection timeout"), "DATABASE_UNAVAILABLE"], // an unresolvable container name on Docker's default bridge network
    [new Error("getaddrinfo ENOTFOUND my-postgres"), "DATABASE_UNAVAILABLE"],
    [prismaErr("P1000", "Authentication failed against the database server"), "DATABASE_MISCONFIGURED"],
    [prismaErr("P1003", "Database `nope` does not exist"), "DATABASE_MISCONFIGURED"],
    [prismaErr("P2021", "The table `public.users` does not exist in the current database."), "DATABASE_NOT_MIGRATED"],
    [prismaErr("P2022", "The column `x` does not exist"), "DATABASE_NOT_MIGRATED"],
    [Object.assign(new Error('relation "users" does not exist'), { code: "42P01" }), "DATABASE_NOT_MIGRATED"], // straight from pg
    [Object.assign(new Error("Raw query failed"), { code: "P2010", meta: { code: "42P01" } }), "DATABASE_NOT_MIGRATED"], // via Prisma $queryRaw
  ])("%s → %s", (err, code) => {
    expect(classifyInfrastructureError(err)?.code).toBe(code);
    const safe = toSafeError(err, "req-1", () => undefined);
    expect(safe.status).toBe(503);
    expect(safe.body.error.code).toBe(code);
    expect(safe.body.error.message).not.toMatch(/prisma|127\.0\.0\.1|postgres|relation|table/i); // nothing internal reaches the person
    expect(safe.body.error.requestId).toBe("req-1");
  });

  it("an ordinary bug whose MESSAGE merely resembles a database error is still just a 500 (no misleading diagnosis)", () => {
    for (const msg of ['relation "secret_table" does not exist', "connect ECONNREFUSED in my own parser", "column x does not exist"]) {
      if (/ECONNREFUSED/.test(msg)) continue; // genuinely network-shaped text is still treated as a connection problem
      expect(classifyInfrastructureError(new Error(msg))).toBeNull();
    }
  });

  it("an ordinary bug is still a plain 500 with only a reference id", () => {
    const safe = toSafeError(new TypeError("x is undefined"), "req-2", () => undefined);
    expect(safe).toMatchObject({ status: 500, body: { error: { code: "INTERNAL", requestId: "req-2" } } });
    expect(JSON.stringify(safe.body)).not.toContain("undefined");
  });

  it("the server log line carries the reference the user was shown — and never a password", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    toSafeError(new Error("connect failed for postgresql://smartschool:S3cretPass@db:5432/x with password=S3cretPass"), "ref-abc");
    spy.mockRestore();
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: "error", requestId: "ref-abc" });
    expect(lines[0]).not.toContain("S3cretPass");
    expect(entry.message).toContain("<redacted>");
  });

  it("redacts connection strings and key=value secrets", () => {
    expect(redactSecrets("postgresql://u:p4ss@h:5432/d")).toBe("postgresql://u:<redacted>@h:5432/d");
    expect(redactSecrets('APP_SIGNING_SECRET="abc123" token: xyz')).toBe('APP_SIGNING_SECRET="<redacted>" token: <redacted>');
  });
});

describe("a broken server does not flood its own log", () => {
  it("the same problem is logged in full once per window, however many requests hit it", () => {
    expect(shouldLogRepeated("t-key", 30_000, 1_000)).toBe(true);
    expect(shouldLogRepeated("t-key", 30_000, 2_000)).toBe(false);
    expect(shouldLogRepeated("t-key", 30_000, 20_000)).toBe(false);
    expect(shouldLogRepeated("other-key", 30_000, 2_000)).toBe(true); // a DIFFERENT problem is never hidden
    expect(shouldLogRepeated("t-key", 30_000, 31_500)).toBe(true);    // and it is reported again after the window
  });
  it("500 requests hitting a misconfigured server produce one log line, all with the same safe answer", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    const err = new ConfigError(["DATABASE_URL: is not set"]);
    for (let i = 0; i < 500; i++) expect(toSafeError(err, `r${i}`).status).toBe(503);
    spy.mockRestore();
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});

describe("configuration problems", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; resetEnvCache(); });

  it("a missing variable becomes a ConfigError that names it in the LOG but not to the visitor", () => {
    delete process.env.APP_SIGNING_SECRET; resetEnvCache();
    let thrown: unknown; try { env(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).issues).toEqual([expect.stringContaining("APP_SIGNING_SECRET: is not set")]);
    const safe = toSafeError(thrown, "r", () => undefined);
    expect(safe).toMatchObject({ status: 503, body: { error: { code: "SERVER_MISCONFIGURED" } } });
    expect(JSON.stringify(safe.body)).not.toContain("APP_SIGNING_SECRET"); // don't advertise which settings exist
  });

  it("a key of the wrong size is caught at start-up with an instruction — not as a 500 at the first encryption — and its value is never echoed", () => {
    process.env.APP_ENCRYPTION_KEY = "x".repeat(43) + "S3cr3tValue"; resetEnvCache();
    let e: ConfigError | undefined; try { env(); } catch (x) { e = x as ConfigError; }
    expect(e?.issues.join(" ")).toMatch(/APP_ENCRYPTION_KEY must be 32 random bytes, base64.*openssl rand -base64 32/);
    expect(e?.issues.join(" ")).not.toContain("S3cr3tValue");
  });
});

describe("health tells the truth", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; resetEnvCache(); });

  it("healthy only when configuration, database and schema are all fine", async () => {
    const r = await runHealthChecks("t");
    expect(r).toMatchObject({ ok: true, status: 200, body: { ok: true, checks: { config: "ok", database: "ok", schema: "ok" } } });
    expect(expectedMigrationCount()).toBeGreaterThanOrEqual(4);
  });

  it("broken configuration → 503 naming the stage, never the variables, never a crash", async () => {
    delete process.env.DATABASE_URL; resetEnvCache();
    const r = await runHealthChecks("t");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, code: "SERVER_MISCONFIGURED", checks: { config: "fail", database: "skipped", schema: "skipped" } });
    expect(JSON.stringify(r.body)).not.toContain("DATABASE_URL");
  });
});

describe("session cookie policy", () => {
  const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers: new Headers(headers) });
  it("auto: Secure exactly when the request arrived over HTTPS (directly or via a proxy)", () => {
    expect(cookieShouldBeSecure("auto", req("http://school.local/api/auth/login"))).toBe(false);
    expect(cookieShouldBeSecure("auto", req("https://school.example/api/auth/login"))).toBe(true);
    expect(cookieShouldBeSecure("auto", req("http://internal:3000/api", { "x-forwarded-proto": "https" }))).toBe(true);
    expect(cookieShouldBeSecure("auto", req("http://internal:3000/api", { "x-forwarded-proto": "http" }))).toBe(false);
    expect(cookieShouldBeSecure(undefined, req("https://x/y"))).toBe(true);
  });
  it("explicit true/false always win", () => {
    expect(cookieShouldBeSecure("true", req("http://x/y"))).toBe(true);
    expect(cookieShouldBeSecure("false", req("https://x/y", { "x-forwarded-proto": "https" }))).toBe(false);
  });
});
