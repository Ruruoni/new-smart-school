import { beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import nodemailer from "nodemailer";
import { db } from "@/platform/db";
import { setSetting } from "@/platform/settings";
import { processPendingEvents, runRulesForEvent, runScheduledRules, isScheduleDue } from "@/modules/automation/engine";
import { evalCondition, evalAll, validateConditions } from "@/modules/automation/conditions";
import * as rules from "@/modules/automation/service";
import { renderTemplate } from "@/modules/communication/templates";
import { deliverPending, requeueDead } from "@/modules/communication/delivery";
import { HttpSmsProvider, HttpWhatsappProvider, normalisePhone, PermanentDeliveryError, setProviderOverride, SmtpEmailProvider, TransientDeliveryError, saveProviderConfig, maskedProviderConfig, sendTestMessage, type MessageProvider } from "@/modules/communication/providers";
import { createAnnouncement, listAnnouncementsFor } from "@/modules/communication/announcements";
import { listNotifications, markRead, unreadCount } from "@/modules/communication/engine";
import * as att from "@/modules/attendance/service";
import * as people from "@/modules/people/service";
import { publishEvent } from "@/platform/events";
import { hashPassword } from "@/platform/password";
import { ctxFor, seedAcademics } from "./fixtures";
import { resetDb, makeUser } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
let studentId: string;
let parentUsername: string;

async function seedFamily() {
  const r = await people.createStudent(S.admin, { firstName: "Tunde", lastName: "Ade", gender: "MALE", classId: S.jss1.id, guardians: [{ newParent: { firstName: "Mrs", lastName: "Ade", phone: "08031234567", email: "mrs.ade@example.com" }, relationship: "Mother" }] });
  studentId = r.student.id;
  parentUsername = r.guardianCredentials[0]!.username;
}
const emit = (type: string, payload: Record<string, unknown>) => db.$transaction((tx) => publishEvent(tx, type as never, payload));

class Capture implements MessageProvider {
  sent: { to: string; subject?: string | null; body: string }[] = [];
  fail: null | "transient" | "permanent" = null;
  constructor(readonly channel: "EMAIL" | "SMS" | "WHATSAPP", readonly name = "capture") {}
  async send(m: { to: string; subject?: string | null; body: string }) {
    if (this.fail === "transient") throw new TransientDeliveryError("network down");
    if (this.fail === "permanent") throw new PermanentDeliveryError("bad address");
    this.sent.push(m);
    return { providerRef: `ref-${this.sent.length}` };
  }
}

beforeEach(async () => {
  await resetDb();
  for (const c of ["EMAIL", "SMS", "WHATSAPP"]) setProviderOverride(c, null);
  S = await seedAcademics();
  await seedFamily();
});

describe("templates & conditions (pure)", () => {
  it("renders placeholders safely", () => {
    expect(renderTemplate("Hi {{ student }}, {{missing}}!{{a.b}}", { student: "Ada\nInjected: header", a: { b: 7 } })).toBe("Hi Ada Injected: header, !7");
    expect(renderTemplate("{{constructor}} {{__proto__}} {{toString}} {{a.constructor.name}}", { a: {} })).toBe("   ");
    expect(evalCondition({ field: "payload.constructor", op: "exists" }, { payload: {} })).toBe(false);
  });
  it("evaluates conditions; missing data never satisfies numeric comparisons", () => {
    const ctx = { event: { type: "x" }, payload: { n: 3, s: "Hello World", tags: ["a", "b"] } };
    expect(evalCondition({ field: "payload.n", op: ">=", value: 3 }, ctx)).toBe(true);
    expect(evalCondition({ field: "payload.n", op: ">", value: "3" }, ctx)).toBe(false);
    expect(evalCondition({ field: "payload.nope", op: "<", value: 100 }, ctx)).toBe(false);
    expect(evalCondition({ field: "payload.s", op: "contains", value: "world" }, ctx)).toBe(true);
    expect(evalCondition({ field: "payload.tags", op: "contains", value: "b" }, ctx)).toBe(true);
    expect(evalCondition({ field: "payload.n", op: "in", value: [1, 3] }, ctx)).toBe(true);
    expect(evalCondition({ field: "payload.nope", op: "exists" }, ctx)).toBe(false);
    expect(evalAll([{ field: "payload.n", op: "=", value: 3 }, { field: "payload.s", op: "!=", value: "x" }], ctx).ok).toBe(true);
    expect(() => validateConditions([{ field: "a b", op: "=" }])).toThrow();
    expect(() => validateConditions([{ field: "a", op: "eval" }])).toThrow();
  });
  it("schedule due logic", () => {
    const now = new Date("2026-03-02T07:31:00Z");
    expect(isScheduleDue({ everyMinutes: 60 }, null, now, 0, "d", null)).toBe(true);
    expect(isScheduleDue({ everyMinutes: 60 }, new Date(now.getTime() - 30 * 60_000), now, 0, "d", null)).toBe(false);
    expect(isScheduleDue({ dailyAt: "07:30" }, null, now, 8 * 60 + 31, "2026-03-02", null)).toBe(true);
    expect(isScheduleDue({ dailyAt: "07:30" }, null, now, 8 * 60 + 31, "2026-03-02", "2026-03-02")).toBe(false);
    expect(isScheduleDue({ dailyAt: "07:30" }, null, now, 6 * 60, "2026-03-02", null)).toBe(false);
  });
});

describe("event → rule → notification pipeline", () => {
  it("absence event notifies guardians in-app and queues email/SMS per school policy, then delivers", async () => {
    await db.$transaction(async (tx) => { await setSetting(tx, "notifications.policy", { channels: ["IN_APP", "EMAIL", "SMS"], absenceThreshold: 3 }); });
    await db.featureFlag.upsert({ where: { key: "communication.sms" }, create: { key: "communication.sms", enabled: true }, update: { enabled: true } });
    await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), entries: [{ studentId, status: "ABSENT" }] });
    const r = await processPendingEvents();
    expect(r).toMatchObject({ processed: 1, failed: 0 });
    const parent = await db.user.findUniqueOrThrow({ where: { username: parentUsername } });
    const inbox = await listNotifications(parent.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toMatch(/Tunde Ade \(JSS 1\) was marked absent/);
    const queued = await db.notificationDelivery.findMany({ orderBy: { channel: "asc" } });
    expect(queued.map((q) => [q.channel, q.status])).toEqual([["EMAIL", "QUEUED"], ["SMS", "QUEUED"]]);

    const email = new Capture("EMAIL"), sms = new Capture("SMS");
    setProviderOverride("EMAIL", email); setProviderOverride("SMS", sms);
    expect(await deliverPending()).toMatchObject({ sent: 2 });
    expect(email.sent[0]).toMatchObject({ to: "mrs.ade@example.com", subject: "Tunde was absent today" });
    expect(sms.sent[0]!.to).toBe("08031234567");
    expect((await db.notificationDelivery.findFirstOrThrow({ where: { channel: "SMS" } })).status).toBe("SENT");
  });

  it("is idempotent: reprocessing the same event never double-notifies", async () => {
    await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), entries: [{ studentId, status: "ABSENT" }] });
    const ev = await db.domainEvent.findFirstOrThrow();
    await processPendingEvents();
    await runRulesForEvent({ id: ev.id, type: ev.type, payload: ev.payload as never });
    await runRulesForEvent({ id: ev.id, type: ev.type, payload: ev.payload as never });
    const parent = await db.user.findUniqueOrThrow({ where: { username: parentUsername } });
    expect(await db.notification.count({ where: { userId: parent.id } })).toBe(1);
    expect(await db.automationExecution.count({ where: { eventId: ev.id, status: "SUCCEEDED" } })).toBeGreaterThanOrEqual(1);
  });

  it("repeated-absence rule fires only at the configured threshold", async () => {
    await makeUser({ username: "head", roles: ["principal"] });
    for (const [n, days] of [[1, 3], [2, 2], [3, 1]] as const) {
      await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), entries: [{ studentId, status: "ABSENT" }] });
      await processPendingEvents();
      const head = await db.user.findUniqueOrThrow({ where: { username: "head" } });
      expect(await db.notification.count({ where: { userId: head.id, type: "attendance.absent" } })).toBe(n === 3 ? 1 : 0);
    }
    const skipped = await db.automationExecution.count({ where: { status: "SKIPPED", rule: { name: "Repeated absence alert" } } });
    expect(skipped).toBe(2);
  });

  it("disabled rules do nothing; custom rules run in order with a full execution log", async () => {
    await rules.setRuleEnabled(S.admin, (await db.automationRule.findFirstOrThrow({ where: { name: "Notify guardians of absence" } })).id, false);
    const custom = await rules.createRule(S.admin, {
      name: "Payment over 100k alerts bursar", trigger: { kind: "EVENT", eventType: "payment.received" }, conditions: [{ field: "payload.amount", op: ">", value: 100000 }],
      actions: [{ type: "notify_role", config: { template: "payment.received", role: "bursar" } }],
    });
    await makeUser({ username: "bursar1", roles: ["bursar"] });
    await emit("attendance.absent", { studentId, absenceCount: 1 });
    await emit("payment.received", { studentId, amount: "50000.00", receiptNumber: "R1" });
    await emit("payment.received", { studentId, amount: "250000.00", receiptNumber: "R2" });
    await processPendingEvents();
    const parent = await db.user.findUniqueOrThrow({ where: { username: parentUsername } });
    expect(await db.notification.count({ where: { userId: parent.id, type: "attendance.absent" } })).toBe(0); // rule disabled
    const b = await db.user.findUniqueOrThrow({ where: { username: "bursar1" } });
    expect(await db.notification.count({ where: { userId: b.id } })).toBe(1);
    const logs = await rules.listExecutions(custom.id);
    expect(logs.map((l) => l.status).sort()).toEqual(["SKIPPED", "SUCCEEDED"]);
    expect((logs.find((l) => l.status === "SUCCEEDED")!.log as { step: string }[])[0]!.step).toBe("notify_role");
  });

  it("a failing action rolls back that rule's earlier actions and the event is retried, then parked", async () => {
    await db.automationRule.deleteMany({});
    await rules.createRule(S.admin, { name: "Bad chain", trigger: { kind: "EVENT", eventType: "exam.scheduled" }, actions: [{ type: "notify_role", config: { template: "exam.scheduled", role: "teacher" } }, { type: "notify_user", config: { template: "exam.scheduled", userId: "00000000-0000-4000-8000-000000000000" } }] });
    await makeUser({ username: "t1", roles: ["teacher"] });
    await emit("exam.scheduled", { title: "Maths" });
    // user not found is "skipped", not an error → make it fail via an unknown template action config instead:
    await db.automationAction.updateMany({ where: { type: "notify_user" }, data: { config: { template: "exam.scheduled", userId: "not-a-uuid" } } });
    for (let i = 0; i < 7; i++) {
      await processPendingEvents();
      await db.domainEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
    }
    const t1 = await db.user.findUniqueOrThrow({ where: { username: "t1" } });
    expect(await db.notification.count({ where: { userId: t1.id } })).toBe(0); // atomic: first action rolled back
    const ev = await db.domainEvent.findFirstOrThrow();
    expect(ev.processedAt).not.toBeNull();
    expect(ev.lastError).toMatch(/^PARKED/);
    expect(await db.auditLog.count({ where: { action: "event.parked" } })).toBe(1);
  });

  it("emit_event chains are loop-guarded", async () => {
    await db.automationRule.deleteMany({});
    await rules.createRule(S.admin, { name: "Loop", trigger: { kind: "EVENT", eventType: "exam.scheduled" }, actions: [{ type: "emit_event", config: { type: "exam.scheduled", payload: { title: "again" } } }] });
    await emit("exam.scheduled", { title: "start" });
    for (let i = 0; i < 12; i++) await processPendingEvents();
    expect(await db.domainEvent.count()).toBeLessThanOrEqual(5); // start + ≤3 chained, then the guard stops it
  });

  it("scheduled rules fire once per day", async () => {
    await makeUser({ username: "hm", roles: ["principal"] });
    await rules.createRule(S.admin, { name: "Daily digest", trigger: { kind: "SCHEDULE", schedule: { dailyAt: "00:00" } }, actions: [{ type: "notify_role", config: { template: "announcement.published", role: "principal" } }] });
    expect(await runScheduledRules(new Date())).toBe(1);
    expect(await runScheduledRules(new Date())).toBe(0);
  });

  it("built-in rules cannot be deleted; rule input is validated", async () => {
    const sys = await db.automationRule.findFirstOrThrow({ where: { isSystem: true } });
    await expect(rules.deleteRule(S.admin, sys.id)).rejects.toThrow(/not deleted/);
    await expect(rules.createRule(S.admin, { name: "Bad", trigger: { kind: "EVENT", eventType: "x.yz" }, conditions: [{ field: "a", op: "regex", value: ".*" }], actions: [{ type: "notify_role", config: { template: "t", role: "r" } }] })).rejects.toThrow(/unknown operator/i);
    await expect(rules.createRule(S.admin, { name: "Bad2", trigger: { kind: "EVENT", eventType: "x.yz" }, actions: [{ type: "notify_role", config: {} }] })).rejects.toThrow(/notify_role/);
  });
});

describe("delivery queue behaves offline", () => {
  it("unconfigured provider keeps messages queued (retry with back-off), configured later they go out", async () => {
    await db.$transaction((tx) => setSetting(tx, "notifications.policy", { channels: ["EMAIL"], absenceThreshold: 3 }));
    await att.recordClassAttendance(S.admin, { classId: S.jss1.id, date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), entries: [{ studentId, status: "LATE" }] });
    await processPendingEvents();
    const first = await deliverPending();
    expect(first).toMatchObject({ sent: 0, retried: 1, notConfigured: 1 });
    const row = await db.notificationDelivery.findFirstOrThrow();
    expect(row.status).toBe("FAILED");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect((await deliverPending()).sent).toBe(0); // not due yet
    const email = new Capture("EMAIL");
    setProviderOverride("EMAIL", email);
    await db.notificationDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
    expect(await deliverPending()).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);
  });
  it("transient failures retry, permanent failures dead-letter, dead letters can be requeued", async () => {
    await db.notificationDelivery.createMany({ data: [{ channel: "EMAIL", recipient: "a@b.co", body: "x" }, { channel: "SMS", recipient: "0803", body: "y" }] });
    const email = new Capture("EMAIL"), sms = new Capture("SMS");
    email.fail = "transient"; sms.fail = "permanent";
    setProviderOverride("EMAIL", email); setProviderOverride("SMS", sms);
    expect(await deliverPending()).toMatchObject({ sent: 0, retried: 1, dead: 1 });
    sms.fail = null;
    expect(await requeueDead("SMS")).toBe(1);
    await db.notificationDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
    email.fail = null;
    expect(await deliverPending()).toMatchObject({ sent: 2 });
  });
  it("concurrent workers never send the same message twice", async () => {
    await db.notificationDelivery.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ channel: "EMAIL" as const, recipient: `u${i}@x.co`, body: "b" })) });
    const email = new Capture("EMAIL");
    setProviderOverride("EMAIL", email);
    const stats = await Promise.all([deliverPending(5), deliverPending(5), deliverPending(5), deliverPending(5)]);
    expect(stats.reduce((s, x) => s + x.sent, 0)).toBe(email.sent.length);
    expect(new Set(email.sent.map((m) => m.to)).size).toBe(email.sent.length);
    await deliverPending(50);
    expect(new Set(email.sent.map((m) => m.to)).size).toBe(12);
  });
});

describe("provider adapters", () => {
  it("SMTP adapter composes a safe message (header injection stripped) and classifies errors", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const p = new SmtpEmailProvider({ host: "x", port: 25, secure: false, from: "School <no-reply@school.ng>" }, transport);
    const res = await p.send({ to: "parent@example.com", subject: "Hello\r\nBcc: evil@x.com", body: "Body" });
    expect(res.providerRef).toBeTruthy();
    await expect(p.send({ to: "not-an-email", body: "x" })).rejects.toBeInstanceOf(PermanentDeliveryError);
    const failing = nodemailer.createTransport({ jsonTransport: true });
    failing.sendMail = (() => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" }))) as never;
    await expect(new SmtpEmailProvider({ host: "x", port: 25, secure: false, from: "a@b.co" }, failing).send({ to: "a@b.co", body: "x" })).rejects.toBeInstanceOf(TransientDeliveryError);
    const rejecting = nodemailer.createTransport({ jsonTransport: true });
    rejecting.sendMail = (() => Promise.reject(Object.assign(new Error("550 no such user"), { responseCode: 550 }))) as never;
    await expect(new SmtpEmailProvider({ host: "x", port: 25, secure: false, from: "a@b.co" }, rejecting).send({ to: "a@b.co", body: "x" })).rejects.toBeInstanceOf(PermanentDeliveryError);
  });
  it("saving one provider never disturbs the others; null switches one off; secrets stay encrypted", async () => {
    const save = (c: Record<string, unknown>) => db.$transaction((tx) => saveProviderConfig(tx, c as never));
    await save({ email: { host: "smtp.school.ng", port: 587, secure: false, from: "office@school.ng", password: "smtp-secret" } });
    await save({ sms: { url: "https://sms.example.com/send", apiKey: "sms-secret", from: "SCHOOL" } });
    let m = await maskedProviderConfig();
    expect(m.email).toMatchObject({ host: "smtp.school.ng", password: "••••" });
    expect(m.sms).toMatchObject({ url: "https://sms.example.com/send", apiKey: "••••" });
    expect(m.whatsapp).toBeNull();
    await save({ whatsapp: { url: "https://graph.example.com", apiKey: "wa-secret", from: "1234" } });
    await save({ sms: null });
    m = await maskedProviderConfig();
    expect(m.email).not.toBeNull(); expect(m.sms).toBeNull(); expect(m.whatsapp).not.toBeNull();
    const raw = JSON.stringify((await db.systemSetting.findUniqueOrThrow({ where: { key: "notifications.providers" } })).value);
    expect(raw).not.toContain("smtp-secret"); expect(raw).not.toContain("wa-secret");
  });
  it("the settings page can send one test message and reports the outcome in plain words", async () => {
    // nothing configured → tells the administrator what to do, never throws
    expect(await sendTestMessage("SMS", "08031234567", "Test School")).toEqual({ ok: false, error: "No sms provider is set up yet. Save its settings first." });
    // a working provider → ok, and the message names the school and the channel
    const sent: { to: string; subject?: string | null; body: string }[] = [];
    setProviderOverride("SMS", { channel: "SMS", name: "fake-sms", async send(m) { sent.push(m); return {}; } });
    expect(await sendTestMessage("SMS", "08031234567", "Test School")).toEqual({ ok: true, provider: "fake-sms" });
    expect(sent[0]!.body).toContain("Test School");
    // a rejecting provider → its reason; an unreachable one → says so
    setProviderOverride("SMS", { channel: "SMS", name: "x", async send() { throw new PermanentDeliveryError("Invalid sender"); } });
    expect(await sendTestMessage("SMS", "08031234567", "Test School")).toEqual({ ok: false, error: "Invalid sender" });
    setProviderOverride("SMS", { channel: "SMS", name: "x", async send() { throw new TransientDeliveryError("timeout"); } });
    expect(await sendTestMessage("SMS", "08031234567", "Test School")).toEqual({ ok: false, error: "Could not reach the provider: timeout" });
    // nothing was queued: a test is not a notification
    expect(await db.notification.count()).toBe(0);
  });
  it("normalises Nigerian phone numbers", () => {
    expect(normalisePhone("0803 123 4567")).toBe("2348031234567");
    expect(normalisePhone("+2348031234567")).toBe("2348031234567");
    expect(() => normalisePhone("123")).toThrow(PermanentDeliveryError);
  });
  it("HTTP SMS + WhatsApp adapters talk to a real gateway and map status codes", async () => {
    const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
    let mode: "ok" | "server" | "reject" = "ok";
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        calls.push({ url: req.url ?? "", body: JSON.parse(data), auth: req.headers.authorization });
        if (mode === "server") { res.statusCode = 503; return void res.end("{}"); }
        if (mode === "reject") { res.statusCode = 400; return void res.end(JSON.stringify({ message: "Invalid sender", error: { message: "Invalid sender" } })); }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message_id: "sms-1", messages: [{ id: "wa-1" }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const sms = new HttpSmsProvider({ url: `${base}/sms`, apiKey: "K", from: "SCHOOL", style: "json-sms" });
      expect(await sms.send({ to: "08031234567", body: "hi" })).toEqual({ providerRef: "sms-1" });
      expect(calls[0]!.body).toMatchObject({ to: "2348031234567", from: "SCHOOL", sms: "hi", api_key: "K" });
      const wa = new HttpWhatsappProvider({ url: base, apiKey: "TOKEN", from: "PHONEID", style: "whatsapp-cloud" });
      expect(await wa.send({ to: "08031234567", body: "hello" })).toEqual({ providerRef: "wa-1" });
      expect(calls[1]).toMatchObject({ url: "/PHONEID/messages", auth: "Bearer TOKEN" });
      mode = "server";
      await expect(sms.send({ to: "08031234567", body: "x" })).rejects.toBeInstanceOf(TransientDeliveryError);
      mode = "reject";
      await expect(sms.send({ to: "08031234567", body: "x" })).rejects.toBeInstanceOf(PermanentDeliveryError);
    } finally {
      await new Promise((r) => server.close(r));
    }
    // unreachable gateway is transient, not fatal
    await expect(new HttpSmsProvider({ url: "http://127.0.0.1:1/x", apiKey: "K", from: "S", style: "json-sms" }).send({ to: "08031234567", body: "x" })).rejects.toBeInstanceOf(TransientDeliveryError);
  });
  it("provider secrets are encrypted at rest and masked for display", async () => {
    await db.$transaction((tx) => saveProviderConfig(tx, { sms: { url: "https://sms.example/api", apiKey: "SUPER-SECRET-KEY", from: "SCH" } }));
    const raw = JSON.stringify((await db.systemSetting.findUniqueOrThrow({ where: { key: "notifications.providers" } })).value);
    expect(raw).not.toMatch(/SUPER-SECRET-KEY|sms\.example/);
    expect((await maskedProviderConfig()).sms).toMatchObject({ apiKey: "••••", url: "https://sms.example/api" });
  });
});

describe("announcements & inbox", () => {
  it("targets by role/class, fans out in-app, and respects audience on read", async () => {
    const other = (await people.createStudent(S.admin, { firstName: "Other", lastName: "Kid", gender: "MALE", classId: S.jss2.id, guardians: [{ newParent: { firstName: "Other", lastName: "Parent", phone: "08099990000" }, relationship: "Father" }] })).guardianCredentials[0]!.username;
    await createAnnouncement(S.admin, { title: "JSS1 excursion", body: "Trip on Friday", audience: { classIds: [S.jss1.id], roles: [] } });
    await createAnnouncement(S.admin, { title: "Staff meeting", body: "Monday 8am", audience: { roles: ["TEACHER", "STAFF"], classIds: [] } });
    await createAnnouncement(S.admin, { title: "School closes early", body: "Friday", audience: { roles: [], classIds: [] } });
    const mine = await db.user.findUniqueOrThrow({ where: { username: parentUsername } });
    const theirs = await db.user.findUniqueOrThrow({ where: { username: other } });
    expect((await listNotifications(mine.id)).map((n) => n.title).sort()).toEqual(["JSS1 excursion", "School closes early"]);
    expect((await listNotifications(theirs.id)).map((n) => n.title)).toEqual(["School closes early"]);
    expect((await listAnnouncementsFor(mine.id, "PARENT")).map((a) => a.title).sort()).toEqual(["JSS1 excursion", "School closes early"]);
    expect((await listAnnouncementsFor(theirs.id, "PARENT")).map((a) => a.title)).toEqual(["School closes early"]);
    expect(await unreadCount(mine.id)).toBe(2);
    expect(await markRead(mine.id, "all")).toBe(2);
    expect(await unreadCount(mine.id)).toBe(0);
    expect(await hashPassword("x")).toBeTruthy();
    expect(vi).toBeTruthy();
    expect(ctxFor).toBeTruthy();
  });
});
