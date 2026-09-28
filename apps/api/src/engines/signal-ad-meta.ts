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

// docs/30 SIGNAL 5, ADR-0100. Meta Marketing API (Graph) against the
// `AdPlatform` seam (packages/core/src/seams.ts). A channel, not a suite
// (CLAUDE.md §13).
//
// Secrets: accessToken (a system-user token). Config: adAccountId (`act_…` or
// bare digits), optional conversionAction (the `actions[].action_type` that
// counts as a conversion, default `lead`), optional apiVersion, plus the
// `campaigns` map and `channel` the engine reads (ad-platform.ts).
//
// Shapes: `act_{id}/insights?level=campaign&time_increment=1` — spend as a
// decimal string in account currency, counts as strings, conversions inside
// `actions`, cursor paging by absolute `paging.next`. A campaign's
// `daily_budget` is already in the currency's minor unit. The token rides in
// the Authorization header, never in a URL.

export const META_GRAPH_VERSION = "v23.0";
const GRAPH_HOST = "graph.facebook.com";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;

interface InsightRow {
  campaign_id?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  account_currency?: string;
  actions?: ReadonlyArray<{ action_type?: string; value?: string }>;
}

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return new Error(`meta-ads ${res.status}: ${body?.error?.message ?? res.statusText}`);
}

export function metaAdsPlatform(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): AdPlatform {
  function session(secrets: ConnectorSecrets, config: Record<string, unknown>) {
    const token = secrets.accessToken;
    if (!token) throw new Error("meta-ads connector is missing secret accessToken");
    const account = String(config.adAccountId ?? "").replace(/^act_/, "");
    if (!DIGITS.test(account)) throw new Error("meta-ads config adAccountId is required (act_<digits>)");
    const version = typeof config.apiVersion === "string" && /^v\d+\.\d+$/.test(config.apiVersion) ? config.apiVersion : META_GRAPH_VERSION;
    const graph = `https://${GRAPH_HOST}/${version}`;
    const auth = { authorization: `Bearer ${token}` };
    const call = async (url: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetchImpl(url, { ...init, headers: { ...auth, ...(init?.headers as Record<string, string> | undefined) } });
      if (!res.ok) throw await failure(res);
      return res.json();
    };
    return { graph, account, call };
  }

  return {
    provider: "meta-ads",
    defaultChannel: "meta",
    // docs/17 SIG-032, ADR-0112. The Conversions API matches on the click id
    // Meta issued (as `fbc`) or on SHA-256 identifiers; the exporter supplies
    // the hashed ones only under data-sharing consent.
    conversionKeys: ["fbclid", "emailSha256", "phoneSha256"],
    // Meta rejects a server event whose event_time is more than 7 days old.
    conversionMaxAgeDays: 7,

    async uploadConversions(conversions, secrets, config): Promise<AdConversionResult[]> {
      const pixelId = String(config.pixelId ?? "");
      if (!DIGITS.test(pixelId)) throw new Error("meta-ads config pixelId is required to upload conversions");
      const eventName = typeof config.conversionEvent === "string" && /^\w{1,64}$/.test(config.conversionEvent) ? config.conversionEvent : "Purchase";
      const out = new Map<string, AdConversionResult>();
      const events: Record<string, unknown>[] = [];
      const sent: string[] = [];
      for (const c of conversions) {
        // Only the match keys — never a name, a birth date, a gender or any
        // other field Meta's user_data would accept (SIG-034).
        const userData: Record<string, unknown> = {};
        if (c.fbclid) userData.fbc = `fb.1.${c.at}.${c.fbclid}`;
        if (c.emailSha256?.length) userData.em = [...c.emailSha256];
        if (c.phoneSha256?.length) userData.ph = [...c.phoneSha256];
        if (!Object.keys(userData).length) {
          out.set(c.conversionId, { conversionId: c.conversionId, status: "failed", error: "no match key" });
          continue;
        }
        sent.push(c.conversionId);
        events.push({
          event_name: eventName,
          event_time: Math.floor(c.at / 1000),
          event_id: c.conversionId,
          action_source: "system_generated",
          user_data: userData,
          custom_data: { value: minorToUnits(c.valueMinor, currencyExponent(c.currency)), currency: c.currency }
        });
      }
      if (events.length) {
        const { graph, call } = session(secrets, config);
        const reply = (await call(`${graph}/${pixelId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: events })
        })) as { events_received?: number };
        // Meta takes a batch whole or not at all; anything short of all of it
        // is recorded as failed, and the next run offers it again.
        const whole = reply.events_received === events.length;
        for (const id of sent) {
          out.set(id, whole ? { conversionId: id, status: "sent" } : { conversionId: id, status: "failed", error: `meta-ads acknowledged ${reply.events_received ?? 0} of ${events.length} events` });
        }
      }
      return conversions.map((c) => out.get(c.conversionId)!);
    },

    async pullSpend(window: AdSpendWindow, secrets, config): Promise<AdSpendRow[]> {
      if (!DAY.test(window.since) || !DAY.test(window.until)) throw new Error("spend window must be two YYYY-MM-DD dates");
      const { graph, account, call } = session(secrets, config);
      const conversionAction = typeof config.conversionAction === "string" && config.conversionAction ? config.conversionAction : "lead";
      const params = new URLSearchParams({
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since: window.since, until: window.until }),
        fields: "campaign_id,spend,impressions,clicks,actions,account_currency",
        limit: "500"
      });
      const rows: InsightRow[] = [];
      let url: string | undefined = `${graph}/act_${account}/insights?${params}`;
      while (url) {
        const page = (await call(url)) as { data?: InsightRow[]; paging?: { next?: string } };
        rows.push(...(page.data ?? []));
        url = page.paging?.next;
        // The bearer token goes wherever `next` points, so it may only point home.
        if (url && new URL(url).host !== GRAPH_HOST) throw new Error("meta-ads paging link left the Graph API host");
      }
      return rows.map((r) => {
        const currency = r.account_currency ?? "";
        const conversions = (r.actions ?? [])
          .filter((a) => a.action_type === conversionAction)
          .reduce((sum, a) => sum + Number(a.value ?? 0), 0);
        return {
          externalCampaignId: String(r.campaign_id ?? ""),
          day: r.date_start ?? "",
          amountMinor: decimalToMinor(r.spend ?? "0", currencyExponent(currency)),
          currency,
          impressions: Number(r.impressions ?? 0),
          clicks: Number(r.clicks ?? 0),
          conversions: Math.round(conversions)
        };
      });
    },

    async adjustDailyBudget(externalCampaignId, deltaMinor, currency, secrets, config) {
      if (!DIGITS.test(externalCampaignId)) throw new Error(`not a meta-ads campaign id: ${externalCampaignId}`);
      const { graph, account, call } = session(secrets, config);
      const acct = (await call(`${graph}/act_${account}?fields=currency`)) as { currency?: string };
      if (acct.currency !== currency) throw new Error(`meta-ads account bills in ${acct.currency ?? "an unknown currency"}, the move is in ${currency}`);
      const campaign = (await call(`${graph}/${externalCampaignId}?fields=daily_budget`)) as { daily_budget?: string };
      // Without campaign budget optimisation the money sits on each ad set;
      // spreading a move across them would be a guess, so it is refused.
      if (!campaign.daily_budget || !DIGITS.test(campaign.daily_budget) || campaign.daily_budget === "0") {
        throw new Error(`meta-ads campaign ${externalCampaignId} has no campaign daily budget (it is set per ad set)`);
      }
      const beforeMinor = Number(campaign.daily_budget);
      const afterMinor = applyBudgetDelta(beforeMinor, deltaMinor);
      const done = (await call(`${graph}/${externalCampaignId}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ daily_budget: String(afterMinor) }).toString()
      })) as { success?: boolean };
      if (done.success !== true) throw new Error(`meta-ads did not confirm the budget change on ${externalCampaignId}`);
      return { beforeMinor, afterMinor };
    }
  };
}
