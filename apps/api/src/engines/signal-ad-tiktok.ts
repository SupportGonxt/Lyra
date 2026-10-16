import {
  applyBudgetDelta,
  currencyExponent,
  decimalToMinor,
  minorToUnits,
  type AdConversionResult,
  type AdPlatform,
  type AdSpendRow,
  type AdSpendWindow,
  type ConnectorSecrets
} from "@lyra/core";

// docs/modules/signal.md §2.2 / docs/30 SIGNAL 5, ADR-0100. TikTok Marketing API
// against the `AdPlatform` seam. A channel, not a suite (CLAUDE.md §13).
//
// Secrets: accessToken (a TikTok for Business app access token). Config:
// advertiserId, optional pixelId + conversionEvent (the Events API source id
// and event name), optional apiVersion, plus the `campaigns` map and `channel`
// the engine reads (ad-platform.ts).
//
// Match keys: TikTok's Events API matches on hashed email/phone (and `ttclid`,
// which LYRA does not capture yet), so the exporter sends only the hashed
// identifiers — never a name or any other field (SIG-034).
//
// Budgets: TikTok bills and sets `budget` in the account's currency (major
// units), unlike Meta's minor-unit daily_budget, so the adapter converts at the
// seam. The access token rides in the `Access-Token` header, never in a URL.

export const TIKTOK_API_VERSION = "v1.3";
const TIKTOK_HOST = "business-api.tiktok.com";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;

interface ReportRow {
  dimensions?: { campaign_id?: string; stat_time_day?: string };
  metrics?: { spend?: string; impressions?: string; clicks?: string; conversion?: string };
}

interface TikTokEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { message?: string; code?: number } | null;
  const detail = body?.message ?? res.statusText;
  const code = body?.code;
  return new Error(`tiktok-ads ${res.status}${code !== undefined ? `/${code}` : ""}: ${detail}`);
}

export function tiktokAdsPlatform(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): AdPlatform {
  function session(secrets: ConnectorSecrets, config: Record<string, unknown>) {
    const token = secrets.accessToken;
    if (!token) throw new Error("tiktok-ads connector is missing secret accessToken");
    const advertiser = String(config.advertiserId ?? "");
    if (!DIGITS.test(advertiser)) throw new Error("tiktok-ads config advertiserId is required (digits)");
    const version =
      typeof config.apiVersion === "string" && /^v\d+\.\d+$/.test(config.apiVersion) ? config.apiVersion : TIKTOK_API_VERSION;
    const api = `https://${TIKTOK_HOST}/open_api/${version}`;
    const call = async (url: string, init?: RequestInit): Promise<TikTokEnvelope<unknown>> => {
      const res = await fetchImpl(url, {
        ...init,
        headers: { "Access-Token": token, ...(init?.headers as Record<string, string> | undefined) }
      });
      if (!res.ok) throw await failure(res);
      const json = (await res.json()) as TikTokEnvelope<unknown>;
      // TikTok answers HTTP 200 with a non-zero `code` for application errors.
      if (json.code !== undefined && json.code !== 0) throw new Error(`tiktok-ads code ${json.code}: ${json.message ?? ""}`);
      return json;
    };
    return { api, advertiser, call };
  }

  return {
    provider: "tiktok-ads",
    defaultChannel: "tiktok",
    conversionKeys: ["emailSha256", "phoneSha256"],
    // TikTok rejects an Events API event older than 7 days.
    conversionMaxAgeDays: 7,

    async uploadConversions(conversions, secrets, config): Promise<AdConversionResult[]> {
      const pixelId = String(config.pixelId ?? "");
      if (!DIGITS.test(pixelId)) throw new Error("tiktok-ads config pixelId is required to upload conversions");
      const eventName =
        typeof config.conversionEvent === "string" && /^\w{1,64}$/.test(config.conversionEvent)
          ? config.conversionEvent
          : "CompletePayment";
      const { api, call } = session(secrets, config);
      const out = new Map<string, AdConversionResult>();
      const events: Record<string, unknown>[] = [];
      const sent: string[] = [];
      for (const c of conversions) {
        // Only the hashed match keys — never a name, a birth date or any other
        // field TikTok's user object would accept (SIG-034).
        const user: Record<string, unknown> = {};
        if (c.emailSha256?.length) user["email"] = [...c.emailSha256];
        if (c.phoneSha256?.length) user["phone"] = [...c.phoneSha256];
        if (!Object.keys(user).length) {
          out.set(c.conversionId, { conversionId: c.conversionId, status: "failed", error: "no match key" });
          continue;
        }
        sent.push(c.conversionId);
        events.push({
          event: eventName,
          event_time: Math.floor(c.at / 1000),
          event_id: c.conversionId,
          user,
          properties: { value: minorToUnits(c.valueMinor, currencyExponent(c.currency)), currency: c.currency }
        });
      }
      if (events.length) {
        await call(`${api}/event/track/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event_source: "web", event_source_id: pixelId, data: events })
        });
        // TikTok takes the batch whole or not at all; a non-zero code already
        // threw above, so reaching here means all of it landed.
        for (const id of sent) out.set(id, { conversionId: id, status: "sent" });
      }
      return conversions.map((c) => out.get(c.conversionId)!);
    },

    async pullSpend(window: AdSpendWindow, secrets, config): Promise<AdSpendRow[]> {
      if (!DAY.test(window.since) || !DAY.test(window.until)) throw new Error("spend window must be two YYYY-MM-DD dates");
      const { api, advertiser, call } = session(secrets, config);
      const rows: ReportRow[] = [];
      let page = 1;
      let totalPage = 1;
      do {
        const params = new URLSearchParams({
          advertiser_id: advertiser,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
          metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion"]),
          start_date: window.since,
          end_date: window.until,
          page: String(page),
          page_size: "1000"
        });
        const envelope = (await call(`${api}/report/integrated/get/?${params}`)) as TikTokEnvelope<{
          list?: ReportRow[];
          page_info?: { total_page?: number };
        }>;
        rows.push(...(envelope.data?.list ?? []));
        totalPage = Number(envelope.data?.page_info?.total_page ?? 1);
        page += 1;
        // The report is billed per call, so a runaway paging loop is a runaway
        // bill: a page count that does not advance stops here.
      } while (page <= totalPage && page <= 100);

      return rows.map((r) => {
        const currency = String(config.currency ?? "AED");
        return {
          externalCampaignId: String(r.dimensions?.campaign_id ?? ""),
          // TikTok returns "YYYY-MM-DD HH:MM:SS"; the ledger keys on the day.
          day: String(r.dimensions?.stat_time_day ?? "").slice(0, 10),
          amountMinor: decimalToMinor(r.metrics?.spend ?? "0", currencyExponent(currency)),
          currency,
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          conversions: Math.round(Number(r.metrics?.conversion ?? 0))
        };
      });
    },

    async adjustDailyBudget(externalCampaignId, deltaMinor, currency, secrets, config) {
      if (!DIGITS.test(externalCampaignId)) throw new Error(`not a tiktok-ads campaign id: ${externalCampaignId}`);
      const { api, advertiser, call } = session(secrets, config);
      const info = (await call(`${api}/advertiser/info/?advertiser_id=${advertiser}&fields=${JSON.stringify(["currency"])}`)) as TikTokEnvelope<{
        list?: { currency?: string }[];
      }>;
      const billed = info.data?.list?.[0]?.currency;
      if (billed && billed !== currency) {
        throw new Error(`tiktok-ads account bills in ${billed}, the move is in ${currency}`);
      }
      const got = (await call(
        `${api}/campaign/get/?advertiser_id=${advertiser}&filtering=${JSON.stringify({ campaign_ids: [externalCampaignId] })}&fields=${JSON.stringify(["budget"])}`
      )) as TikTokEnvelope<{ list?: { budget?: number }[] }>;
      const budgetMajor = got.data?.list?.[0]?.budget;
      if (budgetMajor === undefined || !Number.isFinite(budgetMajor)) {
        throw new Error(`tiktok-ads campaign ${externalCampaignId} has no readable budget`);
      }
      const beforeMinor = decimalToMinor(String(budgetMajor), currencyExponent(currency));
      const afterMinor = applyBudgetDelta(beforeMinor, deltaMinor);
      await call(`${api}/campaign/update/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          advertiser_id: advertiser,
          campaign_id: externalCampaignId,
          budget: minorToUnits(afterMinor, currencyExponent(currency))
        })
      });
      return { beforeMinor, afterMinor };
    }
  };
}
