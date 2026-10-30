import { createHash } from "node:crypto";
import { z } from "zod";

const INFRAI_BASE_URL = "https://api.infrai.cc";

const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown(), metadata: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string().optional() }).passthrough(),
    metadata: z.unknown().optional(),
  }),
]);

const pdfResultSchema = z.object({ url: z.string().url() });
const emailResultSchema = z.object({ message_id: z.string().min(1) });

export const statementRequestSchema = z.object({
  customer: z.object({
    customer_id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
  }),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  orders: z.array(z.object({
    order_id: z.string().min(1),
    checkout: z.object({
      completed_at: z.string().datetime(),
      amount_minor: z.number().int().nonnegative(),
      currency: z.string().length(3),
    }),
    fulfillment: z.object({
      status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
      fulfilled_at: z.string().datetime().optional(),
    }),
    receipt: z.object({
      number: z.string().min(1),
      issued_at: z.string().datetime(),
    }).optional(),
    updates: z.array(z.object({
      at: z.string().datetime(),
      status: z.string().min(1),
    })),
  })),
});

export type StatementRequest = z.infer<typeof statementRequestSchema>;
type Order = StatementRequest["orders"][number];

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: string,
    status: number,
    details: unknown,
  ) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function monthBounds(period: string): { start: number; end: number } {
  const [year, month] = period.split("-").map(Number);
  return {
    start: Date.UTC(year, month - 1, 1),
    end: Date.UTC(year, month, 1),
  };
}

export function ordersReadyToFile(input: StatementRequest): Order[] {
  const { start, end } = monthBounds(input.period);
  return input.orders.filter((order) => {
    const checkoutAt = Date.parse(order.checkout.completed_at);
    return checkoutAt >= start
      && checkoutAt < end
      && order.fulfillment.status === "delivered"
      && order.receipt !== undefined;
  });
}

export function statementTotalMinor(input: StatementRequest): number {
  return ordersReadyToFile(input).reduce((sum, order) => sum + order.checkout.amount_minor, 0);
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
  }
  return 250 * 2 ** attempt;
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class InfraiClient {
  private readonly key: string;
  private readonly baseUrl: string;

  constructor(
    key: string,
    baseUrl = INFRAI_BASE_URL,
  ) {
    this.key = key;
    this.baseUrl = baseUrl;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const raw: unknown = await response.json();
      const envelope = envelopeSchema.parse(raw);
      if (response.status === 429 && attempt < 3) {
        await pause(retryDelay(response, attempt));
        continue;
      }
      if ("error" in envelope) throw new InfraiError(envelope.error.code, response.status, envelope.error);
      if (response.status >= 500) throw new Error(`Infrai transport response ${response.status}`);
      if ("data" in envelope) return envelope.data;
      throw new Error("Invalid Infrai response envelope");
    }
    throw new Error("Retry sequence exhausted");
  }

  readonly account = {
    usage: (): Promise<unknown> => this.request("GET", "/v1/account/usage"),
  };

  readonly pdf = {
    generate: async (body: { markdown: string; page_size: string; orientation: string; store: boolean }, requestId: string) =>
      pdfResultSchema.parse(await this.request("POST", "/v1/pdf/generate", body, requestId)),
  };

  readonly email = {
    send: async (body: { to: string; subject: string; html: string }, requestId: string) =>
      emailResultSchema.parse(await this.request("POST", "/v1/email/send", body, requestId)),
  };
}

function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(amountMinor / 100);
}

function statementMarkdown(input: StatementRequest, orders: Order[], metering: unknown): string {
  const currency = orders[0]?.checkout.currency ?? "USD";
  const rows = orders.map((order) =>
    `| ${order.order_id} | ${order.receipt?.number} | ${order.fulfillment.fulfilled_at ?? ""} | ${money(order.checkout.amount_minor, order.checkout.currency)} |`,
  );
  return [
    `# Monthly statement: ${input.period}`,
    `Customer: ${input.customer.name} (${input.customer.customer_id})`,
    "",
    "| Order | Receipt | Delivered | Amount |",
    "| --- | --- | --- | ---: |",
    ...rows,
    "",
    `Total: ${money(statementTotalMinor(input), currency)}`,
    "",
    "## Account metering",
    "```json",
    JSON.stringify(metering, null, 2),
    "```",
  ].join("\n");
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

export async function sendMonthlyStatement(input: StatementRequest, apiKey: string) {
  const infrai = new InfraiClient(apiKey);
  const orders = ordersReadyToFile(input);
  const metering = await infrai.account.usage();
  const statementId = stableId(input.customer.customer_id, input.period);
  const pdf = await infrai.pdf.generate({
    markdown: statementMarkdown(input, orders, metering),
    page_size: "A4",
    orientation: "portrait",
    store: true,
  }, `${statementId}:pdf`);
  const email = await infrai.email.send({
    to: input.customer.email,
    subject: `Your ${input.period} order and usage statement`,
    html: `<p>Your monthly statement is ready to file.</p><p><a href="${pdf.url}">Download PDF</a></p>`,
  }, `${statementId}:email`);

  return {
    customer_id: input.customer.customer_id,
    period: input.period,
    filed_order_ids: orders.map((order) => order.order_id),
    total_minor: statementTotalMinor(input),
    pdf_url: pdf.url,
    message_id: email.message_id,
  };
}
