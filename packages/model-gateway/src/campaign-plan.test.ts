import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_CHANNELS,
  campaignPlanEvidenceLines,
  campaignPlanMessages,
  campaignPlanSchema,
  creativeContextLines,
  fallbackCampaignPlan,
  parseCampaignPlan,
  type CampaignPlan,
  type CampaignPlanEvidence,
  type PlanAudience
} from "./campaign-plan.js";
import { promptNouns } from "./vocabulary.js";
import { knowledgeBlock } from "./knowledge.js";

const AUDIENCE: PlanAudience = {
  name: "Gauteng upper-middle",
  summary: "Upper-middle households in Gauteng who already hold cover with us.",
  estimatedReach: 120,
  lsm: [7, 8],
  reasons: [
    { axis: "region", value: "gauteng", reason: "The largest region on the book.", count: 200 },
    { axis: "lsm", value: "7", reason: "The band that buys most often.", count: 120 }
  ]
};

const EV: CampaignPlanEvidence = {
  subject: "cyber cover",
  objective: "acq",
  proposition: "Cover for a small business the day it is breached.",
  momentum: 78,
  signalCount: 220,
  coverage: 12,
  competitionScore: 41,
  bookSize: 400,
  audience: AUDIENCE
};
const NOUNS = promptNouns(undefined);
const RETAIL = promptNouns("retail-ecom");

const OPTION = {
  name: "Direct to the pool",
  angle: "Speak only to the households already holding cover.",
  offer: "Cyber cover added to an existing policy at renewal.",
  channels: ["email", "meta"],
  probability: 62,
  why: ["120 reachable customers already sit in the pool."],
  risk: "A pool of 120 burns out fast."
};
const GOOD = {
  notes: "Demand runs at 78 while only 12 percent of the book holds this line, so the headroom is real.",
  options: [
    OPTION,
    {
      name: "Intent capture",
      angle: "Buy the searches people already make.",
      offer: "A quote in under a minute.",
      channels: ["google_search"],
      probability: 44,
      why: ["Competitive pressure of 41 still leaves search affordable."],
      risk: null
    },
    {
      name: "Broad build",
      angle: "Reach past the pool to the rest of the book.",
      offer: "An introduction for customers holding none.",
      channels: ["display", "youtube"],
      probability: 27,
      why: ["400 customers are on the book."],
      risk: null
    }
  ]
};

const reply = (over: Record<string, unknown>): string => JSON.stringify({ ...GOOD, ...over });
const one = (over: Record<string, unknown>): string => JSON.stringify({ notes: GOOD.notes, options: [{ ...OPTION, ...over }] });

describe("parseCampaignPlan", () => {
  it("keeps three grounded options and recommends the likeliest", () => {
    const plan = parseCampaignPlan(reply({}), EV, NOUNS);
    expect(plan?.notes).toBe(GOOD.notes);
    expect(plan?.options).toHaveLength(3);
    expect(plan?.recommended).toBe("Direct to the pool");
    expect(plan?.confidence).toBe(100);
    expect(plan?.options[0]).toEqual({
      name: OPTION.name,
      angle: OPTION.angle,
      offer: OPTION.offer,
      channels: ["email", "meta"],
      probability: 62,
      why: OPTION.why,
      risk: OPTION.risk
    });
  });

  it("ranks by probability rather than by the order the model wrote them in", () => {
    const shuffled = [GOOD.options[2]!, GOOD.options[0]!, GOOD.options[1]!];
    const plan = parseCampaignPlan(reply({ options: shuffled }), EV, NOUNS);
    expect(plan?.options.map((o) => o.probability)).toEqual([62, 44, 27]);
    expect(plan?.recommended).toBe("Direct to the pool");
  });

  it("strips a ```json fence", () => {
    expect(parseCampaignPlan("```json\n" + reply({}) + "\n```", EV, NOUNS)?.options).toHaveLength(3);
  });

  it("is null for a reply that is not JSON at all", () => {
    expect(parseCampaignPlan("no plan.", EV, NOUNS)).toBeNull();
  });

  it("is null without notes — a plan nobody argued is not inspectable", () => {
    expect(parseCampaignPlan(reply({ notes: "   " }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(reply({ notes: 78 }), EV, NOUNS)).toBeNull();
  });

  it("is null when the notes state a figure the evidence never gave", () => {
    expect(parseCampaignPlan(reply({ notes: "Demand runs at 9,412 across the book." }), EV, NOUNS)).toBeNull();
  });

  it("is null when options is empty or not a list", () => {
    expect(parseCampaignPlan(reply({ options: [] }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(reply({ options: "three of them" }), EV, NOUNS)).toBeNull();
  });

  it("truncates very long notes rather than dropping the plan", () => {
    // Digit-free, so length is the only thing under test.
    expect(parseCampaignPlan(reply({ notes: "x".repeat(2000) }), EV, NOUNS)?.notes).toHaveLength(1200);
  });

  it("drops one ungrounded option and reports the loss as confidence", () => {
    const plan = parseCampaignPlan(
      reply({
        options: [
          ...GOOD.options.slice(0, 2),
          { ...GOOD.options[2]!, why: ["9,412 customers are on the book."] }
        ]
      }),
      EV,
      NOUNS
    );
    expect(plan?.options).toHaveLength(2);
    expect(plan?.confidence).toBe(67);
  });

  it("lets an option cite its own probability, which no evidence line contains", () => {
    const plan = parseCampaignPlan(one({ why: ["A 62 in 100 chance against this pool."] }), EV, NOUNS);
    expect(plan?.options[0]?.why).toEqual(["A 62 in 100 chance against this pool."]);
  });

  it("drops an option missing a name, an angle or an offer", () => {
    expect(parseCampaignPlan(one({ name: " " }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(one({ angle: null }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(one({ offer: "" }), EV, NOUNS)).toBeNull();
  });

  it("drops an option whose probability is not a whole 0-100", () => {
    for (const probability of [62.5, -1, 101, "62", null, Number.NaN]) {
      expect(parseCampaignPlan(one({ probability }), EV, NOUNS)).toBeNull();
    }
  });

  it("keeps the boundary probabilities", () => {
    expect(parseCampaignPlan(one({ probability: 0 }), EV, NOUNS)?.options[0]?.probability).toBe(0);
    expect(parseCampaignPlan(one({ probability: 100 }), EV, NOUNS)?.options[0]?.probability).toBe(100);
  });

  it("normalises channel casing and spacing", () => {
    expect(parseCampaignPlan(one({ channels: [" Google_Search ", "META"] }), EV, NOUNS)?.options[0]?.channels).toEqual([
      "google_search",
      "meta"
    ]);
  });

  it("drops an invented channel but keeps the runnable ones", () => {
    expect(parseCampaignPlan(one({ channels: ["carrier_pigeon", "email", 7] }), EV, NOUNS)?.options[0]?.channels).toEqual(
      ["email"]
    );
  });

  it("de-duplicates channels so a plan does not double-count its spend", () => {
    expect(parseCampaignPlan(one({ channels: ["email", "Email", "email"] }), EV, NOUNS)?.options[0]?.channels).toEqual([
      "email"
    ]);
  });

  it("drops an option with no channel anybody could run", () => {
    expect(parseCampaignPlan(one({ channels: ["carrier_pigeon"] }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(one({ channels: [] }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(one({ channels: "email" }), EV, NOUNS)).toBeNull();
  });

  it("drops an option with no usable why", () => {
    expect(parseCampaignPlan(one({ why: [] }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(one({ why: ["  ", 7] }), EV, NOUNS)).toBeNull();
    expect(parseCampaignPlan(one({ why: "because" }), EV, NOUNS)).toBeNull();
  });

  it("keeps the grounded why lines and de-duplicates them", () => {
    const plan = parseCampaignPlan(
      one({ why: ["400 customers are on the book.", "9,412 of them are new.", "400 customers are on the book."] }),
      EV,
      NOUNS
    );
    expect(plan?.options[0]?.why).toEqual(["400 customers are on the book."]);
  });

  it("nulls an ungrounded risk rather than the option that carries it", () => {
    const plan = parseCampaignPlan(one({ risk: "All 9,412 could churn." }), EV, NOUNS);
    expect(plan?.options[0]?.risk).toBeNull();
    expect(plan?.options[0]?.why).toEqual(OPTION.why);
  });

  it("nulls an absent risk without complaint", () => {
    expect(parseCampaignPlan(one({ risk: undefined }), EV, NOUNS)?.options[0]?.risk).toBeNull();
  });

  it("drops a second option under a name it already has — reworded is not alternative", () => {
    const plan = parseCampaignPlan(
      reply({ options: [OPTION, { ...GOOD.options[1]!, name: "DIRECT TO THE POOL" }] }),
      EV,
      NOUNS
    );
    expect(plan?.options).toHaveLength(1);
    expect(plan?.confidence).toBe(50);
  });

  it("skips an option that is not an object", () => {
    const plan = parseCampaignPlan(reply({ options: [null, "meta", OPTION] }), EV, NOUNS);
    expect(plan?.options).toHaveLength(1);
    expect(plan?.confidence).toBe(33);
  });

  it("is null when every option was thrown away", () => {
    expect(parseCampaignPlan(reply({ options: [{ name: "x" }, 7] }), EV, NOUNS)).toBeNull();
  });
});

describe("campaignPlanEvidenceLines", () => {
  it("states the demand, the book and every band of the pool", () => {
    expect(campaignPlanEvidenceLines(EV, NOUNS)).toEqual([
      "Campaign subject: cyber cover",
      "Objective: acq",
      "Proposition from the market brief: Cover for a small business the day it is breached.",
      "Demand momentum score (0-100): 78",
      "Demand signals behind this subject: 220",
      "Share of the book already holding this line (%): 12",
      "Competitive pressure score (0-100): 41",
      "Customers in the book: 400",
      "Spend buys policies; every figure below counts customers, not policies.",
      "Audience: Gauteng upper-middle",
      "Audience summary: Upper-middle households in Gauteng who already hold cover with us.",
      "Reachable customers in this audience: 120",
      "LSM bands in the pool: 7, 8",
      "Audience band region=gauteng: 200 customers. The largest region on the book.",
      "Audience band lsm=7: 120 customers. The band that buys most often."
    ]);
  });

  it("omits every unmeasured fact rather than writing it as unknown", () => {
    const bare = campaignPlanEvidenceLines(
      { ...EV, proposition: null, momentum: null, signalCount: null, coverage: null, competitionScore: null },
      NOUNS
    );
    expect(bare).toEqual([
      "Campaign subject: cyber cover",
      "Objective: acq",
      "Customers in the book: 400",
      "Spend buys policies; every figure below counts customers, not policies.",
      "Audience: Gauteng upper-middle",
      "Audience summary: Upper-middle households in Gauteng who already hold cover with us.",
      "Reachable customers in this audience: 120",
      "LSM bands in the pool: 7, 8",
      "Audience band region=gauteng: 200 customers. The largest region on the book.",
      "Audience band lsm=7: 120 customers. The band that buys most often."
    ]);
  });

  it("keeps a measured zero", () => {
    const lines = campaignPlanEvidenceLines({ ...EV, coverage: 0, competitionScore: 0 }, NOUNS);
    expect(lines).toContain("Share of the book already holding this line (%): 0");
    expect(lines).toContain("Competitive pressure score (0-100): 0");
  });

  it("says plainly there is no pool, rather than leaving the model to guess", () => {
    const lines = campaignPlanEvidenceLines({ ...EV, audience: null }, NOUNS);
    expect(lines.at(-1)).toBe("No audience pool has been proposed yet; plan for the whole book.");
    expect(lines.join("\n")).not.toContain("Audience:");
  });

  it("omits the LSM line for a pack that does not band on it", () => {
    const lines = campaignPlanEvidenceLines({ ...EV, audience: { ...AUDIENCE, lsm: [] } }, NOUNS);
    expect(lines.join("\n")).not.toContain("LSM bands");
  });

  it("names the band list after the active pack's affluence scale", () => {
    const audience: PlanAudience = { ...AUDIENCE, pack: "insurance-gulf", lsm: [4, 5] };
    const lines = campaignPlanEvidenceLines({ ...EV, audience }, NOUNS);
    expect(lines).toContain("Income quintile bands in the pool: 4, 5");
    expect(lines.join("\n")).not.toContain("LSM");
  });

  it("reads the contract noun off the domain pack", () => {
    expect(campaignPlanEvidenceLines(EV, RETAIL)).toContain(
      "Spend buys orders; every figure below counts customers, not orders."
    );
  });
});

describe("campaignPlanSchema", () => {
  it("bounds the probability and the channel list in the schema itself", () => {
    expect(campaignPlanSchema()).toEqual({
      name: "signal_campaign_plan",
      schema: {
        type: "object",
        properties: {
          notes: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                angle: { type: "string" },
                offer: { type: "string" },
                channels: { type: "array", items: { type: "string", enum: [...CAMPAIGN_CHANNELS] } },
                probability: { type: "integer", minimum: 0, maximum: 100 },
                why: { type: "array", items: { type: "string" } },
                risk: { type: "string" }
              },
              required: ["name", "angle", "offer", "channels", "probability", "why"]
            }
          }
        },
        required: ["notes", "options"]
      }
    });
  });

  it("does not require a risk — an option may have none", () => {
    const schema = campaignPlanSchema().schema as {
      properties: { options: { items: { required: string[] } } };
    };
    expect(schema.properties.options.items.required).not.toContain("risk");
  });
});

describe("campaignPlanMessages", () => {
  const messages = campaignPlanMessages(EV, NOUNS);

  it("sends one system prompt then the evidence as the user turn", () => {
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]?.content).toBe(campaignPlanEvidenceLines(EV, NOUNS).join("\n"));
  });

  it("asks for three genuinely different options at differing odds", () => {
    const system = messages[0]?.content ?? "";
    expect(system).toContain("exactly three options");
    expect(system).toContain("not the same idea reworded");
    expect(system).toContain("make the three probabilities differ");
  });

  it("asks for the reading behind the choice, not only the choice", () => {
    const system = messages[0]?.content ?? "";
    expect(system).toContain("Notes are your reading of the demand");
    expect(system).toContain("what a marketer should worry about");
  });

  // The knowledge pack (knowledge.ts) attached by the SIGNAL planner. Context,
  // not evidence: it must reach the system turn and must never reach the
  // evidence lines, or a model could cite a market fact as the tenant's data.
  it("carries the tenant's world when the caller supplies it", () => {
    const knowledge = knowledgeBlock("insurance-gulf", { markets: ["AE"] });
    const withKnowledge = campaignPlanMessages(EV, NOUNS, knowledge);
    expect(withKnowledge[0]?.content).toContain("pack insurance-gulf");
    expect(withKnowledge[0]?.content).toContain("CBUAE");
    expect(withKnowledge[1]?.content).toBe(campaignPlanEvidenceLines(EV, NOUNS).join("\n"));
  });

  it("is byte-identical to what it was when no knowledge is supplied", () => {
    // A caller that has not adopted the pack keeps the prompt it had, so an
    // existing eval's fixture does not silently change under it.
    expect(campaignPlanMessages(EV, NOUNS)[0]?.content).toBe(messages[0]?.content);
    expect(campaignPlanMessages(EV, NOUNS, "")[0]?.content).toBe(messages[0]?.content);
  });

  it("names every runnable channel, so a discarded option is the model's own fault", () => {
    const system = messages[0]?.content ?? "";
    for (const channel of CAMPAIGN_CHANNELS) expect(system).toContain(channel);
    expect(system).toContain("An option naming a channel outside it is discarded");
  });

  it("forbids unevidenced numbers and self-citing the probability", () => {
    const system = messages[0]?.content ?? "";
    expect(system).toContain("citing only numbers the evidence below gave you");
    expect(system).toContain("Do not restate your own probability in the why lines");
    expect(system).toContain("An option with no reasons is discarded");
  });

  it("points the offer at the pool rather than at a generic customer", () => {
    const system = messages[0]?.content ?? "";
    expect(system).toContain("Write the offer for the audience described below");
    expect(system).toContain("never to a generic customer");
  });

  it("names the protected grounds and leaves the funding to a human", () => {
    const system = messages[0]?.content ?? "";
    for (const ground of ["race", "religion", "health", "disability", "criminal record"]) {
      expect(system).toContain(ground);
    }
    expect(system).toContain("A human funds this");
    expect(system).toContain("you never see a person");
  });

  it("names the pack's domain, not a hard-coded industry", () => {
    const system = campaignPlanMessages(EV, RETAIL)[0]?.content ?? "";
    expect(system).toContain("You plan retail commerce marketing campaigns");
    expect(system).not.toContain("insurance");
  });
});

describe("fallbackCampaignPlan", () => {
  it("derives three ranked options from momentum and headroom alone", () => {
    const plan = fallbackCampaignPlan(EV, NOUNS);
    // (78 momentum + 88 headroom) / 2 = 83, then -12 and -25.
    expect(plan.options.map((o) => o.probability)).toEqual([83, 71, 58]);
    expect(plan.recommended).toBe("cyber cover — direct to the pool");
    expect(plan.options.map((o) => o.name)).toEqual([
      "cyber cover — direct to the pool",
      "cyber cover — intent capture",
      "cyber cover — broad build"
    ]);
  });

  it("carries zero confidence and says outright that nothing chose it", () => {
    const plan = fallbackCampaignPlan(EV, NOUNS);
    expect(plan.confidence).toBe(0);
    expect(plan.notes).toContain("No model planned this campaign");
  });

  it("gives every option a channel and a reason, so it survives its own parser", () => {
    const plan = fallbackCampaignPlan(EV, NOUNS);
    expect(parseCampaignPlan(JSON.stringify(plan), EV, NOUNS)).toMatchObject({
      recommended: plan.recommended,
      confidence: 100
    });
  });

  it("assumes a middling demand when nothing has been measured", () => {
    // momentum defaults to 50, coverage to 0 headroom 100 → base 75.
    const plan = fallbackCampaignPlan({ ...EV, momentum: null, coverage: null }, NOUNS);
    expect(plan.options.map((o) => o.probability)).toEqual([75, 63, 50]);
  });

  it("never reads as a measurement — bounded to 10..90 at both ends", () => {
    const certain = fallbackCampaignPlan({ ...EV, momentum: 100, coverage: 0 }, NOUNS);
    expect(certain.options[0]?.probability).toBe(90);
    const hopeless = fallbackCampaignPlan({ ...EV, momentum: 0, coverage: 100 }, NOUNS);
    expect(hopeless.options.map((o) => o.probability)).toEqual([10, 10, 10]);
  });

  it("plans at the whole book when no pool was proposed", () => {
    const plan = fallbackCampaignPlan({ ...EV, audience: null }, NOUNS);
    expect(plan.options[0]?.angle).toContain("the whole book of 400 customers");
    expect(plan.options[0]?.why).toEqual(["Demand momentum sits at 78 against 400 reachable customers."]);
  });

  it("plans at the pool when there is one", () => {
    expect(fallbackCampaignPlan(EV, NOUNS).options[0]?.angle).toContain("the proposed pool of 120 customers");
  });

  it("reads the contract noun off the domain pack", () => {
    const plan = fallbackCampaignPlan(EV, RETAIL);
    expect(plan.options[0]?.offer).toBe("The order priced for the band that already carries the most customers.");
    expect(plan.notes).toContain("momentum 78 on orders");
  });
});

describe("creativeContextLines", () => {
  const plan = parseCampaignPlan(reply({}), EV, NOUNS) as CampaignPlan;

  it("hands the copy generator the chosen option and the bands behind it", () => {
    expect(creativeContextLines(plan, "Intent capture", AUDIENCE)).toEqual([
      "Campaign approach: Intent capture",
      "Angle: Buy the searches people already make.",
      "Offer: A quote in under a minute.",
      "Channels: google_search",
      `Planner's notes: ${GOOD.notes}`,
      "Written for: Upper-middle households in Gauteng who already hold cover with us.",
      "LSM bands: 7, 8",
      "Audience band region=gauteng: The largest region on the book.",
      "Audience band lsm=7: The band that buys most often."
    ]);
  });

  it("falls back to the recommended option when the named one is gone", () => {
    expect(creativeContextLines(plan, "an option somebody deleted", null)[0]).toBe(
      "Campaign approach: Direct to the pool"
    );
  });

  it("writes nothing about an audience it does not have", () => {
    const lines = creativeContextLines(plan, "Direct to the pool", null);
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).not.toContain("Written for");
  });

  it("gives the copy generator the pack's own scale name", () => {
    const audience: PlanAudience = { ...AUDIENCE, pack: "insurance-gulf", lsm: [4, 5] };
    expect(creativeContextLines(plan, "Intent capture", audience)).toContain("Income quintile bands: 4, 5");
  });

  it("omits the LSM line for a pool with no bands", () => {
    const lines = creativeContextLines(plan, "Direct to the pool", { ...AUDIENCE, lsm: [] });
    expect(lines.join("\n")).not.toContain("LSM bands");
    expect(lines).toContain("Written for: Upper-middle households in Gauteng who already hold cover with us.");
  });

  it("returns nothing for a plan with no options rather than inventing one", () => {
    expect(creativeContextLines({ notes: "none", options: [], recommended: "", confidence: 0 }, "x", AUDIENCE)).toEqual(
      []
    );
  });

  it("joins every channel, so the copy knows it is writing for more than one", () => {
    expect(creativeContextLines(plan, "Broad build", null)).toContain("Channels: display, youtube");
  });
});
