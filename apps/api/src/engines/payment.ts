import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  badRequest,
  emit,
  notFound,
  openFields,
  type Ctx,
  type PaymentProvider,
  type PaymentWebhookEvent,
  type VerifiedRequest
} from "@lyra/core";
import { telrProvider } from "./payment-telr.js";

// docs/25 §7 — the embedded PSP rail, J-C1's missing `pay` step. A consumer
// pays inside the flow: `createPayment` opens a hosted session on the tenant's
// configured PSP and returns where to send the browser; `handlePaymentWebhook`
// takes the gateway's callback and moves the payment row. The card data never
// reaches LYRA (the payer types it on the provider's page), and with no
// `payment` connector the flow keeps the v1 human-confirmed reference
// (engines/settlement.ts) — this rail only ever adds a path.

export const PAYMENT_TRANSPORT = "payment";

export const PAYMENT_PROVIDERS: Readonly<Record<string, PaymentProvider>> = {
  [telrProvider.provider]: telrProvider
};

type ConnectorRow = typeof schema.orbitChannelConnectors.$inferSelect;

function configOf(row: ConnectorRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.configJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The tenant's active payment connector, or null. */
async function activePaymentConnector(ctx: Ctx): Promise<ConnectorRow | null> {
  const [row] = await ctx.db
    .select()
    .from(schema.orbitChannelConnectors)
    .where(
      and(
        eq(schema.orbitChannelConnectors.tenantId, ctx.tenantId),
        eq(schema.orbitChannelConnectors.transport, PAYMENT_TRANSPORT),
        eq(schema.orbitChannelConnectors.status, "active")
      )
    )
    .limit(1);
  return row ?? null;
}

export interface CreatePaymentInput {
  /** What is being paid for — `quote-requests:<id>`. */
  subjectRef: string;
  amountMinor: number;
  currency: string;
  returnUrl: string;
  cancelUrl?: string;
  description?: string;
}

export interface CreatePaymentResult {
  id: string;
  provider: string;
  redirectUrl: string;
}

export async function createPayment(
  ctx: Ctx,
  fieldKey: string | undefined,
  input: CreatePaymentInput,
  providers: Readonly<Record<string, PaymentProvider>> = PAYMENT_PROVIDERS
): Promise<CreatePaymentResult> {
  if (!Number.isFinite(input.amountMinor) || input.amountMinor <= 0) throw badRequest("payment amount must be positive");
  const connector = await activePaymentConnector(ctx);
  if (!connector) throw badRequest("no active payment provider is configured");
  const provider = providers[connector.provider];
  if (!provider) throw badRequest(`unknown payment provider: ${connector.provider}`);
  if (!fieldKey) throw badRequest("field encryption key is not configured");

  const secrets = await openFields(fieldKey, JSON.parse(connector.secretsJson) as Record<string, string>);
  const paymentId = newId("pay", ctx.now);
  const session = await provider.createSession(
    {
      paymentRef: paymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      subjectRef: input.subjectRef,
      returnUrl: input.returnUrl,
      ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
      ...(input.description !== undefined ? { description: input.description } : {})
    },
    secrets,
    configOf(connector)
  );

  await ctx.db.insert(schema.distPayments).values({
    id: paymentId,
    tenantId: ctx.tenantId,
    subjectRef: input.subjectRef,
    provider: provider.provider,
    providerRef: session.providerRef,
    amountMinor: input.amountMinor,
    currency: input.currency,
    state: "created",
    redirectUrl: session.redirectUrl,
    failureCode: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  await emit(ctx, {
    module: "dist",
    type: "dist.payment.created",
    subject: paymentId,
    data: { id: paymentId, subjectRef: input.subjectRef, provider: provider.provider, amountMinor: input.amountMinor, currency: input.currency }
  });
  return { id: paymentId, provider: provider.provider, redirectUrl: session.redirectUrl };
}

export interface PaymentWebhookResult {
  id: string;
  status: PaymentWebhookEvent["status"];
  duplicate: boolean;
}

export async function handlePaymentWebhook(
  ctx: Ctx,
  providerName: string,
  req: VerifiedRequest,
  fieldKey: string | undefined,
  providers: Readonly<Record<string, PaymentProvider>> = PAYMENT_PROVIDERS
): Promise<PaymentWebhookResult> {
  const provider = providers[providerName];
  if (!provider) throw notFound("payment provider");

  const [connector] = await ctx.db
    .select()
    .from(schema.orbitChannelConnectors)
    .where(
      and(
        eq(schema.orbitChannelConnectors.tenantId, ctx.tenantId),
        eq(schema.orbitChannelConnectors.provider, providerName),
        eq(schema.orbitChannelConnectors.status, "active")
      )
    )
    .limit(1);
  if (!connector) throw notFound("payment connector");
  if (!fieldKey) throw badRequest("field encryption key is not configured");

  const secrets = await openFields(fieldKey, JSON.parse(connector.secretsJson) as Record<string, string>);
  await provider.verifyWebhook(req, secrets);
  const event = provider.parseWebhook(req);
  if (!event.providerRef) throw badRequest("payment callback carried no provider reference");

  const [row] = await ctx.db
    .select()
    .from(schema.distPayments)
    .where(
      and(
        eq(schema.distPayments.tenantId, ctx.tenantId),
        eq(schema.distPayments.provider, providerName),
        eq(schema.distPayments.providerRef, event.providerRef)
      )
    )
    .limit(1);
  if (!row) throw notFound("payment");

  // A replayed callback for a state already recorded is a duplicate, not a
  // second transition — the PSP retries until it gets a 200.
  if (row.state === event.status) return { id: row.id, status: event.status, duplicate: true };

  await ctx.db
    .update(schema.distPayments)
    .set({ state: event.status, failureCode: event.error ?? null, updatedAt: ctx.now })
    .where(eq(schema.distPayments.id, row.id));

  if (event.status === "paid") {
    await emit(ctx, {
      module: "dist",
      type: "dist.quote_request.paid",
      subject: row.subjectRef,
      data: { id: row.id, subjectRef: row.subjectRef, provider: providerName, providerRef: event.providerRef, amountMinor: event.amountMinor, currency: event.currency }
    });
  }
  return { id: row.id, status: event.status, duplicate: false };
}
