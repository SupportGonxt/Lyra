import { describe, expect, it, vi } from "vitest";

const { api, fetchMe } = vi.hoisted(() => ({ api: vi.fn(), fetchMe: vi.fn() }));
vi.mock("../api.server", async () => {
  const { ApiError } = await import("../api-error");
  return { api, fetchMe, ApiError };
});
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { ApiError } from "../api-error";
import { action, campaignDraft, draftBrief, labelsIn, problemKey } from "./journey-signal";

const post = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: new Request("https://lyra.test/journey/signal", { method: "POST", body: form }),
    context: { get: () => ({ env: {} }) },
    params: {}
  } as never;
};

const whitespace = {
  whitespaceId: "wsp_1",
  category: "EV motor cover",
  status: "validating",
  commentary: "EV owners are quoted and rarely bind.",
  why: ["Demand signals behind this candidate: 4"],
  ai: null,
  suppressed: false
};

describe("draftBrief", () => {
  // The action took `whitespaceId` off the form and threw it away: the copy was
  // briefed from the audience summary alone, so Marketing never heard what the
  // Market step found.
  it("carries the whitespace the reader chose into the brief", () => {
    const brief = draftBrief({ subject: "EV motor cover", summary: "Young EV owners.", whitespace });
    expect(brief).toContain("EV motor cover");
    expect(brief).toContain("EV owners are quoted and rarely bind.");
    expect(brief).toContain("Demand signals behind this candidate: 4");
    expect(brief).toContain("Young EV owners.");
  });

  it("still briefs from the audience when the whitespace could not be read", () => {
    expect(draftBrief({ subject: "Home", summary: "Renters.", whitespace: null })).toBe("Home\n\nRenters.");
  });

  it("stays inside the API's 4,000-character bound", () => {
    const long = { ...whitespace, why: Array.from({ length: 400 }, (_, i) => `reason ${i} `.repeat(4)) };
    expect(draftBrief({ subject: "x", summary: "y", whitespace: long }).length).toBeLessThanOrEqual(4000);
  });
});

describe("campaignDraft", () => {
  it("is a draft with no spend and never names a state", () => {
    expect("audienceId" in campaignDraft({ subject: "x", audienceId: "", audienceName: "", ownerRef: "u", currency: "AED" })).toBe(
      false
    );
    const body = campaignDraft({
      subject: "EV motor cover",
      audienceId: "aud_1",
      audienceName: "Young EV owners",
      ownerRef: "user:usr_1",
      currency: "AED"
    });
    expect(body).toEqual({
      name: "EV motor cover — Young EV owners",
      objective: "acq",
      audienceId: "aud_1",
      channelsJson: [],
      budgetJson: { currency: "AED", dailyMinor: 0, totalMinor: 0 },
      ownerRef: "user:usr_1"
    });
    // A launch is `signal.campaign_launch` on update; a create that named its
    // own state would walk around it.
    expect("state" in body).toBe(false);
  });
});

describe("problemKey", () => {
  it("never shows a raw API title", () => {
    const l = labelsIn("ar");
    for (const problem of [
      { title: "subject_required", status: 400 },
      { title: "brief_required", status: 400 },
      { title: "Forbidden", status: 403 },
      { title: "internal", status: 500 },
      { title: "something_new", status: 400 }
    ]) {
      const key = problemKey(problem);
      expect(l(key)).not.toBe(key);
      expect(l(key)).not.toContain(problem.title);
    }
  });
});

describe("action", () => {
  it("refuses an empty subject in words, not a code", async () => {
    const result = await action(post({ intent: "suggest_audience", subject: " " }));
    expect(result.problem?.title).toBe("subject_required");
  });

  it("drafts creatives against the chosen whitespace", async () => {
    api.mockReset();
    api.mockImplementation(async (path: string) => {
      if (path === "/v1/scout/whitespaces/wsp_1/commentary") return whitespace;
      if (path === "/v1/signal/creatives/generate") return { variants: [], auditIds: [] };
      throw new Error(`unexpected ${path}`);
    });
    await action(
      post({ intent: "generate_creatives", brief: "Young EV owners.", subject: "EV motor cover", whitespaceId: "wsp_1" })
    );
    const generate = api.mock.calls.find(([path]) => path === "/v1/signal/creatives/generate");
    expect((generate?.[1] as { body: { brief: string } }).body.brief).toContain("EV owners are quoted and rarely bind.");
  });

  it("drafts creatives from the audience alone when the whitespace is not readable", async () => {
    api.mockReset();
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/scout/")) throw new ApiError({ title: "forbidden", status: 403 }, "req_1");
      return { variants: [], auditIds: [] };
    });
    const result = await action(
      post({ intent: "generate_creatives", brief: "Renters.", subject: "Home", whitespaceId: "wsp_1" })
    );
    expect(result.problem).toBeNull();
    expect(result.creatives).toEqual({ variants: [], auditIds: [] });
  });

  it("saves a draft campaign once per audience, and does not launch it", async () => {
    api.mockReset();
    fetchMe.mockReset();
    fetchMe.mockResolvedValue({ actor: { kind: "user", id: "usr_1" }, policy: { currency: "AED" } });
    api.mockResolvedValue({ id: "cmp_1", name: "EV motor cover — Young EV owners", state: "draft" });
    const result = await action(
      post({ intent: "save_draft", subject: "EV motor cover", audienceId: "aud_1", audienceName: "Young EV owners" })
    );
    expect(api).toHaveBeenCalledTimes(1);
    const [path, options] = api.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: unknown }];
    expect(path).toBe("/v1/signal/campaigns");
    expect(options.method).toBe("POST");
    // Keyed to the actor as well: two people drafting against the same
    // audience must not be handed each other's campaign as a replay.
    expect(options.headers["idempotency-key"]).toBe("journey-draft:usr_1:aud_1");
    expect(options.body).toMatchObject({ audienceId: "aud_1", ownerRef: "user:usr_1" });
    expect(result.campaign).toEqual({ id: "cmp_1", name: "EV motor cover — Young EV owners", state: "draft" });
  });

  it("saves a draft with no audience yet, keyed to the whitespace it came from", async () => {
    api.mockReset();
    fetchMe.mockReset();
    fetchMe.mockResolvedValue({ actor: { kind: "user", id: "usr_1" }, policy: { currency: "AED" } });
    api.mockResolvedValue({ id: "cmp_2", name: "Home", state: "draft" });
    const result = await action(post({ intent: "save_draft", subject: "Home", whitespaceId: "wsp_1", audienceId: "" }));
    const [, options] = api.mock.calls[0] as [string, { headers: Record<string, string>; body: Record<string, unknown> }];
    expect(options.headers["idempotency-key"]).toBe("journey-draft:usr_1:wsp_1");
    expect("audienceId" in options.body).toBe(false);
    expect(result.campaign?.id).toBe("cmp_2");
  });

  it("will not save a draft about nothing", async () => {
    api.mockReset();
    const result = await action(post({ intent: "save_draft", subject: " ", audienceId: "" }));
    expect(result.problem?.title).toBe("subject_required");
    expect(api).not.toHaveBeenCalled();
  });

  it("says why no audience can be proposed when the book is too thin to target", async () => {
    // apps/api/src/engines/signal-audience.ts answers 409 when no attribute
    // survives the k-anonymity floor: that is a fact about the book, not a
    // failure worth "try again".
    api.mockReset();
    api.mockImplementation(async () => {
      throw new ApiError({ title: "Conflict", status: 409 }, "req_2");
    });
    const result = await action(post({ intent: "suggest_audience", subject: "Home" }));
    expect(result.problem?.title).toBe("no_pool");
    expect(labelsIn("en")(problemKey(result.problem!))).toMatch(/not enough customers/);
  });

  it("passes a refusal through with its request id", async () => {
    api.mockReset();
    api.mockImplementation(async () => {
      throw new ApiError({ title: "Forbidden", status: 403 }, "req_9");
    });
    const result = await action(post({ intent: "suggest_audience", subject: "Home" }));
    expect(result.problem).toMatchObject({ status: 403, requestId: "req_9" });
  });
});
