import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import { db, type Tx } from "@/platform/db";
import { decryptSecret, encryptSecret } from "@/platform/crypto";
import type { NotificationChannel } from "@/generated/prisma/client";

/**
 * Provider abstraction. The application only ever talks to these interfaces; concrete gateways are
 * adapters chosen by configuration, so no provider is hard-coded (and a Nigerian SMS gateway can be
 * swapped without touching business logic).
 */
export interface OutboundMessage {
  to: string;
  subject?: string | null;
  body: string;
}

export interface SendResult {
  providerRef?: string;
}

/** Thrown for problems that will never succeed on retry (bad address, rejected content). */
export class PermanentDeliveryError extends Error {}
/** Thrown when the provider cannot be reached or is not configured yet; the message stays queued. */
export class TransientDeliveryError extends Error {}

export interface MessageProvider {
  readonly channel: Exclude<NotificationChannel, "IN_APP">;
  readonly name: string;
  send(msg: OutboundMessage): Promise<SendResult>;
}

// ───────────── Email over SMTP ─────────────

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export class SmtpEmailProvider implements MessageProvider {
  readonly channel = "EMAIL" as const;
  readonly name = "smtp";
  private transport: Transporter;
  constructor(private cfg: SmtpConfig, transport?: Transporter) {
    this.transport = transport ?? nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined, connectionTimeout: 10_000, socketTimeout: 15_000 });
  }
  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(msg.to)) throw new PermanentDeliveryError("Invalid email address");
    try {
      const info = await this.transport.sendMail({ from: this.cfg.from, to: msg.to, subject: (msg.subject ?? "School notification").replace(/[\r\n]+/g, " "), text: msg.body });
      return { providerRef: String(info.messageId ?? "") };
    } catch (err) {
      const e = err as { responseCode?: number; message?: string };
      if (e.responseCode && e.responseCode >= 500 && e.responseCode < 600) throw new PermanentDeliveryError(e.message ?? "Rejected by the mail server");
      throw new TransientDeliveryError(e.message ?? "Mail server unreachable");
    }
  }
}

// ───────────── Generic HTTP gateways (SMS / WhatsApp) ─────────────

export interface HttpGatewayConfig {
  url: string;
  apiKey: string;
  /** Sender id / phone-number id, depending on the gateway. */
  from: string;
  /** "json-sms" = { to, from, sms, api_key } (Termii-style); "whatsapp-cloud" = Meta Cloud API message body. */
  style: "json-sms" | "whatsapp-cloud";
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  } catch (err) {
    throw new TransientDeliveryError(`Gateway unreachable: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** E.164-ish normalisation for Nigerian numbers: 0803… → 234803… */
export function normalisePhone(raw: string): string {
  const d = raw.replace(/[^\d+]/g, "");
  if (/^\+?234\d{10}$/.test(d)) return d.replace("+", "");
  if (/^0\d{10}$/.test(d)) return `234${d.slice(1)}`;
  if (/^\+\d{8,15}$/.test(d)) return d.slice(1);
  throw new PermanentDeliveryError("Invalid phone number");
}

export class HttpSmsProvider implements MessageProvider {
  readonly channel = "SMS" as const;
  readonly name = "http-sms";
  constructor(private cfg: HttpGatewayConfig) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    const to = normalisePhone(msg.to);
    const { status, json } = await postJson(this.cfg.url, { to, from: this.cfg.from, sms: msg.body.slice(0, 640), type: "plain", channel: "generic", api_key: this.cfg.apiKey });
    if (status >= 500 || status === 429) throw new TransientDeliveryError(`SMS gateway returned ${status}`);
    if (status >= 400) throw new PermanentDeliveryError(String(json.message ?? `SMS gateway rejected the message (${status})`));
    return { providerRef: String(json.message_id ?? json.id ?? "") };
  }
}

export class HttpWhatsappProvider implements MessageProvider {
  readonly channel = "WHATSAPP" as const;
  readonly name = "whatsapp-cloud";
  constructor(private cfg: HttpGatewayConfig) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    const to = normalisePhone(msg.to);
    const { status, json } = await postJson(`${this.cfg.url.replace(/\/$/, "")}/${this.cfg.from}/messages`, { messaging_product: "whatsapp", to, type: "text", text: { body: msg.body.slice(0, 1500) } }, { authorization: `Bearer ${this.cfg.apiKey}` });
    if (status >= 500 || status === 429) throw new TransientDeliveryError(`WhatsApp gateway returned ${status}`);
    if (status >= 400) throw new PermanentDeliveryError(String((json.error as { message?: string } | undefined)?.message ?? `WhatsApp gateway rejected the message (${status})`));
    return { providerRef: String((json.messages as { id?: string }[] | undefined)?.[0]?.id ?? "") };
  }
}

// ───────────── Configuration (secrets encrypted at rest) ─────────────

export const ProviderConfig = z.object({
  email: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), secure: z.boolean().default(false), user: z.string().optional(), password: z.string().optional(), from: z.string().min(3) }).nullable().default(null),
  sms: z.object({ url: z.string().url(), apiKey: z.string().min(1), from: z.string().min(1) }).nullable().default(null),
  whatsapp: z.object({ url: z.string().url(), apiKey: z.string().min(1), from: z.string().min(1) }).nullable().default(null),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

const KEY = "notifications.providers";

/**
 * Sections are merged: a channel that is omitted keeps its stored settings, `null` switches that channel off.
 * (Replacing everything would let an administrator silently disable SMS by only editing the e-mail server.)
 */
export async function saveProviderConfig(tx: Tx, cfg: z.input<typeof ProviderConfig>) {
  const given = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined));
  const parsed = ProviderConfig.parse({ ...(await loadProviderConfig()), ...given });
  const value = { enc: encryptSecret(JSON.stringify(parsed)) };
  await tx.systemSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const row = await db.systemSetting.findUnique({ where: { key: KEY } });
  const enc = (row?.value as { enc?: string } | undefined)?.enc;
  return ProviderConfig.parse(enc ? JSON.parse(decryptSecret(enc)) : {});
}

/** Config with secrets masked, safe to show in the admin UI. */
export async function maskedProviderConfig() {
  const c = await loadProviderConfig();
  const mask = <T extends { apiKey?: string; password?: string }>(x: T | null) => (x ? { ...x, ...(x.apiKey ? { apiKey: "••••" } : {}), ...(x.password ? { password: "••••" } : {}) } : null);
  return { email: mask(c.email), sms: mask(c.sms), whatsapp: mask(c.whatsapp) };
}

// Tests and unusual deployments can inject providers directly.
const overrides = new Map<string, MessageProvider>();
export const setProviderOverride = (channel: string, p: MessageProvider | null) => void (p ? overrides.set(channel, p) : overrides.delete(channel));

/**
 * Sends ONE message through the configured provider, straight away and outside the delivery queue, so an
 * administrator learns whether the gateway settings work before a real parent message depends on them.
 * Never throws for provider problems: the reason comes back in plain words.
 */
export async function sendTestMessage(channel: Exclude<NotificationChannel, "IN_APP">, to: string, schoolName: string): Promise<{ ok: true; provider: string } | { ok: false; error: string }> {
  let provider: MessageProvider;
  try { provider = await providerFor(channel); }
  catch (e) { return { ok: false, error: e instanceof TransientDeliveryError ? `No ${channel.toLowerCase()} provider is set up yet. Save its settings first.` : (e as Error).message }; }
  try {
    await provider.send({ to, subject: "SmartSchool test message", body: `This is a test message from ${schoolName}. If you can read it, ${channel.toLowerCase()} delivery is working.` });
    return { ok: true, provider: provider.name };
  } catch (e) {
    const reason = (e as Error).message || "The provider refused the message";
    return { ok: false, error: e instanceof TransientDeliveryError ? `Could not reach the provider: ${reason}` : reason };
  }
}

export async function providerFor(channel: Exclude<NotificationChannel, "IN_APP">): Promise<MessageProvider> {
  const o = overrides.get(channel);
  if (o) return o;
  const cfg = await loadProviderConfig();
  if (channel === "EMAIL" && cfg.email) return new SmtpEmailProvider(cfg.email);
  if (channel === "SMS" && cfg.sms) return new HttpSmsProvider({ ...cfg.sms, style: "json-sms" });
  if (channel === "WHATSAPP" && cfg.whatsapp) return new HttpWhatsappProvider({ ...cfg.whatsapp, style: "whatsapp-cloud" });
  // Not configured is NOT fatal: messages stay queued and go out as soon as the school configures a provider.
  throw new TransientDeliveryError(`${channel} provider is not configured`);
}
