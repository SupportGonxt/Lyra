import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The keystore is a native module; the contract this test cares about is that
// the token round-trips through it under one key and that a keystore that
// throws reads as "signed out" rather than as a crash.
const store = new Map<string, string>();
const failing = { get: false, set: false, del: false };

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (failing.set) throw new Error("keystore unavailable");
    store.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => {
    if (failing.get) throw new Error("keystore unavailable");
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (failing.del) throw new Error("keystore unavailable");
    store.delete(key);
  })
}));

const {
  clearPendingRecoveryCodes,
  clearToken,
  readPendingRecoveryCodes,
  readToken,
  savePendingRecoveryCodes,
  saveToken
} = await import("./token");
const { entriesFor, labelKeyFor, navKeyFor, navTitle, resourceFor, resourceForNavKey, routeFor } =
  await import("./nav");
const { humanize, subtitleOf, titleOf, fieldsOf } = await import("./rows");
const { CATALOGUES, en, dirFor, joinList, resolveLocale, translator } = await import("./i18n");
const { fontFamilyFor, themeFor, productName } = await import("./theme");
const { defaultWorkspaceForRoles, resolvePersona } = await import("./workspace");
const { PERSONA_TABS, tabsFor } = await import("./personas");
const { confirmConsequential, resolveGate } = await import("./biometric-gate");
const { fetchNames, shortRef, who } = await import("./names");
const {
  DOC_TYPES,
  approvalAmountMinor,
  approvalTitle,
  bps,
  boardpackOrder,
  budgetOf,
  byId,
  campaignOrder,
  cacMinor,
  caseSeverity,
  channelLabel,
  anomalyOwner,
  briefNarrative,
  canTakeAnomaly,
  chosenBriefing,
  clusterOrder,
  contentTypeOf,
  daysUntil,
  decisionOrder,
  deltaPct,
  dsarOrder,
  dsarStanding,
  dueIn,
  highlightsOf,
  hoursSince,
  indexText,
  isInbound,
  latestPeriod,
  ltvMinor,
  ltvToCac,
  mainCurrency,
  moneyText,
  multipleText,
  optionCount,
  opportunityOf,
  pacingOf,
  plannedMinor,
  positionOf,
  queueOrder,
  renewalOrder,
  rollByChannel,
  rollByProvider,
  sectionCount,
  spendByCampaign,
  threadOrder,
  todayIso,
  txnOrder,
  txnStanding,
  urgencyOf,
  unownedAnomaly,
  whitespaceOrder
} = await import("./journeys");
const {
  ApiError,
  NetworkError,
  REQUEST_TIMEOUT_MS,
  decideApproval,
  endsSession,
  fetchInbox,
  generateBriefing,
  listRows,
  markNotificationRead,
  mfaStepOf,
  replyToConversation,
  request,
  setOnSessionEnd,
  stepAfterClearing,
  stepAfterLogin,
  takeAnomaly,
  uploadDocument,
  verifyThenLoad
} = await import("./api");

describe("token store", () => {
  beforeEach(() => {
    store.clear();
    failing.get = failing.set = failing.del = false;
  });

  it("has nothing before a sign-in", async () => {
    await expect(readToken()).resolves.toBeNull();
  });

  it("round-trips a session token and clears it on sign-out", async () => {
    await saveToken("ses_abc123");
    await expect(readToken()).resolves.toBe("ses_abc123");
    await clearToken();
    await expect(readToken()).resolves.toBeNull();
  });

  it("keeps the token under exactly one key, device-only", async () => {
    const SecureStore = await import("expo-secure-store");
    await saveToken("ses_abc123");
    expect([...store.keys()]).toEqual(["lyra.session.token"]);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "lyra.session.token",
      "ses_abc123",
      expect.objectContaining({ keychainAccessible: "whenUnlockedThisDeviceOnly" })
    );
  });

  it("reads an unreadable keystore as signed out, not as a crash", async () => {
    await saveToken("ses_abc123");
    failing.get = true;
    await expect(readToken()).resolves.toBeNull();
  });

  it("does not throw when clearing a keystore that refuses", async () => {
    failing.del = true;
    await expect(clearToken()).resolves.toBeUndefined();
  });
});

describe("pending recovery codes", () => {
  beforeEach(() => {
    store.clear();
    failing.get = failing.set = failing.del = false;
  });

  it("round-trips codes until the user confirms saving them", async () => {
    await expect(readPendingRecoveryCodes()).resolves.toBeNull();
    await savePendingRecoveryCodes(["AAAA-BBBB", "CCCC-DDDD"]);
    await expect(readPendingRecoveryCodes()).resolves.toEqual(["AAAA-BBBB", "CCCC-DDDD"]);
    await clearPendingRecoveryCodes();
    await expect(readPendingRecoveryCodes()).resolves.toBeNull();
  });

  it("keeps the codes out of the session token's key", async () => {
    await savePendingRecoveryCodes(["AAAA-BBBB"]);
    expect([...store.keys()]).toEqual(["lyra.mfa.pendingRecoveryCodes"]);
  });

  it("reads garbage or an unreadable keystore as no pending codes", async () => {
    store.set("lyra.mfa.pendingRecoveryCodes", "not json");
    await expect(readPendingRecoveryCodes()).resolves.toBeNull();
    store.set("lyra.mfa.pendingRecoveryCodes", JSON.stringify({ nope: true }));
    await expect(readPendingRecoveryCodes()).resolves.toBeNull();
    failing.get = true;
    await expect(readPendingRecoveryCodes()).resolves.toBeNull();
    failing.del = true;
    await expect(clearPendingRecoveryCodes()).resolves.toBeUndefined();
  });
});

describe("request plumbing", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setOnSessionEnd(null);
  });

  it("reads a 401 outside /v1/auth as the end of the session", () => {
    expect(endsSession("/v1/axis/cases", 401)).toBe(true);
    expect(endsSession("/v1/me", 401)).toBe(true);
    expect(endsSession("/v1/auth/login", 401)).toBe(false);
    expect(endsSession("/v1/auth/mfa/verify", 401)).toBe(false);
    expect(endsSession("/v1/axis/cases", 403)).toBe(false);
  });

  it("tells the session when an authenticated call answers 401", async () => {
    const ended = vi.fn();
    setOnSessionEnd(ended);
    vi.stubGlobal("fetch", vi.fn(async () => json({ title: "unauthorized", status: 401 }, 401)));
    await expect(request("/v1/axis/cases", { token: "dead" })).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("does not read a wrong password or code as a dead session", async () => {
    const ended = vi.fn();
    setOnSessionEnd(ended);
    vi.stubGlobal("fetch", vi.fn(async () => json({ title: "unauthorized", status: 401 }, 401)));
    await expect(
      request("/v1/auth/login", { method: "POST", body: { email: "a@b.co" } })
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      request("/v1/auth/mfa/verify", { method: "POST", token: "t", body: { code: "1" } })
    ).rejects.toBeInstanceOf(ApiError);
    expect(ended).not.toHaveBeenCalled();
  });

  it("asks for the next page with the cursor, and the first page without one", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return json({ data: [] });
      })
    );
    await listRows("t", "axis/cases");
    await listRows("t", "axis/cases", undefined, "cur/+1");
    expect(urls[0]).toContain("limit=50");
    expect(urls[0]).not.toContain("cursor");
    expect(urls[1]).toContain(`cursor=${encodeURIComponent("cur/+1")}`);
  });

  it("aborts a hung request as a NetworkError instead of spinning forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      )
    );
    const pending = request("/v1/axis/cases", { token: "t" });
    const failure = expect(pending).rejects.toBeInstanceOf(NetworkError);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await failure;
  });
});

describe("nav mapping", () => {
  // The hrefs apps/api/src/routes/me.ts can return. If that list grows, this
  // test fails before a nav item can ship as a dead row on mobile.
  const API_HREFS = [
    "/",
    "/axis",
    "/orbit",
    "/signal",
    "/scout",
    "/north",
    "/distribution",
    "/ledger",
    "/analytics",
    "/compliance",
    "/admin"
  ];

  it("maps every workspace href the API serves to a resource path", () => {
    for (const href of API_HREFS.filter((h) => h !== "/")) {
      expect(resourceFor(href), href).toMatch(/^[a-z]+\/[a-z-]+$/);
    }
  });

  it("routes a nav href to its list screen, and home to nowhere", () => {
    expect(routeFor("/axis")).toBe("/m/axis");
    expect(routeFor("/distribution")).toBe("/m/distribution");
    expect(routeFor("/")).toBeUndefined();
  });

  it("resolves the [nav] route param back to the same resource", () => {
    for (const href of API_HREFS.filter((h) => h !== "/")) {
      expect(resourceForNavKey(navKeyFor(href))).toBe(resourceFor(href));
    }
  });

  it("keeps an href it does not know as a labelled, unreachable item", () => {
    expect(resourceFor("/atlas")).toBeUndefined();
    expect(routeFor("/atlas")).toBeUndefined();
    const [entry] = entriesFor([{ labelKey: "nav.atlas", href: "/atlas", icon: "x" }]);
    expect(entry).toEqual({
      labelKey: "nav.atlas",
      href: "/atlas",
      route: undefined,
      resource: undefined,
      depth: 0
    });
  });

  it("flattens nested nav instead of silently dropping the children", () => {
    const entries = entriesFor([
      {
        labelKey: "nav.admin",
        href: "/admin",
        icon: "x",
        children: [{ labelKey: "nav.settings", href: "/settings", icon: "x" }]
      }
    ]);
    expect(entries.map((e) => [e.href, e.depth])).toEqual([
      ["/admin", 0],
      ["/settings", 1]
    ]);
  });

  it("drops home from the workspace list but keeps everything else", () => {
    const entries = entriesFor(
      API_HREFS.map((href) => ({ labelKey: labelKeyFor(href), href, icon: "x" }))
    );
    expect(entries.map((e) => e.href)).toEqual(API_HREFS.filter((h) => h !== "/"));
    expect(entries.every((e) => e.route !== undefined)).toBe(true);
  });

  it("gives every nav item a label the catalogue can translate", () => {
    // The requirement is a visible text label per item — which is impossible if
    // the key resolves to nothing. Both catalogues must carry all of them.
    for (const href of API_HREFS) {
      const key = labelKeyFor(href);
      expect(key in en, key).toBe(true);
      for (const locale of Object.keys(CATALOGUES)) {
        expect(translator(locale)(key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });

  it("falls back to the href-derived key when the API sends no labelKey", () => {
    const [entry] = entriesFor([{ labelKey: "", href: "/ledger", icon: "x" }]);
    expect(entry?.labelKey).toBe("nav.ledger");
  });

  it("titles a screen from the catalogue, or humanizes an unknown segment", () => {
    const t = translator("en");
    expect(navTitle(t, "axis")).toBe("Operations");
    // A garbage deep link (/m/foo) must never render the raw key "nav.foo".
    expect(navTitle(t, "foo")).toBe("Foo");
    expect(navTitle(t, "quote-requests")).toBe("Quote requests");
    // An API labelKey newer than this app's catalogue falls back the same way.
    expect(navTitle(t, "atlas", "nav.atlas")).toBe("Atlas");
  });
});

describe("row display", () => {
  it("names a row by the field a human would recognise", () => {
    expect(titleOf({ id: "cas_1", reference: "C-9", title: "Windscreen" })).toBe("Windscreen");
    expect(titleOf({ id: "cas_1", reference: "C-9" })).toBe("C-9");
    expect(titleOf({ id: "cas_1" })).toBe("cas_1");
    expect(titleOf({ id: "cas_1", name: "   " })).toBe("cas_1");
  });

  it("does not repeat the title as the subtitle", () => {
    expect(subtitleOf({ id: "u_1", email: "a@b.co" })).toBeUndefined();
    expect(subtitleOf({ id: "u_1", name: "Amina", email: "a@b.co", status: "active" })).toBe(
      "Active"
    );
    // A raw enum is never a subtitle.
    expect(subtitleOf({ id: "u_1", name: "A", state: "pending_settlement" })).toBe(
      "Pending settlement"
    );
  });

  it("shows structure rather than [object Object]", () => {
    const fields = fieldsOf({ id: "x", meta: { a: 1 }, gone: null });
    expect(fields.find((f) => f.key === "meta")?.value).toContain('"a": 1');
    expect(fields.find((f) => f.key === "gone")?.value).toBe("—");
  });

  it("labels a field as words, never as the raw column name", () => {
    expect(humanize("tenant_id")).toBe("Tenant ID");
    expect(humanize("created_at")).toBe("Created at");
    expect(humanize("status")).toBe("Status");
    expect(humanize("quote-requests")).toBe("Quote requests");
    const fields = fieldsOf({ id: "x", tenant_id: "ten_1" });
    expect(fields.find((f) => f.key === "tenant_id")?.label).toBe("Tenant ID");
  });
});

describe("sign-in step machine", () => {
  // The same four steps apps/web/app/routes/login.tsx walks. The contract lives
  // in apps/api/src/auth.ts: `mfaStep` on the login response, and a `step` on
  // the 403 problem every later call returns until the factor is cleared.
  const problem = (over: Record<string, unknown>) =>
    new ApiError(
      {
        type: "https://lyra.app/problems/mfa_required",
        title: "Second factor required",
        status: 403,
        ...over
      },
      null
    );

  it("sends a customer with no second factor straight into the app", () => {
    expect(stepAfterLogin({ mfaRequired: false })).toBe("app");
  });

  it("sends an enrolled account to the code screen", () => {
    expect(stepAfterLogin({ mfaRequired: true, mfaStep: "verify" })).toBe("totp");
    // mfaStep is the API's own instruction, but mfaRequired alone still means
    // "there is a code to type" rather than "carry on".
    expect(stepAfterLogin({ mfaRequired: true })).toBe("totp");
  });

  it("sends a staff account that never enrolled to enrolment, not to a code box", () => {
    expect(stepAfterLogin({ mfaRequired: true, mfaStep: "enrol" })).toBe("enrol");
  });

  it("owes a freshly enrolled account its recovery codes before the app", () => {
    expect(stepAfterClearing("enrol")).toBe("recovery");
    expect(stepAfterClearing("totp")).toBe("app");
    expect(stepAfterClearing("recovery")).toBe("app");
  });

  it("reads the outstanding step off a 403 so a restored session is not signed out", () => {
    expect(mfaStepOf(problem({ step: "verify", detail: "verify" }))).toBe("totp");
    expect(mfaStepOf(problem({ step: "enrol", detail: "enrol" }))).toBe("enrol");
    // `step` is an RFC 9457 extension; `detail` carries the same word, so an
    // intermediary that strips unknown members still lands the right screen.
    expect(mfaStepOf(problem({ detail: "enrol" }))).toBe("enrol");
  });

  it("does not re-spend a one-time code when only the follow-up load failed", async () => {
    const verify = vi.fn().mockResolvedValue({ mfaSatisfied: true });
    const load = vi.fn().mockRejectedValueOnce(new NetworkError("offline")).mockResolvedValue(null);
    const flow = verifyThenLoad(verify, load);
    await expect(flow("123456")).rejects.toBeInstanceOf(NetworkError);
    // Retrying must only retry the load: the code was consumed server-side, and
    // re-verifying it would read back as "wrong code".
    await flow("123456");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("re-verifies after a rejected code, and on the next sign-in cycle", async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ title: "unauthorized", status: 401 }, null))
      .mockResolvedValue({ mfaSatisfied: true });
    const load = vi.fn().mockResolvedValue(null);
    const flow = verifyThenLoad(verify, load);
    await expect(flow("000000")).rejects.toBeInstanceOf(ApiError);
    await flow("123456");
    await flow("654321");
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("does not read an ordinary refusal as an MFA prompt", () => {
    expect(
      mfaStepOf(problem({ type: "https://lyra.app/problems/forbidden", title: "Not permitted" }))
    ).toBeNull();
    // An expired session is a sign-out, not a second-factor screen.
    expect(mfaStepOf(problem({ status: 401, type: "https://lyra.app/problems/unauthorized" })))
      .toBeNull();
    expect(mfaStepOf(new Error("offline"))).toBeNull();
  });
});

describe("i18n and brand", () => {
  it("keeps the ar catalogue in step with en", () => {
    expect(Object.keys(CATALOGUES.ar!).sort()).toEqual(Object.keys(en).sort());
  });

  it("lays ar out right-to-left and en left-to-right", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("ar-AE")).toBe("rtl");
    expect(dirFor("en-GB")).toBe("ltr");
  });

  it("picks the first supported device locale", () => {
    expect(resolveLocale(["fr-FR", "ar-AE", "en"])).toBe("ar");
    expect(resolveLocale(["fr-FR"])).toBe("en");
  });

  it("interpolates rather than dropping the variable", () => {
    expect(translator("en")("home.signedInAs", { name: "Amina" })).toBe("Signed in as Amina");
  });

  it("joins display fragments with the locale's own comma", () => {
    expect(joinList("en", ["Windscreen", "open"])).toBe("Windscreen, open");
    expect(joinList("ar-AE", ["أمينة", "نشط"])).toBe("أمينة، نشط");
    expect(joinList("ar", ["واحد"])).toBe("واحد");
  });

  it("reads the palette and the product name from tenant brand, never a literal", () => {
    const theme = themeFor({ name: "Northwind", palette: { accent: "#00aaff" } });
    expect(theme.accent).toBe("#00aaff");
    expect(productName({ name: "Northwind" }, "Northwind Ltd")).toBe("Northwind");
    expect(productName(null, "Northwind Ltd")).toBe("Northwind Ltd");
    // A tenant that overrides nothing still gets a usable palette, and a value
    // that is not a colour never reaches a style.
    expect(themeFor(null).accent).toBe("#ffb020");
    expect(themeFor({ palette: { accent: "red; drop table" } }).accent).toBe("#ffb020");
  });

  it("maps all three accent tokens the web contract defines", () => {
    // apps/web/app/components/shell.tsx brandStyle re-maps exactly --accent,
    // --accent-hover and --accent-contrast; mobile must honour the same three or
    // a tenant's button text ends up unreadable on its own accent.
    const theme = themeFor({
      palette: { accent: "#123456", accentHover: "#0a1a2b", accentContrast: "#ffffff" }
    });
    expect([theme.accent, theme.accentHover, theme.accentContrast]).toEqual([
      "#123456",
      "#0a1a2b",
      "#ffffff"
    ]);
    // A partial override leaves the rest of the default skin intact rather than
    // producing a half-branded palette.
    const partial = themeFor({ palette: { accent: "#123456" } });
    expect(partial.accentHover).toBe("#d98e0b");
    expect(partial.accentContrast).toBe("#412402");
  });

  it("maps only the approved typefaces, and nothing else, to a font family", () => {
    // The same enum BrandJson.font validates (packages/db/src/json.ts) and the
    // same set apps/web FONT_STACKS maps.
    expect(fontFamilyFor("space-grotesk")).toBe("Space Grotesk");
    expect(fontFamilyFor("inter")).toBe("Inter");
    expect(fontFamilyFor("ibm-plex-sans-arabic")).toBe("IBM Plex Sans Arabic");
  });

  it("never lets an unapproved or hostile font value reach a style", () => {
    expect(fontFamilyFor(undefined)).toBeUndefined();
    expect(fontFamilyFor("")).toBeUndefined();
    expect(fontFamilyFor("Comic Sans")).toBeUndefined();
    // The reason this is a Map and not an object literal: an object literal
    // answers these from the prototype and hands a function to fontFamily.
    for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(fontFamilyFor(hostile), hostile).toBeUndefined();
    }
    expect(themeFor({ font: "__proto__" }).font).toBeUndefined();
  });

  it("reads the tenant typeface off the brand payload, and defaults to none", () => {
    expect(themeFor({ font: "inter" }).font).toBe("Inter");
    // No brand, or a brand that never chose one: the platform typeface, which is
    // what `fontFamily: undefined` means to React Native.
    expect(themeFor(null).font).toBeUndefined();
    expect(themeFor({ name: "Northwind" }).font).toBeUndefined();
  });
});

describe("defaultWorkspaceForRoles", () => {
  it("matches an exact role before any prefix", () => {
    expect(defaultWorkspaceForRoles(["tenant.compliance"])).toBe("compliance");
  });

  it("falls back to the role's prefix mapping", () => {
    expect(defaultWorkspaceForRoles(["tenant.admin"])).toBe("admin");
    expect(defaultWorkspaceForRoles(["platform.engineer"])).toBe("admin");
    expect(defaultWorkspaceForRoles(["dev.developer"])).toBe("admin");
    expect(defaultWorkspaceForRoles(["partner.manager"])).toBe("distribution");
    expect(defaultWorkspaceForRoles(["provider.viewer"])).toBe("scout");
    expect(defaultWorkspaceForRoles(["customer"])).toBe("settings");
    expect(defaultWorkspaceForRoles(["finance.controller"])).toBe("ledger");
  });

  it("falls back to the bare prefix when it is itself a workspace", () => {
    expect(defaultWorkspaceForRoles(["axis.agent"])).toBe("axis");
    expect(defaultWorkspaceForRoles(["orbit.lead"])).toBe("orbit");
    expect(defaultWorkspaceForRoles(["signal.marketer"])).toBe("signal");
    expect(defaultWorkspaceForRoles(["scout.pm"])).toBe("scout");
    expect(defaultWorkspaceForRoles(["north.exec"])).toBe("north");
  });

  it("tries every role in order until one resolves", () => {
    expect(defaultWorkspaceForRoles(["unknown.role", "axis.lead"])).toBe("axis");
  });

  it("returns north for a roleless actor", () => {
    expect(defaultWorkspaceForRoles([])).toBe("north");
  });
});

describe("resolvePersona", () => {
  it("resolves the default variant for a plain north role", () => {
    expect(resolvePersona(["north.exec"])).toEqual({ workspace: "north", variant: "default" });
  });

  it("resolves the board variant only for north.board", () => {
    expect(resolvePersona(["north.board"])).toEqual({ workspace: "north", variant: "board" });
  });

  it("never applies the board variant outside the north workspace", () => {
    expect(resolvePersona(["tenant.admin"])).toEqual({ workspace: "admin", variant: "default" });
  });
});

describe("persona tab config", () => {
  const workspaces = Object.keys(PERSONA_TABS) as Array<keyof typeof PERSONA_TABS>;

  it("covers every workspace with 1 to 3 tabs", () => {
    expect(workspaces.sort()).toEqual(
      ["admin", "axis", "compliance", "distribution", "ledger", "north", "orbit", "scout", "settings", "signal"].sort()
    );
    for (const workspace of workspaces) {
      expect(PERSONA_TABS[workspace].length).toBeGreaterThan(0);
      expect(PERSONA_TABS[workspace].length).toBeLessThanOrEqual(3);
    }
  });

  it("gives axis the docs/08 Ops tabs", () => {
    expect(tabsFor("axis", "default").map((tab) => tab.labelKey)).toEqual([
      "tab.queue",
      "tab.sla",
      "tab.capture"
    ]);
  });

  it("points both AXIS deadline tabs at the one queue screen", () => {
    const [queue, sla] = tabsFor("axis", "default");
    expect(queue?.route).toBe("/j/queue");
    expect(sla?.route).toBe("/j/queue?filter=sla");
  });

  it("sends the ORBIT renewals tab to its own screen, not the inbox", () => {
    const renewals = tabsFor("orbit", "default")[1];
    expect(renewals?.labelKey).toBe("tab.renewals");
    expect(renewals?.route).toBe("/j/renewals");
    // A renewal detail cannot ride the "/orbit" entry — that one is conversations.
    expect(resourceForNavKey("orbit-renewals")).toBe("orbit/renewals");
  });

  it("points both SIGNAL money tabs at the one cockpit screen", () => {
    const [campaigns, budget] = tabsFor("signal", "default");
    expect(campaigns?.route).toBe("/j/campaigns");
    expect(budget?.route).toBe("/j/campaigns?view=budget");
  });

  it("gives every SCOUT tab its own screen and a record it can open", () => {
    expect(tabsFor("scout", "default").map((tab) => tab.route)).toEqual([
      "/j/clusters",
      "/j/whitespace",
      "/j/panel"
    ]);
    expect(resourceForNavKey("scout-clusters")).toBe("scout/clusters");
    expect(resourceForNavKey("scout-whitespaces")).toBe("scout/whitespaces");
  });

  it("gives both NORTH governance tabs their own screen and a record to open", () => {
    expect(tabsFor("north", "default").map((tab) => tab.route)).toEqual([
      "/j/brief",
      "/j/decisions",
      "/j/boardpack"
    ]);
    // The board variant renames the tab; it must not lose the screen.
    expect(tabsFor("north", "board")[1]?.route).toBe("/j/decisions");
    expect(resourceForNavKey("north-decisions")).toBe("north/decisions");
    expect(resourceForNavKey("north-boardpacks")).toBe("north/boardpacks");
  });

  it("gives the admin a distinct third tab instead of a second user list", () => {
    const tabs = tabsFor("admin", "default");
    expect(tabs.map((tab) => tab.labelKey)).toEqual(["tab.approvals", "tab.staff", "tab.audit"]);
    expect(tabs[2]?.route).toBe("/j/audit");
    expect(resourceForNavKey("admin-audit")).toBe("core/audit-log");
  });

  it("gives the finance controller money, approvals and reconciliation", () => {
    const tabs = tabsFor("ledger", "default");
    expect(tabs.map((tab) => tab.labelKey)).toEqual(["tab.money", "tab.approvals", "tab.recon"]);
    expect(tabs[0]?.route).toBe("/j/money");
    expect(resourceForNavKey("ledger-recon")).toBe("ledger/recon-runs");
  });

  it("gives the compliance officer the DSAR clock, approvals and the log", () => {
    const tabs = tabsFor("compliance", "default");
    expect(tabs.map((tab) => tab.labelKey)).toEqual(["tab.requests", "tab.approvals", "tab.audit"]);
    expect(tabs[0]?.route).toBe("/j/requests");
  });

  it("drops a tab the signed-in person has no permission for", () => {
    // Both finance roles land on the ledger workspace, but only the controller
    // may decide approvals (rbac.ts) — the analyst was being handed a tab that
    // 403s at the person whose tab it is.
    const controller = tabsFor("ledger", "default", ["core:approvals:read", "ledger:recon:read"]);
    expect(controller.map((tab) => tab.labelKey)).toEqual(["tab.money", "tab.approvals", "tab.recon"]);
    const analyst = tabsFor("ledger", "default", ["ledger:recon:read"]);
    expect(analyst.map((tab) => tab.labelKey)).toEqual(["tab.money", "tab.recon"]);
  });

  it("lands every routeless tab on a list rather than a 404", () => {
    // A tab with no journey screen redirects to `/m/${screen}`, and `screen`
    // held a resource path — so `/m/core/users` matched `[nav]/[id]` and asked
    // the API for a record whose id was the word "users". Every persona's
    // fallback tab rendered "not found" at the person whose tab it is.
    for (const [workspace, tabs] of Object.entries(PERSONA_TABS))
      for (const tab of tabs)
        expect(resourceForNavKey(tab.screen), `${workspace} · ${tab.labelKey}`).toBeTruthy();
  });

  it("swaps Decisions for Governance only for the north board variant", () => {
    expect(tabsFor("north", "default").map((tab) => tab.labelKey)).toContain("tab.decisions");
    expect(tabsFor("north", "board").map((tab) => tab.labelKey)).toContain("tab.governance");
    expect(tabsFor("north", "board").map((tab) => tab.labelKey)).not.toContain("tab.decisions");
  });

  it("leaves every other workspace's tabs unaffected by variant", () => {
    expect(tabsFor("axis", "board")).toEqual(tabsFor("axis", "default"));
  });

  it("gives every single-tab workspace a Home tab pointing at its own resource", () => {
    // Ledger and compliance left this list when the controller and the officer
    // got real tabs — the two tests above own their shapes now.
    for (const workspace of ["distribution", "settings"] as const) {
      const tabs = tabsFor(workspace, "default");
      expect(tabs).toHaveLength(1);
      expect(tabs[0]?.labelKey).toBe("nav.home");
    }
  });
});

describe("biometric gate", () => {
  function probe(overrides: Partial<{ hardware: boolean; enrolled: boolean; success: boolean }> = {}) {
    const { hardware = true, enrolled = true, success = true } = overrides;
    return {
      hasHardware: async () => hardware,
      isEnrolled: async () => enrolled,
      authenticate: async () => success
    };
  }

  it("lets a consequential approve through only when the challenge passes", async () => {
    const probe = (hardware: boolean, enrolled: boolean, ok: boolean) => ({
      hasHardware: async () => hardware,
      isEnrolled: async () => enrolled,
      authenticate: async () => ok
    });
    // No hardware, or none enrolled, must not lock an approver out.
    expect(await confirmConsequential(probe(false, false, false))).toBe(true);
    expect(await confirmConsequential(probe(true, false, false))).toBe(true);
    expect(await confirmConsequential(probe(true, true, true))).toBe(true);
    // But a device that has it must pass it.
    expect(await confirmConsequential(probe(true, true, false))).toBe(false);
  });

  it("opens immediately when the device has no biometric hardware", async () => {
    expect(await resolveGate(probe({ hardware: false }))).toBe("open");
  });

  it("opens immediately when hardware exists but nothing is enrolled", async () => {
    expect(await resolveGate(probe({ enrolled: false }))).toBe("open");
  });

  it("opens after a successful challenge when enrolled", async () => {
    expect(await resolveGate(probe({ success: true }))).toBe("open");
  });

  it("locks after a failed challenge when enrolled", async () => {
    expect(await resolveGate(probe({ success: false }))).toBe("locked");
  });

  it("never calls authenticate when nothing is enrolled", async () => {
    const authenticate = vi.fn(async () => true);
    await resolveGate({ hasHardware: async () => true, isEnrolled: async () => false, authenticate });
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("write calls", () => {
  // These are the only calls in the app that change something on the server, so
  // each one is pinned to its method, path and body shape: a screen that sends
  // the right thing to the wrong path fails silently in a way no UI test sees.
  const calls: { url: string; init: RequestInit }[] = [];

  const stub = (body: unknown, status = 200) => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" }
            });
      })
    );
  };

  afterEach(() => vi.unstubAllGlobals());

  it("reads the inbox as one call carrying both queues", async () => {
    stub({ approvals: [{ id: "apr_1" }], notifications: [], counts: { approvals: 1, notifications: 0 } });
    const inbox = await fetchInbox("t");
    expect(calls[0]!.url).toContain("/v1/me/inbox");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(inbox.counts.approvals).toBe(1);
  });

  it("posts an approval decision with its reason", async () => {
    stub({ id: "apr_1", status: "rejected" });
    await decideApproval("t", "apr_1", "rejected", "over budget");
    expect(calls[0]!.url).toContain("/v1/me/approvals/apr_1/decide");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      decision: "rejected",
      reason: "over budget"
    });
  });

  it("omits the reason rather than sending an empty one", async () => {
    stub({ id: "apr_1", status: "approved" });
    await decideApproval("t", "apr_1", "approved");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ decision: "approved" });
  });

  it("takes an anomaly with the same PATCH the web's anomaly queue sends", async () => {
    stub({ id: "ano/1", state: "action_created" });
    await takeAnomaly("t", "ano/1", "Rana Hadid");
    expect(calls[0]!.url).toContain("/v1/north/anomalies/ano%2F1");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      state: "action_created",
      explainedBy: "Rana Hadid"
    });
  });

  it("escapes an id into the path", async () => {
    stub(null, 204);
    await markNotificationRead("t", "ntf/1");
    expect(calls[0]!.url).toContain("/v1/me/notifications/ntf%2F1/read");
  });

  it("asks north for a briefing on a given date", async () => {
    stub({ id: "brf_1", date: "2026-08-10" }, 201);
    await generateBriefing("t", { date: "2026-08-10", locale: "ar" });
    expect(calls[0]!.url).toContain("/v1/north/briefings/generate");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ date: "2026-08-10", locale: "ar" });
  });

  it("sends an agent reply to the conversation's reply route", async () => {
    stub({ id: "msg_1" }, 201);
    await replyToConversation("t", "cnv_1", "on its way");
    expect(calls[0]!.url).toContain("/v1/orbit/conversations/cnv_1/reply");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "on its way" });
  });

  it("uploads a captured document as multipart, without a JSON content-type", async () => {
    stub({ id: "doc_1", status: "received" }, 201);
    await uploadDocument("t", {
      caseId: "cas_1",
      docType: "eid",
      uri: "file:///tmp/capture.jpg",
      contentType: "image/jpeg"
    });
    const { url, init } = calls[0]!;
    expect(url).toContain("/v1/axis/documents/upload");
    expect(init.method).toBe("POST");
    // The platform sets the multipart boundary; setting it by hand produces a
    // body the server cannot parse.
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer t");
    // React Native's FormData type has no `get` (it is append-only there); the
    // parts are read back through the platform one this test runs on.
    const form = init.body as unknown as { get(name: string): unknown };
    expect(init.body).toBeInstanceOf(FormData);
    expect(form.get("caseId")).toBe("cas_1");
    expect(form.get("docType")).toBe("eid");
    expect(form.get("file")).toBeTruthy();
  });
});

describe("name resolution", () => {
  // The approvals queue rendered `subjectRef` and `requestedBy` as raw ULIDs.
  // Names are decoration over refs the screen already holds, so the resolver
  // degrades to short refs rather than failing the queue.
  const stubFetch = (impl: (url: string) => Response) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => impl(String(url))));
  };

  afterEach(() => vi.unstubAllGlobals());

  it("shortens an opaque ref and leaves anything else alone", () => {
    expect(shortRef("us_01KE953T07XY8ZQK4M2N6VJH3B")).toBe("us_01KE…JH3B");
    expect(shortRef("user:us_01KE953T07XY8ZQK4M2N6VJH3B")).toBe("user:us_01KE…JH3B");
    expect(shortRef("CASE-1042")).toBe("CASE-1042");
  });

  it("prefers the resolved name and falls back to the short ref", () => {
    const names = { "user:us_1": "Layla Al Mansouri" };
    expect(who("user:us_1", names)).toBe("Layla Al Mansouri");
    expect(who("us_01KE953T07XY8ZQK4M2N6VJH3B", names)).toBe("us_01KE…JH3B");
    expect(who(null, names)).toBeNull();
  });

  it("asks once for a de-duplicated batch, dropping empty refs", async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response(JSON.stringify({ names: { cu_1: "Falcon Freight" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const names = await fetchNames("t", ["cu_1", "cu_1", null, undefined]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v1/names?refs=cu_1");
    expect(names).toEqual({ cu_1: "Falcon Freight" });
  });

  it("asks nothing when there is nothing to resolve", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    expect(await fetchNames("t", [null, ""])).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns no names rather than throwing when the lookup fails", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    await expect(fetchNames("t", ["cu_1"])).resolves.toEqual({});
  });
});

describe("journey helpers", () => {
  it("reads the asked-for briefing, else the newest in the reader's language", () => {
    // Newest-first, as the API sorts them. Same rule as the web's `chosen`
    // (apps/web/app/routes/north-shared.tsx).
    const rows = [
      { id: "brf_3", locale: "ar" },
      { id: "brf_2", locale: "en" },
      { id: "brf_1", locale: "en" }
    ];
    expect(chosenBriefing(rows, null, "en")?.id).toBe("brf_2");
    expect(chosenBriefing(rows, null, "ar")?.id).toBe("brf_3");
    // A regional tag is still that language.
    expect(chosenBriefing(rows, null, "en-AE")?.id).toBe("brf_2");
    // Nothing in the reader's language: newest at all rather than nothing.
    expect(chosenBriefing(rows, null, "fr")?.id).toBe("brf_3");
    // An explicit id wins over language; an unknown one falls back to newest.
    expect(chosenBriefing(rows, "brf_3", "en")?.id).toBe("brf_3");
    expect(chosenBriefing(rows, "brf_9", "en")?.id).toBe("brf_3");
    expect(chosenBriefing([], null, "en")).toBeNull();
    expect(chosenBriefing(null, null, "en")).toBeNull();
  });

  it("never shows a storage key as the briefing's prose", () => {
    expect(briefNarrative("briefings/gonxt/brf_1.md")).toBeNull();
    expect(briefNarrative("brf_1.md")).toBeNull();
    expect(briefNarrative("Motor premiums rose.\n\nClaims held.")).toBe(
      "Motor premiums rose.\n\nClaims held."
    );
    expect(briefNarrative("")).toBeNull();
    expect(briefNarrative(null)).toBeNull();
    expect(briefNarrative(42)).toBeNull();
  });

  it("offers to take an anomaly only to a reader who may assign it", () => {
    expect(canTakeAnomaly(["north:anomalies:assign"])).toBe(true);
    expect(canTakeAnomaly(["north:anomalies:read"])).toBe(false);
    expect(canTakeAnomaly(null)).toBe(false);
  });

  it("signs a taken anomaly with the reader's name, else their email", () => {
    const actor = { kind: "user", id: "u1" };
    const profile = {
      id: "u1",
      name: "Rana Hadid",
      email: "rana.hadid@gonxt.ae",
      locale: "en",
      status: "active"
    };
    expect(anomalyOwner({ actor, profile })).toBe("Rana Hadid");
    expect(anomalyOwner({ actor, profile: { ...profile, name: "  " } })).toBe(
      "rana.hadid@gonxt.ae"
    );
    expect(anomalyOwner({ actor, profile: null })).toBe("u1");
    expect(anomalyOwner(null)).toBeNull();
  });

  it("shows no highlights rather than crashing on a bad column", () => {
    expect(highlightsOf(null)).toEqual([]);
    expect(highlightsOf("not json")).toEqual([]);
    expect(highlightsOf('{"nope":1}')).toEqual([]);
    expect(highlightsOf('[{"metricKey":"gwp"},{"value":1}]')).toEqual([]);
    expect(
      highlightsOf('[{"metricKey":"gwp","period":"2026-08","value":42,"deltaBps":250}]')
    ).toEqual([{ metricKey: "gwp", period: "2026-08", value: 42, deltaBps: 250 }]);
  });

  it("picks the largest unowned anomaly and ignores owned ones", () => {
    const rows = [
      { id: "an_1", state: "new", magnitude: -300 },
      { id: "an_2", state: "new", magnitude: 120 },
      { id: "an_3", state: "new", magnitude: 900, explainedBy: "usr_1" },
      { id: "an_4", state: "explained", magnitude: 5000 }
    ];
    expect(unownedAnomaly(rows)?.id).toBe("an_1");
    expect(unownedAnomaly([{ id: "an_4", state: "dismissed" }])).toBeNull();
    expect(unownedAnomaly(null)).toBeNull();
  });

  it("renders basis points as a signed percentage", () => {
    expect(bps(250)).toBe("+2.5%");
    expect(bps(-125)).toBe("-1.3%");
    expect(bps(0)).toBe("0.0%");
    expect(bps(null)).toBeNull();
  });

  it("dates today in the device's timezone, not UTC's", () => {
    expect(todayIso(new Date(2026, 7, 9, 23, 30))).toBe("2026-08-09");
    expect(todayIso(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });

  it("turns an approval policy key into words", () => {
    expect(approvalTitle({ id: "apr_1", policyKey: "signal.budget.move" })).toBe(
      "Signal · Budget · Move"
    );
    expect(approvalTitle({ id: "apr_1" })).toBe("Apr 1");
  });

  it("reads the amount an approval turns on, when it has one", () => {
    expect(approvalAmountMinor({ id: "a", contextJson: '{"amountMinor":125000}' })).toBe(125000);
    expect(approvalAmountMinor({ id: "a", contextJson: "{}" })).toBeNull();
    expect(approvalAmountMinor({ id: "a", contextJson: "broken" })).toBeNull();
    expect(approvalAmountMinor({ id: "a" })).toBeNull();
  });

  it("reads a thread oldest-first regardless of the order it arrived in", () => {
    const rows = [
      { id: "m3", ts: 300 },
      { id: "m1", ts: 100 },
      { id: "m2", ts: 200 }
    ];
    expect(threadOrder(rows).map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    // The input is not mutated: the list it came from is still rendering.
    expect(rows[0]!.id).toBe("m3");
  });

  it("puts only the customer's messages on the inbound side", () => {
    expect(isInbound({ id: "m", role: "customer" })).toBe(true);
    expect(isInbound({ id: "m", role: "agent_human" })).toBe(false);
    expect(isInbound({ id: "m", role: "agent_ai" })).toBe(false);
  });

  it("ranks a missed deadline above an urgent label", () => {
    const now = 1_000_000_000;
    const hour = 3_600_000;
    expect(caseSeverity({ priority: "normal", slaDueAt: now - hour }, now)).toBe("breach");
    expect(caseSeverity({ priority: "urgent", slaDueAt: now + 48 * hour }, now)).toBe("urgent");
    expect(caseSeverity({ priority: "normal", slaDueAt: now + 3 * hour }, now)).toBe("due");
    expect(caseSeverity({ priority: "normal", slaDueAt: now + 48 * hour }, now)).toBe("normal");
    expect(caseSeverity({ priority: "normal" }, now)).toBe("normal");
  });

  it("orders the queue worst first, then by deadline, then by age", () => {
    const now = 1_000_000_000;
    const hour = 3_600_000;
    const rows = [
      { id: "c_calm", priority: "normal", slaDueAt: now + 96 * hour, createdAt: 1 },
      { id: "c_urgent", priority: "urgent", slaDueAt: now + 96 * hour, createdAt: 2 },
      { id: "c_late", priority: "low", slaDueAt: now - hour, createdAt: 3 },
      { id: "c_soon", priority: "normal", slaDueAt: now + 2 * hour, createdAt: 4 }
    ];
    expect(queueOrder(rows, now).map((row) => row.id)).toEqual([
      "c_late",
      "c_urgent",
      "c_soon",
      "c_calm"
    ]);
    // The SLA tab is the same queue with everything no clock presses on dropped.
    expect(queueOrder(rows, now, true).map((row) => row.id)).toEqual(["c_late", "c_soon"]);
    expect(queueOrder(null, now)).toEqual([]);
  });

  it("reads a deadline as whole hours on the right side of now", () => {
    const now = 1_000_000_000;
    expect(dueIn(now + 7_200_000, now)).toEqual({ overdue: false, hours: 2 });
    expect(dueIn(now - 7_200_000, now)).toEqual({ overdue: true, hours: 2 });
    // Under an hour still reads as an hour: "due in 0h" is not a deadline.
    expect(dueIn(now + 60_000, now)).toEqual({ overdue: false, hours: 1 });
    expect(dueIn(null, now)).toBeNull();
  });

  it("reads an expiry as whole days, negative once it has passed", () => {
    const now = 1_000_000_000;
    expect(daysUntil(now + 2 * 86_400_000, now)).toBe(2);
    expect(daysUntil(now - 86_400_000, now)).toBe(-1);
    expect(daysUntil(null, now)).toBeNull();
  });

  it("calls a renewal's urgency the same way the web board does", () => {
    expect(urgencyOf(-1)).toBe("gone");
    expect(urgencyOf(7)).toBe("now");
    expect(urgencyOf(30)).toBe("soon");
    expect(urgencyOf(31)).toBe("later");
    // No expiry is not urgent; there is nothing to be late for.
    expect(urgencyOf(null)).toBe("later");
  });

  it("orders renewals soonest first, riskiest of the same day first", () => {
    const now = 1_000_000_000;
    const day = 86_400_000;
    const rows = [
      { id: "r_far", expiryAt: now + 60 * day },
      { id: "r_none" },
      { id: "r_calm", expiryAt: now + 3 * day, churnScore: 10 },
      { id: "r_risky", expiryAt: now + 3 * day, churnScore: 80 },
      { id: "r_late", expiryAt: now - day }
    ];
    expect(renewalOrder(rows, now).map((row) => row.id)).toEqual([
      "r_late",
      "r_risky",
      "r_calm",
      "r_far",
      "r_none"
    ]);
    expect(renewalOrder(null, now)).toEqual([]);
  });

  it("reads a budget whether the column arrived parsed, as text, or broken", () => {
    expect(budgetOf({ id: "c", budgetJson: { dailyMinor: 500 } })).toEqual({ dailyMinor: 500 });
    expect(budgetOf({ id: "c", budgetJson: '{"capMinor":900}' })).toEqual({ capMinor: 900 });
    expect(budgetOf({ id: "c", budgetJson: "not json" })).toEqual({});
    expect(budgetOf({ id: "c" })).toEqual({});
  });

  it("measures the plan by cap, then total, then the daily rate over the window", () => {
    expect(plannedMinor({ capMinor: 10_000, dailyMinor: 900 }, 7)).toBe(10_000);
    expect(plannedMinor({ totalMinor: 5_000, dailyMinor: 900 }, 7)).toBe(5_000);
    expect(plannedMinor({ dailyMinor: 900 }, 7)).toBe(6_300);
    expect(plannedMinor({}, 7)).toBe(0);
  });

  it("calls spend against plan by name, and says nothing about an unset ceiling", () => {
    expect(pacingOf(1_100, 1_000).state).toBe("over");
    expect(pacingOf(950, 1_000).state).toBe("hot");
    expect(pacingOf(600, 1_000).state).toBe("on");
    expect(pacingOf(100, 1_000).state).toBe("cold");
    // No ceiling is not 0% spent — it is a number nobody set.
    expect(pacingOf(400, 0)).toEqual({ ratio: null, state: "unplanned" });
  });

  it("totals spend per campaign and drops what the importer could not attribute", () => {
    const rows = [
      { id: "s1", campaignId: "c1", amountMinor: 100 },
      { id: "s2", campaignId: "c1", amountMinor: 250 },
      { id: "s3", campaignId: null, amountMinor: 999 },
      { id: "s4", campaignId: "c2" }
    ];
    expect(spendByCampaign(rows)).toEqual({ c1: 350, c2: 0 });
    expect(spendByCampaign(null)).toEqual({});
  });

  it("orders campaigns by what is spending, then by how near its ceiling", () => {
    const rows = [
      { id: "c_draft", name: "Draft", state: "draft", budgetJson: { capMinor: 1_000 } },
      { id: "c_cold", name: "Cold", state: "live", budgetJson: { capMinor: 1_000 } },
      { id: "c_over", name: "Over", state: "live", budgetJson: { capMinor: 1_000 } },
      { id: "c_none", name: "None", state: "live" },
      { id: "c_done", name: "Done", state: "ended", budgetJson: { capMinor: 1_000 } }
    ];
    const spent = { c_cold: 200, c_over: 1_400, c_draft: 900 };
    expect(campaignOrder(rows, spent, 7).map((row) => row.id)).toEqual([
      "c_over",
      "c_cold",
      "c_none",
      "c_draft"
    ]);
    // The budget tab has nothing to say about a campaign with no ceiling.
    expect(campaignOrder(rows, spent, 7, true).map((row) => row.id)).toEqual([
      "c_over",
      "c_draft",
      "c_cold"
    ]);
    expect(campaignOrder(null, {}, 7)).toEqual([]);
  });

  it("totals in the currency most campaigns are budgeted in", () => {
    const rows = [
      { id: "a", budgetJson: { currency: "AED" } },
      { id: "b", budgetJson: { currency: "AED" } },
      { id: "c", budgetJson: { currency: "ZAR" } }
    ];
    expect(mainCurrency(rows)).toBe("AED");
    expect(mainCurrency([{ id: "a" }])).toBe("ZAR");
    expect(mainCurrency(null, "AED")).toBe("AED");
  });

  it("writes minor units as whole money", () => {
    const text = moneyText("en-ZA", "ZAR", 123_456);
    // Grouping is a non-breaking space in this locale, so match on the digits.
    expect(text.replace(/\s/gu, "")).toContain("1235");
    expect(text).toContain("R");
    // Cents on a phone are noise: R 1 234.56 rounds to the rand.
    expect(text).not.toContain(".");
  });

  it("ranks clusters by momentum, then by how much evidence built them", () => {
    const rows = [
      { id: "c_small", theme: "B", momentumScore: 40, size: 2 },
      { id: "c_loud", theme: "A", momentumScore: 90, size: 1 },
      { id: "c_big", theme: "C", momentumScore: 40, size: 9 },
      { id: "c_none", theme: "D" }
    ];
    expect(clusterOrder(rows).map((row) => row.id)).toEqual(["c_loud", "c_big", "c_small", "c_none"]);
    expect(clusterOrder(null)).toEqual([]);
  });

  it("places a whitespace on the radar's two axes, or says it cannot", () => {
    const clusters = byId([{ id: "cl", momentumScore: 60 }]);
    const plotted = opportunityOf(
      { id: "w", clusterId: "cl", competitionScore: 25, evidenceRefsJson: '{"refs":["a","b"]}' },
      clusters
    );
    expect(plotted).toEqual({ fit: 75, momentum: 60, evidence: 2, plotted: true, score: 45 });
    // No cluster means no momentum anybody measured — inventing one is a lie.
    expect(opportunityOf({ id: "w", competitionScore: 25 }, clusters).plotted).toBe(false);
    expect(opportunityOf({ id: "w", clusterId: "cl" }, clusters).plotted).toBe(false);
    // A cluster the page did not load is the same as no cluster.
    expect(opportunityOf({ id: "w", clusterId: "gone", competitionScore: 1 }, clusters).plotted).toBe(
      false
    );
    // Broken evidence JSON costs the count, not the row.
    expect(opportunityOf({ id: "w", evidenceRefsJson: "{" }, clusters).evidence).toBe(0);
  });

  it("orders whitespaces best-bet first and sinks the unplottable ones", () => {
    const clusters = [
      { id: "hot", momentumScore: 90 },
      { id: "cool", momentumScore: 20 }
    ];
    const rows = [
      { id: "w_weak", clusterId: "cool", competitionScore: 50 },
      { id: "w_orphan", competitionScore: 5 },
      { id: "w_best", clusterId: "hot", competitionScore: 10 }
    ];
    expect(whitespaceOrder(rows, clusters).map((row) => row.id)).toEqual([
      "w_best",
      "w_weak",
      "w_orphan"
    ]);
    expect(whitespaceOrder(null, clusters)).toEqual([]);
  });

  it("reads the newest period off the bench and rolls it up by provider", () => {
    const rows = [
      { id: "b1", providerId: "p_a", line: "motor", period: "2026-01", volume: 100, ourPriceIdx: 9000, marketPriceIdx: 10000, winRate: 20 },
      { id: "b2", providerId: "p_a", line: "home", period: "2026-02", volume: 300, ourPriceIdx: 10400, marketPriceIdx: 10000, winRate: 40 },
      { id: "b3", providerId: "p_a", line: "motor", period: "2026-02", volume: 100, ourPriceIdx: 10000, marketPriceIdx: 10000, winRate: 80 },
      { id: "b4", providerId: "p_b", line: "motor", period: "2026-02", volume: 100, ourPriceIdx: null, marketPriceIdx: null, winRate: null }
    ];
    expect(latestPeriod(rows)).toBe("2026-02");
    expect(latestPeriod(null)).toBeNull();

    const [first, second] = rollByProvider(rows, latestPeriod(rows));
    // The January row is out of period, and every average is volume-weighted:
    // (10400·300 + 10000·100) / 400 = 10300.
    expect(first).toEqual({
      providerId: "p_a",
      volume: 400,
      share: 0.8,
      winRate: 50,
      ourIdx: 10300,
      marketIdx: 10000,
      lines: ["home", "motor"]
    });
    // A column nobody priced stays null rather than becoming a zero.
    expect(second?.ourIdx).toBeNull();
    expect(second?.winRate).toBeNull();
    expect(rollByProvider(rows, null)).toEqual([]);
  });

  it("calls a price position the same way the web bench does", () => {
    expect(deltaPct(10300, 10000)).toBeCloseTo(3);
    expect(deltaPct(10000, 0)).toBeNull();
    expect(deltaPct(null, 10000)).toBeNull();
    expect(positionOf(3)).toBe("dearer");
    expect(positionOf(-3)).toBe("cheaper");
    // Two points of index is inside the noise of a median over four quotes.
    expect(positionOf(1.9)).toBe("atMarket");
    expect(positionOf(null)).toBe("unpriced");
    expect(indexText(9420, "en")).toBe("0.94");
    expect(indexText(null)).toBeNull();
  });

  it("rolls spend and wins together per channel, biggest spend first", () => {
    const spend = [
      { id: "s1", channel: "meta", amountMinor: 30_000, clicks: 100 },
      { id: "s2", channel: "google_search", amountMinor: 60_000, clicks: 200 },
      { id: "s3", channel: "meta", amountMinor: 20_000, clicks: 50 }
    ];
    const touches = [
      { id: "t1", channel: "meta", touchType: "bind", valueMinor: 100_000 },
      { id: "t2", channel: "meta", touchType: "view", valueMinor: 999 },
      { id: "t3", channel: "google_search", touchType: "bind", valueMinor: 40_000 },
      { id: "t4", channel: "google_search", touchType: "bind", valueMinor: 60_000 }
    ];
    const rolls = rollByChannel(spend, touches);
    expect(rolls.map((roll) => roll.channel)).toEqual(["google_search", "meta"]);
    // A view is not a customer: only binds count, and only their value.
    expect(rolls[1]).toEqual({ channel: "meta", spendMinor: 50_000, clicks: 150, binds: 1, valueMinor: 100_000 });
    // R600 spent on Google won two customers.
    expect(cacMinor(rolls[0]!.spendMinor, rolls[0]!.binds)).toBe(30_000);
    expect(ltvMinor(touches)).toBe(Math.round((100_000 + 40_000 + 60_000) / 3));
    expect(rollByChannel(null, null)).toEqual([]);
  });

  it("refuses to compute a return nobody can compute", () => {
    // Spend with nothing won is not an infinite cost, it is an unknown one.
    expect(cacMinor(50_000, 0)).toBeNull();
    expect(ltvMinor([])).toBeNull();
    expect(ltvToCac(100, 0)).toBeNull();
    expect(ltvToCac(null, 50)).toBeNull();
    expect(ltvToCac(120, 50)).toBe(2.4);
    expect(multipleText("en", 2.4)).toBe("2.4×");
  });

  it("ages an audit row in whole hours, never negative", () => {
    const now = 1_800_000_000_000;
    expect(hoursSince(now - 90 * 60_000, now)).toBe(1);
    expect(hoursSince(now - 3 * 86_400_000, now)).toBe(72);
    // Clock skew between a worker and a phone must not read as a negative age.
    expect(hoursSince(now + 60_000, now)).toBe(0);
    expect(hoursSince(null, now)).toBeNull();
    expect(hoursSince(0, now)).toBeNull();
  });

  it("names known channels and titles the ones it has never heard of", () => {
    expect(channelLabel("google_search")).toBe("Google Search");
    expect(channelLabel("meta", "ar")).toBe("فيسبوك");
    expect(channelLabel("tiktok_ads")).toBe("Tiktok ads");
  });

  it("puts open decisions first, overdue reviews above future ones", () => {
    const now = Date.parse("2026-08-12T00:00:00Z");
    const day = 86_400_000;
    const rows = [
      { id: "d_done", status: "reviewed", reviewAt: now - 5 * day, title: "A" },
      { id: "d_undated", status: "open", title: "C" },
      { id: "d_soon", status: "open", reviewAt: now + 3 * day, title: "B" },
      { id: "d_late", status: "open", reviewAt: now - 2 * day, title: "D" },
      { id: "d_gone", status: "reversed", title: "E" }
    ];
    expect(decisionOrder(rows, now).map((row) => row.id)).toEqual([
      "d_late",
      "d_soon",
      "d_undated",
      "d_done",
      "d_gone"
    ]);
    expect(decisionOrder(null, now)).toEqual([]);
  });

  it("counts the options weighed whichever shape the log recorded", () => {
    expect(optionCount({ id: "d", optionsJson: '["a","b","c"]' })).toBe(3);
    expect(optionCount({ id: "d", optionsJson: '{"options":[{"label":"a"}]}' })).toBe(1);
    // A call recorded without its alternatives, and outright broken JSON.
    expect(optionCount({ id: "d" })).toBe(0);
    expect(optionCount({ id: "d", optionsJson: "{oops" })).toBe(0);
  });

  it("shelves board packs newest period first, finished copy on top", () => {
    const rows = [
      { id: "p_old", period: "2026-Q1", status: "distributed" },
      { id: "p_draft", period: "2026-Q2", status: "draft" },
      { id: "p_final", period: "2026-Q2", status: "final" },
      { id: "p_nul" }
    ];
    expect(boardpackOrder(rows).map((row) => row.id)).toEqual(["p_final", "p_draft", "p_old", "p_nul"]);
    expect(sectionCount({ id: "p", sectionsJson: '[{"title":"Briefing"},{"title":"Metrics"}]' })).toBe(2);
    expect(sectionCount({ id: "p" })).toBe(0);
  });

  it("offers exactly the document types AXIS accepts", () => {
    expect([...DOC_TYPES]).toEqual(["eid", "mulkiya", "census", "medical", "tradelicense", "other"]);
  });

  it("names a capture's content type from its uri, defaulting to JPEG", () => {
    expect(contentTypeOf("file:///tmp/a.png")).toBe("image/png");
    expect(contentTypeOf("file:///tmp/a.HEIC")).toBe("image/heic");
    expect(contentTypeOf("file:///tmp/scan.pdf")).toBe("application/pdf");
    expect(contentTypeOf("file:///tmp/a.jpg?x=1")).toBe("image/jpeg");
    expect(contentTypeOf("file:///tmp/nodots")).toBe("image/jpeg");
  });

  it("says where a transaction stands, with the clock beating the state", () => {
    const now = 1_000_000_000;
    expect(txnStanding({ id: "t", state: "failed" }, now)).toBe("broken");
    expect(txnStanding({ id: "t", state: "rejected" }, now)).toBe("broken");
    // Waiting on a bank is normal until the deadline the ledger stamped passes;
    // after it, nobody is coming and a person has to chase it.
    expect(txnStanding({ id: "t", state: "pending_external", externalTimeoutAt: now + 60_000 }, now)).toBe("waiting");
    expect(txnStanding({ id: "t", state: "pending_external", externalTimeoutAt: now - 60_000 }, now)).toBe("stalled");
    expect(txnStanding({ id: "t", state: "executing" }, now)).toBe("moving");
    // Money that has arrived is not a controller's morning.
    expect(txnStanding({ id: "t", state: "settled" }, now)).toBe("done");
    expect(txnStanding({ id: "t", state: "reversed" }, now)).toBe("done");
  });

  it("orders money worst first, and drops what has already settled", () => {
    const now = 1_000_000_000;
    const rows = [
      { id: "t_settled", state: "settled", createdAt: now - 5000 },
      { id: "t_moving", state: "executing", createdAt: now - 4000 },
      { id: "t_stalled", state: "pending_external", externalTimeoutAt: now - 1, createdAt: now - 3000 },
      { id: "t_broken", state: "failed", createdAt: now - 2000 },
      { id: "t_old", state: "initiated", createdAt: now - 9000 }
    ];
    // Broken, stalled, then whatever is still moving oldest first — an
    // in-flight transaction gets more worrying the longer it stays in flight.
    expect(txnOrder(rows, now).map((row) => row.id)).toEqual([
      "t_broken",
      "t_stalled",
      "t_old",
      "t_moving"
    ]);
    expect(txnOrder(null, now)).toEqual([]);
  });

  it("reads a DSAR against its statutory clock, not its state", () => {
    const now = 1_000_000_000;
    const day = 86_400_000;
    expect(dsarStanding({ id: "d", state: "received", dueAt: now - day }, now)).toBe("late");
    expect(dsarStanding({ id: "d", state: "received", dueAt: now + 3 * day }, now)).toBe("due");
    expect(dsarStanding({ id: "d", state: "in_progress", dueAt: now + 20 * day }, now)).toBe("open");
    // A fulfilled request is a record, however far past its date it sits.
    expect(dsarStanding({ id: "d", state: "fulfilled", dueAt: now - 90 * day }, now)).toBe("closed");
    expect(dsarStanding({ id: "d", state: "refused", dueAt: now - day }, now)).toBe("closed");
  });

  it("orders DSARs by the deadline the law set, closed ones last", () => {
    const now = 1_000_000_000;
    const day = 86_400_000;
    const rows = [
      { id: "d_done", state: "fulfilled", dueAt: now - 30 * day },
      { id: "d_soon", state: "verifying", dueAt: now + 2 * day },
      { id: "d_late", state: "received", dueAt: now - day },
      { id: "d_calm", state: "in_progress", dueAt: now + 25 * day }
    ];
    expect(dsarOrder(rows, now).map((row) => row.id)).toEqual([
      "d_late",
      "d_soon",
      "d_calm",
      "d_done"
    ]);
    expect(dsarOrder(null, now)).toEqual([]);
  });
});
