import {
  applyBudgetDelta,
  currencyExponent,
  microsToMinor,
  minorToMicros,
  minorToUnits,
  type AdConversionResult,
  type AdPlatform,
  type AdSpendRow,
  type AdSpendWindow,
  type ConnectorSecrets
} from "@lyra/core";

// docs/30 SIGNAL 5, ADR-0100. Google Ads API over REST, against the `AdPlatform`
// seam (packages/core/src/seams.ts). A channel, not a suite (CLAUDE.md §13).
//
// Secrets (sealed on the connector row): developerToken, clientId,
// clientSecret, refreshToken. Config: customerId (dashes allowed),
// loginCustomerId for a manager account, optional apiVersion, plus the
// `campaigns` map and `channel` the engine reads (ad-platform.ts).
//
// Shapes: OAuth2 refresh at oauth2.googleapis.com/token; GAQL through
// `customers/{id}/googleAds:search` (paged by nextPageToken, proto3 JSON that
// omits zero-valued fields and carries int64 as strings); budgets through
// `customers/{id}/campaignBudgets:mutate` with an `amount_micros` update mask.

/** Google sunsets a version roughly yearly; a connector can pin another with `config.apiVersion`. */
export const GOOGLE_ADS_API_VERSION = "v21";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;

interface SearchRow {
  campaign?: { id?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number };
  customer?: { currencyCode?: string };
  campaignBudget?: { resourceName?: string; amountMicros?: string; explicitlyShared?: boolean };
}

interface UploadReply {
  results?: Array<{ gclid?: string }>;
  partialFailureError?: {
    message?: string;
    details?: Array<{ errors?: Array<{ message?: string; location?: { fieldPathElements?: Array<{ fieldName?: string; index?: number }> } }> }>;
  };
}

function need(secrets: ConnectorSecrets, key: string): string {
  const v = secrets[key];
  if (!v) throw new Error(`google-ads connector is missing secret ${key}`);
  return v;
}

function digitsOf(config: Record<string, unknown>, key: string): string | null {
  const raw = config[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const digits = String(raw).replace(/-/g, "");
  if (!DIGITS.test(digits)) throw new Error(`google-ads config ${key} must be a customer id`);
  return digits;
}

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string; error_description?: string } | null;
  const message = typeof body?.error === "object" ? body.error.message : (body?.error_description ?? body?.error);
  return new Error(`google-ads ${res.status}: ${message ?? res.statusText}`);
}

export function googleAdsPlatform(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): AdPlatform {
  async function session(secrets: ConnectorSecrets, config: Record<string, unknown>) {
    const customerId = digitsOf(config, "customerId");
    if (!customerId) throw new Error("google-ads config customerId is required");
    const loginCustomerId = digitsOf(config, "loginCustomerId");
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: need(secrets, "clientId"),
      client_secret: need(secrets, "clientSecret"),
      refresh_token: need(secrets, "refreshToken")
    });
    const developerToken = need(secrets, "developerToken");
    const version = typeof config.apiVersion === "string" && /^v\d+$/.test(config.apiVersion) ? config.apiVersion : GOOGLE_ADS_API_VERSION;

    const tokenRes = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    if (!tokenRes.ok) throw await failure(tokenRes);
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) throw new Error("google-ads token exchange returned no access token");

    const base = `https://googleads.googleapis.com/${version}/customers/${customerId}`;
    const headers = {
      authorization: `Bearer ${access_token}`,
      "developer-token": developerToken,
      "content-type": "application/json",
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {})
    };
    // A custom method (`customers/{id}:uploadClickConversions`) hangs off the
    // customer itself; a collection path follows a slash.
    const post = async (path: string, body: unknown): Promise<unknown> => {
      const res = await fetchImpl(`${base}${path.startsWith(":") ? "" : "/"}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) throw await failure(res);
      return res.json();
    };
    const search = async (query: string): Promise<SearchRow[]> => {
      const out: SearchRow[] = [];
      let pageToken: string | undefined;
      do {
        const page = (await post("googleAds:search", pageToken ? { query, pageToken } : { query })) as { results?: SearchRow[]; nextPageToken?: string };
        out.push(...(page.results ?? []));
        pageToken = page.nextPageToken || undefined;
      } while (pageToken);
      return out;
    };
    return { post, search, customerId };
  }

  return {
    provider: "google-ads",
    defaultChannel: "google_search",
    // docs/17 SIG-032, ADR-0112. Offline click conversions match on the gclid
    // Google issued and nothing else — enhanced conversions (hashed user data)
    // are not implemented, so none is ever asked for.
    conversionKeys: ["gclid"],
    // Google refuses a click conversion more than 90 days after the click.
    conversionMaxAgeDays: 90,

    async uploadConversions(conversions, secrets, config): Promise<AdConversionResult[]> {
      const actionId = digitsOf(config, "conversionActionId");
      if (!actionId) throw new Error("google-ads config conversionActionId is required to upload conversions");
      const out = new Map<string, AdConversionResult>();
      const sendable = conversions.filter((c) => {
        if (c.gclid) return true;
        out.set(c.conversionId, { conversionId: c.conversionId, status: "failed", error: "no gclid" });
        return false;
      });
      if (sendable.length) {
        const { post, customerId } = await session(secrets, config);
        const conversionAction = `customers/${customerId}/conversionActions/${actionId}`;
        const reply = (await post(":uploadClickConversions", {
          conversions: sendable.map((c) => ({
            gclid: c.gclid,
            conversionAction,
            conversionDateTime: `${new Date(c.at).toISOString().slice(0, 19).replace("T", " ")}+00:00`,
            conversionValue: minorToUnits(c.valueMinor, currencyExponent(c.currency)),
            currencyCode: c.currency,
            orderId: c.conversionId
          })),
          partialFailure: true
        })) as UploadReply;
        // With partial failure on, a refused row comes back as an empty result
        // and its reason sits in partialFailureError, located by index.
        const reasons = new Map<number, string>();
        for (const detail of reply.partialFailureError?.details ?? []) {
          for (const e of detail.errors ?? []) {
            const index = e.location?.fieldPathElements?.find((f) => f.fieldName === "conversions")?.index;
            if (typeof index === "number" && !reasons.has(index)) reasons.set(index, e.message ?? "refused");
          }
        }
        sendable.forEach((c, i) => {
          const accepted = Boolean(reply.results?.[i]?.gclid) && !reasons.has(i);
          out.set(
            c.conversionId,
            accepted
              ? { conversionId: c.conversionId, status: "sent" }
              : { conversionId: c.conversionId, status: "failed", error: reasons.get(i) ?? reply.partialFailureError?.message ?? "not accepted" }
          );
        });
      }
      return conversions.map((c) => out.get(c.conversionId)!);
    },

    async pullSpend(window: AdSpendWindow, secrets, config): Promise<AdSpendRow[]> {
      // The window is interpolated into GAQL, so it is held to two dates first.
      if (!DAY.test(window.since) || !DAY.test(window.until)) throw new Error("spend window must be two YYYY-MM-DD dates");
      const { search } = await session(secrets, config);
      const rows = await search(
        "SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code " +
          `FROM campaign WHERE segments.date BETWEEN '${window.since}' AND '${window.until}'`
      );
      return rows.map((r) => {
        const currency = r.customer?.currencyCode ?? "";
        return {
          externalCampaignId: String(r.campaign?.id ?? ""),
          day: r.segments?.date ?? "",
          amountMinor: microsToMinor(r.metrics?.costMicros ?? "0", currencyExponent(currency)),
          currency,
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          conversions: Math.round(r.metrics?.conversions ?? 0)
        };
      });
    },

    async adjustDailyBudget(externalCampaignId, deltaMinor, currency, secrets, config) {
      if (!DIGITS.test(externalCampaignId)) throw new Error(`not a google-ads campaign id: ${externalCampaignId}`);
      const { post, search } = await session(secrets, config);
      const [row] = await search(
        "SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, customer.currency_code " +
          `FROM campaign WHERE campaign.id = ${externalCampaignId}`
      );
      const budget = row?.campaignBudget;
      if (!row || !budget?.resourceName) throw new Error(`google-ads has no campaign ${externalCampaignId} with a budget`);
      // A shared budget funds other campaigns too: moving it would move them.
      if (budget.explicitlyShared) throw new Error(`google-ads campaign ${externalCampaignId} draws on a shared budget`);
      const billed = row.customer?.currencyCode ?? "";
      if (billed !== currency) throw new Error(`google-ads account bills in ${billed}, the move is in ${currency}`);
      const exponent = currencyExponent(currency);
      const beforeMinor = microsToMinor(budget.amountMicros ?? "0", exponent);
      const afterMinor = applyBudgetDelta(beforeMinor, deltaMinor);
      await post("campaignBudgets:mutate", {
        operations: [{ update: { resourceName: budget.resourceName, amountMicros: String(minorToMicros(afterMinor, exponent)) }, updateMask: "amount_micros" }]
      });
      return { beforeMinor, afterMinor };
    }
  };
}
