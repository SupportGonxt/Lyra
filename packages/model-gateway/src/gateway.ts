import { id, schema } from "@lyra/db";
import { AppError, actorRef, hashObject, sha256Hex, type Ctx } from "@lyra/core";
import { assertBudget, charge } from "./budget.js";
import { assertNotKilled } from "./kill.js";
import { blocked, checkInput, checkOutput, recordGuardrails, type GuardrailHit } from "./guardrails.js";
import { CATALOGUE, EMBED_MODEL, IMAGE_CATALOGUE, IMAGE_MODEL, costMicro, fallbackChain, resolveModel } from "./models.js";
import { resolvePurpose } from "./purposes.js";
import { rehydrate, scrubMessages } from "./scrub.js";
import { anthropic } from "./providers/anthropic.js";
import { openaiCompat } from "./providers/openai-compat.js";
import { workersAi } from "./providers/workers-ai.js";
import type {
  EmbedRequest,
  EmbedResponse,
  ImageRequest,
  ImageResponse,
  ModelRequest,
  ModelResponse,
  Provider,
  ProviderEnv,
  ProviderName
} from "./types.js";

// docs/02 §5. The only way to reach a model. Every call is budgeted, scrubbed,
// guarded and audited — calling a provider adapter directly bypasses all four,
// which is why they are not exported from the package root.

/**
 * Written out identically at twelve call sites before this — ten `writeAudit`
 * rows and two response objects — so `Date.now() + started` survived every
 * mutant: each site is asserted on its other fields and nothing reads the
 * duration. One expression the twelve route through is both the smaller diff
 * and the only place a check can bite (`gateway.test.ts`, "latency is a
 * duration").
 *
 * Exported only so that check can reach it. `index.ts` re-exports this module
 * with `export *`, so the name is public whether or not anyone wants it —
 * internal to the gateway by convention, not by the type system.
 */
export function elapsed(started: number): number {
  return Date.now() - started;
}

const REGISTRY: Partial<Record<ProviderName, Provider>> = {
  "workers-ai": workersAi,
  anthropic,
  "openai-compat": openaiCompat
};

export interface GatewayOptions {
  env: ProviderEnv;
  /** Tests and the seed pass a stub here; production never does. */
  providers?: Partial<Record<ProviderName, Provider>>;
  /**
   * Tier -> catalogue key. Tests only: production routing comes off
   * `ctx.policy.modelOverrides`, because a constructor option is one nobody
   * remembers to pass (docs/27 F8).
   */
  overrides?: Record<string, string>;
}

/** Retryable transport failures; a 4xx from a provider is not one. */
const RETRY_DELAYS_MS = [0, 250, 1000];

/**
 * docs/27 F36. Errors that mean "this request is wrong", not "this provider is
 * having a bad day". They will fail identically at every vendor, so falling
 * through the chain on one is three times the latency and three times the bill
 * for the same 400. Everything else — auth, quota, a deprecated model, a
 * regional outage, a transport failure — is exactly what the chain is for.
 */
function requestFatal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(400|404|422)\b/.test(msg);
}

/**
 * Which providers this deployment can actually reach. A link with no key is
 * not a fallback, it is a guaranteed second failure spent on a customer's wait,
 * so it is dropped from the chain rather than attempted.
 *
 * A provider passed explicitly in `GatewayOptions.providers` counts as
 * configured whatever the env holds: that is how tests and the seed inject a
 * stub, and treating the stub as unreachable would route them at real models.
 */
function configuredProviders(env: ProviderEnv, injected: Partial<Record<ProviderName, Provider>> = {}): ProviderName[] {
  const names = new Set<ProviderName>(Object.keys(injected) as ProviderName[]);
  if (env.AI) names.add("workers-ai");
  if (env.ANTHROPIC_API_KEY) names.add("anthropic");
  if (env.OPENAI_COMPAT_URL) names.add("openai-compat");
  return [...names];
}

export class Gateway {
  constructor(private readonly opts: GatewayOptions) {}

  private pick(name: ProviderName): Provider {
    const p = this.opts.providers?.[name] ?? REGISTRY[name];
    if (!p) throw new Error(`no provider adapter for ${name}`);
    return p;
  }

  async complete(ctx: Ctx, req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();

    const onPrem = ctx.policy.dataResidency === "on-prem";
    // docs/27 F36. The chain, not a single model: the routing decision first,
    // then whatever other *providers* can serve this tier. `def` stays the
    // primary for everything decided before the call (the input hash, the
    // pre-flight audit rows), and is reassigned to the link that actually
    // answered, so the audit row names the model the tokens were spent on.
    const chain = fallbackChain(req.tier, {
      onPrem,
      overrides: (this.opts.overrides ?? ctx.policy.modelOverrides) as never,
      needsTools: Boolean(req.tools?.length),
      configured: configuredProviders(this.opts.env, this.opts.providers ?? {}),
      ...(req.modelKey !== undefined ? { modelKey: req.modelKey } : {})
    });
    let def = chain[0]!;

    // Scrub before anything sees the messages, including our own audit hash.
    const scrubbed = req.unscrubbed
      ? { messages: req.messages, map: new Map<string, string>(), flags: [] as string[] }
      : scrubMessages(req.messages);
    const flags = new Set(scrubbed.flags);

    // docs/27 F37. A tool result is third-party text — a fetched page, a
    // retrieved document, a partner API response — and reaches the model with
    // the same authority as the user turn, so it is screened with it. Assistant
    // turns are our own prior output and are not re-screened.
    const preHits: GuardrailHit[] = scrubbed.messages.flatMap((m) =>
      m.role === "user" || m.role === "tool"
        ? checkInput(m.content, { untrusted: m.role === "tool" || m.untrusted === true })
        : []
    );
    for (const h of preHits) flags.add(h.rule);

    // docs/27 F40. `purpose` arrives from the request body; `module` comes from
    // the trusted agent row. An unknown pair is treated as the strictest case.
    const purpose = resolvePurpose(req.module, req.purpose);
    for (const f of purpose.flags) flags.add(f);

    const inputHash = await hashObject({ model: def.model, messages: scrubbed.messages, tools: req.tools ?? [] });
    const auditId = id("aia", ctx.now);

    // Kill switch and budget are checked after the hash/audit id exist so a
    // blocked call still lands in ai_audit_log (CLAUDE.md §3: every call is
    // audited, not just the ones that reach a provider). The switch goes first:
    // a paused tenant should not burn budget rows to be told AI is off.
    for (const [outcome, check] of [
      ["killed", () => assertNotKilled(ctx, req.module)],
      ["budget_exceeded", () => assertBudget(ctx, req.module)]
    ] as const) {
      try {
        await check();
      } catch (err) {
        await this.writeAudit(ctx, {
          auditId,
          req,
          def,
          inputHash,
          outputHash: null,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          latencyMs: elapsed(started),
          toolCalls: [],
          flags: [...flags, outcome],
          outcome
        });
        throw err;
      }
    }

    // An injection pattern in untrusted text is refused before the provider
    // sees it — the only guardrail in the pre-flight set that can stop a call.
    // Audited and recorded like any other refusal, with no tokens burned.
    if (blocked(preHits)) {
      await this.writeAudit(ctx, {
        auditId,
        req,
        def,
        inputHash,
        outputHash: null,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: elapsed(started),
        toolCalls: [],
        flags: [...flags, "refused_input"],
        outcome: "refused"
      });
      await recordGuardrails(ctx, preHits, req.subjectRef ? { subjectRef: req.subjectRef } : {});
      return {
        text: "",
        toolCalls: [],
        model: def.model,
        provider: def.provider,
        tier: req.tier,
        usage: { tokensIn: 0, tokensOut: 0, costMicro: 0 },
        latencyMs: elapsed(started),
        finishReason: "refusal",
        flags: [...flags, "refused_input"],
        auditId
      };
    }

    // `untrusted` steers guardrails only — strip it before the provider call.
    const outbound = {
      ...req,
      messages: scrubbed.messages.map(({ untrusted: _untrusted, ...m }) => m)
    };

    // Retries inside a link answer a blip; the chain answers an outage. Three
    // attempts at the identical provider and model (what this loop used to be)
    // could only ever do the first, so a vendor being down was the platform
    // being down.
    let result;
    let lastError: unknown;
    chain: for (const [i, link] of chain.entries()) {
      for (const delay of RETRY_DELAYS_MS) {
        if (delay) await sleep(delay);
        try {
          result = await this.pick(link.provider).complete(outbound, link.model, this.opts.env);
          def = link;
          if (i > 0) flags.add("provider_fallback");
          break chain;
        } catch (err) {
          lastError = err;
          if (!retryable(err)) break;
        }
      }
      // A malformed request fails the same way everywhere: stop, do not spend
      // the rest of the chain proving it.
      if (requestFatal(lastError)) break;
    }

    if (!result) {
      await this.writeAudit(ctx, {
        auditId,
        req,
        def,
        inputHash,
        outputHash: null,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: elapsed(started),
        toolCalls: [],
        flags: [...flags, "provider_error"],
        outcome: "error"
      });
      throw lastError instanceof Error ? lastError : new Error("model call failed");
    }

    const cost = costMicro(def, result.tokensIn, result.tokensOut);
    const postHits = checkOutput({
      text: result.text,
      issued: new Set(scrubbed.map.keys()),
      customerFacing: purpose.customerFacing,
      ...(req.intent !== undefined ? { intent: req.intent } : {})
    });
    for (const h of postHits) flags.add(h.rule);
    const refused = blocked(postHits);

    // Rehydrate only what we redacted, and only when the answer is not blocked.
    const text = refused ? "" : rehydrate(result.text, scrubbed.map);
    const outputHash = await sha256Hex(result.text);

    await this.writeAudit(ctx, {
      auditId,
      req,
      def,
      inputHash,
      outputHash,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cost,
      latencyMs: elapsed(started),
      toolCalls: result.toolCalls,
      flags: [...flags],
      outcome: refused ? "refused" : "ok"
    });
    await recordGuardrails(ctx, [...preHits, ...postHits], req.subjectRef ? { subjectRef: req.subjectRef } : {});
    // Tokens were burned whether or not we let the answer through.
    await charge(ctx, { tokensIn: result.tokensIn, tokensOut: result.tokensOut, costMicro: cost }, req.module);

    return {
      text,
      toolCalls: refused ? [] : result.toolCalls,
      model: def.model,
      provider: def.provider,
      tier: req.tier,
      usage: { tokensIn: result.tokensIn, tokensOut: result.tokensOut, costMicro: cost },
      latencyMs: elapsed(started),
      finishReason: refused ? "refusal" : result.finishReason,
      flags: [...flags],
      auditId
    };
  }

  /** bge-m3 covers ar+en in one space (docs/02 §5), so no per-locale index. */
  async embed(ctx: Ctx, req: EmbedRequest): Promise<EmbedResponse> {
    const started = Date.now();
    const onPrem = ctx.policy.dataResidency === "on-prem";
    const key = onPrem ? EMBED_MODEL.onprem : EMBED_MODEL.cloud;
    const def = CATALOGUE[key];
    if (!def) throw new Error(`no embedding model ${key}`);

    // EmbedRequest carries no tier or subject — embeddings are one shape of
    // call — so the audit row records the pair it does have.
    const audit: Pick<ModelRequest, "module" | "purpose" | "tier" | "subjectRef"> = {
      module: req.module,
      purpose: req.purpose,
      tier: "fast"
    };
    const inputHash = await hashObject({ model: def.model, texts: req.texts });
    const auditId = id("aia", ctx.now);

    // A paused tenant is paused for indexing too, or a kill switch quietly
    // leaves half the AI running. Audited before the throw for the same reason
    // complete() does it: every call lands in ai_audit_log, not just the ones
    // that reach a provider (CLAUDE.md §3).
    for (const [outcome, check] of [
      ["killed", () => assertNotKilled(ctx, req.module)],
      ["budget_exceeded", () => assertBudget(ctx, req.module)]
    ] as const) {
      try {
        await check();
      } catch (err) {
        await this.writeAudit(ctx, {
          auditId,
          req: audit,
          def,
          inputHash,
          outputHash: null,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          latencyMs: elapsed(started),
          toolCalls: [],
          flags: [outcome],
          outcome
        });
        throw err;
      }
    }

    const provider = this.pick(def.provider);
    if (!provider.embed) throw new Error(`${def.provider} cannot embed`);

    // Embeddings are indexed and long-lived; scrubbing keeps PII out of the vector store.
    const scrubbed = scrubMessages(req.texts.map((content) => ({ content })));
    let out;
    try {
      out = await provider.embed(
        { ...req, texts: scrubbed.messages.map((m) => m.content) },
        def.model,
        this.opts.env
      );
    } catch (err) {
      await this.writeAudit(ctx, {
        auditId,
        req: audit,
        def,
        inputHash,
        outputHash: null,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: elapsed(started),
        toolCalls: [],
        flags: ["error"],
        outcome: "error"
      });
      throw err;
    }

    const cost = costMicro(def, out.usage.tokensIn, 0);
    await this.writeAudit(ctx, {
      auditId,
      req: audit,
      def,
      inputHash,
      // Vectors are not text; the hash covers what went in, and there is no
      // output content to reconstruct.
      outputHash: null,
      tokensIn: out.usage.tokensIn,
      tokensOut: 0,
      cost,
      latencyMs: elapsed(started),
      toolCalls: [],
      flags: scrubbed.flags,
      outcome: "ok"
    });
    await charge(ctx, { tokensIn: out.usage.tokensIn, tokensOut: 0, costMicro: cost }, req.module);

    return {
      vectors: out.vectors,
      model: def.model,
      provider: def.provider,
      usage: { ...out.usage, costMicro: cost }
    };
  }

  /**
   * ADR-0060. One round trip, no conversational output — closer to embed()
   * than complete(): no checkOutput, no retry loop. checkInput still screens
   * the prompt, same function complete() runs on user turns, but a hit only
   * flags — it never blocks (checkInput's hits are all severity "warn").
   * There is no on-prem image model (ADR-0075), and IMAGE_CATALOGUE holds one
   * cloud entry, so an on-prem tenant reaching here would send its prompt to a
   * third party — the breach resolveModel(models.ts:87) exists to prevent on
   * the text path and embed() repeats at :243. Refuse rather than route: this
   * is a capability an on-prem deployment does not have, not a tier to
   * downgrade. Give IMAGE_MODEL an `onprem` key beside EMBED_MODEL's and this
   * guard becomes the same ternary those two use.
   */
  async generateImage(ctx: Ctx, req: ImageRequest): Promise<ImageResponse> {
    const started = Date.now();
    // AppError, not a bare Error: the bare ones above are unreachable-config
    // bugs and 500 is right for them, while this is a policy refusal a caller
    // can act on. POST /v1/signal/creatives/image is a live route
    // (apps/api/src/routes/signal.ts:195), so an untyped throw there is a 500
    // on a request the platform understood perfectly.
    if (ctx.policy.dataResidency === "on-prem")
      throw new AppError(
        403,
        "onprem_no_image_model",
        "Image generation is unavailable on-prem",
        "This deployment keeps prompts internal and has no on-prem image model (ADR-0075)."
      );
    const def = IMAGE_CATALOGUE[IMAGE_MODEL.cloud];
    if (!def) throw new Error(`no image model ${IMAGE_MODEL.cloud}`);

    const preHits = checkInput(req.prompt);
    const flags = new Set(preHits.map((h) => h.rule));

    const purpose = resolvePurpose(req.module, req.purpose);
    for (const f of purpose.flags) flags.add(f);

    const inputHash = await hashObject({ model: def.model, prompt: req.prompt });
    const auditId = id("aia", ctx.now);
    const audit: Pick<ModelRequest, "module" | "purpose" | "tier" | "subjectRef"> = {
      module: req.module,
      purpose: req.purpose,
      tier: "standard",
      ...(req.subjectRef !== undefined ? { subjectRef: req.subjectRef } : {})
    };

    for (const [outcome, check] of [
      ["killed", () => assertNotKilled(ctx, req.module)],
      ["budget_exceeded", () => assertBudget(ctx, req.module)]
    ] as const) {
      try {
        await check();
      } catch (err) {
        await this.writeAudit(ctx, {
          auditId,
          req: audit,
          def,
          inputHash,
          outputHash: null,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          latencyMs: elapsed(started),
          toolCalls: [],
          flags: [...flags, outcome],
          outcome
        });
        throw err;
      }
    }

    const provider = this.pick(def.provider);
    if (!provider.generateImage) throw new Error(`${def.provider} cannot generate images`);

    let result;
    try {
      result = await provider.generateImage(req.prompt, def.model, this.opts.env);
    } catch (err) {
      await this.writeAudit(ctx, {
        auditId,
        req: audit,
        def,
        inputHash,
        outputHash: null,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        latencyMs: elapsed(started),
        toolCalls: [],
        flags: [...flags, "provider_error"],
        outcome: "error"
      });
      throw err instanceof Error ? err : new Error("image generation failed");
    }

    const cost = def.costMicroPerImage;
    const outputHash = await sha256Hex(result.bytes);

    await this.writeAudit(ctx, {
      auditId,
      req: audit,
      def,
      inputHash,
      outputHash,
      tokensIn: 0,
      tokensOut: 0,
      cost,
      latencyMs: elapsed(started),
      toolCalls: [],
      flags: [...flags],
      outcome: "ok"
    });
    await recordGuardrails(ctx, preHits, req.subjectRef ? { subjectRef: req.subjectRef } : {});
    await charge(ctx, { tokensIn: 0, tokensOut: 0, costMicro: cost }, req.module);

    return {
      bytes: result.bytes,
      contentType: result.contentType,
      model: def.model,
      provider: def.provider,
      usage: { tokensIn: 0, tokensOut: 0, costMicro: cost },
      flags: [...flags],
      auditId
    };
  }

  private async writeAudit(
    ctx: Ctx,
    a: {
      auditId: string;
      req: Pick<ModelRequest, "module" | "purpose" | "tier" | "subjectRef">;
      def: { model: string; provider: ProviderName };
      inputHash: string;
      outputHash: string | null;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      latencyMs: number;
      toolCalls: unknown[];
      flags: string[];
      outcome: "ok" | "refused" | "error" | "budget_exceeded" | "killed";
    }
  ): Promise<void> {
    // Hashes, never content: ai_audit_log is queried by Compliance and must not
    // become a second copy of every customer conversation (docs/12 §4).
    await ctx.db.insert(schema.aiAuditLog).values({
      id: a.auditId,
      tenantId: ctx.tenantId,
      module: a.req.module,
      purpose: a.req.purpose,
      model: a.def.model,
      provider: a.def.provider,
      tier: a.req.tier,
      inputHash: a.inputHash,
      outputHash: a.outputHash,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costMicro: a.cost,
      latencyMs: a.latencyMs,
      toolCallsJson: a.toolCalls.length ? JSON.stringify(a.toolCalls) : null,
      guardrailFlagsJson: a.flags.length ? JSON.stringify(a.flags) : null,
      actorRef: actorRef(ctx),
      subjectRef: a.req.subjectRef ?? null,
      outcome: a.outcome,
      ts: ctx.now
    });

    this.opts.env.TELEMETRY?.writeDataPoint({
      blobs: [ctx.tenantId, a.req.module, a.req.purpose, a.def.model, a.def.provider, a.outcome],
      doubles: [a.tokensIn, a.tokensOut, a.cost, a.latencyMs],
      indexes: [ctx.tenantId]
    });
  }
}

function retryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|network|timeout|fetch failed/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
