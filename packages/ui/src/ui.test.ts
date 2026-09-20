/**
 * @lyra/ui invariants. No DOM, no jsdom — these assert the three things that
 * silently rot in a design system and that a render test would not catch:
 *
 *   1. tokens.css still defines every token docs/01 §3–4 names (and the same
 *      hex values), so the brand and the code cannot drift apart.
 *   2. No component style uses a physical-direction CSS property or Tailwind
 *      utility, so RTL is structural rather than retro-fitted.
 *   3. No navigation component can render without a visible text label.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, shortRef } from "./format.js";
import { groupCommandItems } from "./overlays.js";
import { fromSelectValue, toSelectValue } from "./primitives.js";
import { KIT_TEXT, uiText } from "./text.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const REPO = join(SRC, "..", "..", "..");

const read = (p: string) => readFileSync(p, "utf8");
const tokens = read(join(SRC, "tokens.css"));
const brandDoc = read(join(REPO, "docs", "01-brand.md"));

const componentFiles = readdirSync(SRC)
  .filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !/\.test\.tsx?$/.test(f))
  .map((f) => [f, read(join(SRC, f))] as const);

function section(doc: string, from: string, to: string): string {
  const start = doc.indexOf(from);
  const end = doc.indexOf(to, start + 1);
  expect(start, `docs/01-brand.md must still contain "${from}"`).toBeGreaterThan(-1);
  return doc.slice(start, end === -1 ? undefined : end);
}

/* -------------------------------------------------------------------------- */

describe("tokens.css covers docs/01 §3–4", () => {
  const colour = section(brandDoc, "## 3. Color", "## 4. Typography");
  const typography = section(brandDoc, "## 4. Typography", "## 5. Iconography");

  // Palette table rows: | `ink-900` (Deep Field) | `#070B14` | ... |
  const paletteRows = [...colour.matchAll(/^\|\s*`([a-z]+-\d+)`[^|]*\|\s*`(#[0-9A-Fa-f]{6})`/gm)];

  it("finds the palette table in the brand doc", () => {
    expect(paletteRows.length).toBeGreaterThanOrEqual(11);
  });

  it.each(paletteRows.map((m) => [m[1] as string, m[2] as string]))(
    "defines --%s as %s",
    (token, hex) => {
      const declared = new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens);
      expect(declared, `tokens.css must declare --${token}`).not.toBeNull();
      expect(declared?.[1]?.toLowerCase()).toBe(hex.toLowerCase());
    }
  );

  // Module accents: AXIS `#FFB020` (vega) · ORBIT `#37D3B2` (ion) · …
  const moduleAccents = [...colour.matchAll(/\b(AXIS|ORBIT|SIGNAL|SCOUT|NORTH)\s+`(#[0-9A-Fa-f]{6})`/g)];

  it("names all five module accents", () => {
    expect(moduleAccents).toHaveLength(5);
  });

  it.each(moduleAccents.map((m) => [(m[1] as string).toLowerCase(), m[2] as string]))(
    "defines --module-%s as %s",
    (mod, hex) => {
      const declared = new RegExp(`--module-${mod}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens);
      expect(declared, `tokens.css must declare --module-${mod}`).not.toBeNull();
      expect(declared?.[1]?.toLowerCase()).toBe(hex.toLowerCase());
    }
  );

  // docs/27 P2: `.exec` above finds only the *first* --module-axis in the
  // file — the dark default at :root — so the two light-mode definition sites
  // (the `prefers-color-scheme: light` media query and the explicit
  // `[data-theme="light"]` override) could drift from docs/01-brand.md:83
  // unnoticed, and did: both shipped `#b45309` where the doc names
  // `#A2660B`. Guarded the same way, just against the light row instead of
  // the dark one.
  it("defines --module-axis's light-mode row as docs/01-brand.md:83 names it", () => {
    const axisLight = /AXIS\s+`#[0-9A-Fa-f]{6}`\s*\([^)]*\)\s*\/\s*`(#[0-9A-Fa-f]{6})`\s*\(light\)/.exec(colour);
    expect(axisLight, "docs/01-brand.md must still name AXIS's light hue").not.toBeNull();
    const lightHex = (axisLight?.[1] as string).toLowerCase();

    // Two definition sites; the dark default at :root is the first
    // --module-axis in the file and is not one of these.
    const lightSites = [...tokens.matchAll(/--module-axis:\s*(#[0-9A-Fa-f]{6});/g)].slice(1);
    expect(lightSites, "tokens.css should declare --module-axis in both light-mode blocks").toHaveLength(2);
    for (const [, hex] of lightSites) {
      expect((hex as string).toLowerCase()).toBe(lightHex);
    }
  });

  const fontRoles = ["Space Grotesk", "Inter", "IBM Plex Mono", "IBM Plex Sans Arabic"];
  it.each(fontRoles)("wires the %s type role", (font) => {
    expect(typography, `docs/01 §4 should still name ${font}`).toContain(font);
    expect(tokens, `tokens.css must reference ${font}`).toContain(font);
  });

  // "Scale (rem): 12, 13, 14 (body), 16, 18, 22, 28, 36, 48."
  const scaleLine = /Scale \(rem\):([^.]+)\./.exec(typography)?.[1] ?? "";
  const steps = [...scaleLine.matchAll(/\b(\d{2})\b/g)].map((m) => m[1] as string);

  it("finds the type scale in the brand doc", () => {
    expect(steps.length).toBeGreaterThanOrEqual(9);
  });

  it.each(steps)("defines the --text-%s step", (step) => {
    expect(tokens).toMatch(new RegExp(`--text-${step}:\\s*[\\d.]+rem`));
  });

  it("is dark-first with a light re-map", () => {
    expect(tokens).toContain("color-scheme: dark");
    expect(tokens).toContain('[data-theme="light"]');
    expect(tokens).toContain("prefers-color-scheme: light");
  });

  it("documents the tenant override subset", () => {
    for (const v of ["--accent", "--accent-hover", "--accent-contrast", "--font-display", "--font-ui"]) {
      expect(tokens, `tenant contract must list ${v}`).toContain(v);
    }
    expect(tokens).toContain("TENANT OVERRIDE CONTRACT");
  });

  it("wires Tailwind v4 via @theme", () => {
    expect(tokens).toMatch(/@theme\b/);
    expect(tokens).toContain("--color-accent: var(--accent)");
  });
});

/* -------------------------------------------------------------------------- */

describe("RTL: logical properties only", () => {
  // Physical CSS declarations, and the Tailwind utilities that compile to them.
  const physical: Array<[string, RegExp]> = [
    ["margin-left / margin-right", /\b(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b/],
    ["text-align: left|right", /text-align\s*:\s*(?:left|right)/],
    ["float", /\bfloat\s*:\s*(?:left|right)/],
    ["tw ml-/mr-/pl-/pr-", /(?:^|[\s"'`{-])(?:ml|mr|pl|pr)-/],
    ["tw left-/right-", /(?:^|[\s"'`{-])(?:left|right)-\d/],
    ["tw border-l/border-r", /(?:^|[\s"'`{-])border-[lr](?:\b|-)/],
    ["tw rounded-l/rounded-r/corner", /(?:^|[\s"'`{-])rounded-(?:l|r|tl|tr|bl|br)(?:\b|-)/],
    ["tw text-left/text-right", /(?:^|[\s"'`{-])text-(?:left|right)\b/],
    ["tw float-left/float-right", /(?:^|[\s"'`{-])float-(?:left|right)\b/]
  ];

  it.each(componentFiles)("%s uses no physical-direction styling", (_name, source) => {
    for (const [label, re] of physical) {
      expect(re.test(source), `${_name} must not use ${label}`).toBe(false);
    }
  });

  it("does use the logical equivalents", () => {
    const all = componentFiles.map(([, s]) => s).join("\n");
    for (const logical of ["ms-", "ps-", "pe-", "border-e", "border-s", "text-start", "insetInlineStart"]) {
      expect(all, `expected logical utility ${logical}`).toContain(logical);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("navigation always renders a visible label", () => {
  const nav = read(join(SRC, "nav.tsx"));
  // Comments explain the rule (and so quote the banned words); scan the code.
  const navCode = nav.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const interfaceBody = (name: string): string => {
    const m = new RegExp(`(?:interface|type)\\s+${name}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(nav);
    expect(m, `nav.tsx must declare ${name}`).not.toBeNull();
    return m?.[1] ?? "";
  };

  // Every component that renders a navigation target.
  it.each(["NavItemProps", "NavSectionProps", "NavRailProps", "ModuleLink"])(
    "%s requires a label",
    (name) => {
      const body = interfaceBody(name);
      expect(body, `${name}.label must be required`).toMatch(/\blabel:\s*string/);
      expect(body, `${name}.label must not be optional`).not.toMatch(/\blabel\?:/);
    }
  );

  it("has no icon-only escape hatch", () => {
    for (const banned of [
      "collapsed",
      "collapsible",
      "iconOnly",
      "icon-only",
      "hideLabel",
      "labelHidden",
      "showLabel",
      "sr-only"
    ]) {
      expect(navCode.includes(banned), `nav.tsx must not contain "${banned}"`).toBe(false);
    }
  });

  it("never renders the label conditionally", () => {
    // A branch on `label` would be the seed of an icon-only mode.
    // `label?:` is a type annotation, not a branch — hence the (?!:).
    // `label ?? t("modules")` is a catalogue fallback, not a branch: the label
    // still always renders, only its words come from KIT_TEXT when the caller
    // passed none. Strip those, then any surviving branch is the icon-only seed.
    const branching = navCode.replace(/\b(\w*[Ll]abel)\s*\?\?\s*t\("\w+"\)/g, '$1');
    expect(branching).not.toMatch(/\blabel\s*(?:&&|\?(?!:))/);
    // Icons, by contrast, are the optional part.
    expect(navCode).toMatch(/icon\s*\?/);
    expect(navCode).toContain("<span className=\"flex-1 truncate text-start\">{label}</span>");
  });

  it("every optional nav label falls back to the kit catalogue", () => {
    const optional = [...nav.matchAll(/\blabel\?:\s*string/g)].length;
    const fallbacks = [...nav.matchAll(/\b\w*[Ll]abel \?\? t\("(\w+)"\)/g)];
    expect(fallbacks.length).toBeGreaterThanOrEqual(optional);
    // An English default was the old answer; it stayed English under `ar`.
    expect(nav).not.toMatch(/\blabel = "/);
  });

  it("marks decorative icons aria-hidden", () => {
    expect(nav).toContain('aria-hidden="true"');
  });
});

/* -------------------------------------------------------------------------- */

describe("Select reserves the empty string for Radix", () => {
  // Radix reads `value === ""` on Select.Root as "nothing selected" — it is what
  // raises the placeholder — so a Select.Item may not carry it: Radix says so on
  // the console and the row can never read as chosen. Screens still need an
  // "All" / "System default" row, so the wrapper encodes it. This harness is
  // DOM-free (see the file header), so the contract is asserted where it is
  // decided — the codec and the one call site that feeds Select.Item.
  const primitives = read(join(SRC, "primitives.tsx"));

  it("never hands Select.Item an empty value", () => {
    expect(toSelectValue("")).not.toBe("");
    // Anything Radix would accept passes through untouched.
    for (const value of ["open", "1", "IBM Plex Sans Arabic", "0"]) {
      expect(toSelectValue(value)).toBe(value);
    }
  });

  it("clears the field when the empty row is chosen", () => {
    // What onValueChange reports, and what `name` submits, is "" — not the
    // sentinel — so picking "All" drops the filter instead of inventing one.
    expect(fromSelectValue(toSelectValue(""))).toBe("");
    for (const value of ["open", "1"]) {
      expect(fromSelectValue(toSelectValue(value))).toBe(value);
    }
  });

  it("keeps the sentinel inside the design system", () => {
    // Exported for this test and for nothing else: a call site that could name
    // the sentinel could also mean it, and then it would reach the API.
    const escaped = componentFiles.filter(
      ([name, source]) => name !== "primitives.tsx" && source.includes("SENTINEL")
    );
    expect(escaped.map(([name]) => name)).toEqual([]);
    expect(toSelectValue("")).not.toBe(fromSelectValue(toSelectValue("")));
  });

  it("routes every Select.Item value through the codec", () => {
    const items = [...primitives.matchAll(/<RSelect\.Item[^>]*?\bvalue=\{([^\n]*)\}/g)];
    expect(items.length).toBeGreaterThan(0);
    for (const [, expression] of items) {
      expect(expression, "a Select.Item value must be encoded").toContain("toSelectValue(");
    }
    // …and the value Radix is told is current is the decoded one, so the
    // sentinel never reaches the hidden native input that `name` submits.
    expect(primitives).toContain("fromSelectValue(next)");
  });
});

/* -------------------------------------------------------------------------- */

describe("kit chrome is translated, not hardcoded", () => {
  it("ships an Arabic entry for every English key", () => {
    expect(Object.keys(KIT_TEXT.ar!).sort()).toEqual(Object.keys(KIT_TEXT.en!).sort());
  });

  it("resolves a region subtag to its base locale", () => {
    expect(uiText("ar-AE")("approve")).toBe(KIT_TEXT.ar!.approve);
  });

  it("falls back to English for a locale it has never heard of", () => {
    expect(uiText("pseudo")("approve")).toBe(KIT_TEXT.en!.approve);
  });

  it("fills named slots", () => {
    expect(uiText("en")("requestedBy", { who: "Dana" })).toBe("Requested by Dana");
  });

  // The literals these components used to render inline. A kit that speaks its
  // own English cannot be translated by the app that embeds it, and 98 Table
  // call sites will never all remember to pass a string in.
  const banned = [
    '"Nothing here yet."',
    '"Audit trail"',
    '"Pagination"',
    '"Rows"',
    '"Previous"',
    '"Next"',
    '"Waiting"',
    '"Done"',
    '"When"',
    '"Actor"',
    '"Action"',
    '"Target"',
    '"Detail"',
    '"AI-generated"',
    '"Why this was drafted"',
    '"Model confidence"',
    '"Evidence"',
    '"AI budget"',
    '"Pending approval"',
    "Drafted by",
    "Requested by",
    "Budget exhausted",
    "Resets {",
    ">Reject<",
    ">Approve<",
    "Accept <kbd",
    "Discard <kbd"
  ];

  // Same rot, one layer further in: a prop whose *default* is English. The
  // caller who forgets the prop gets English under `ar` and no test notices,
  // because the literal never appears in JSX — it sits in the signature.
  it("gives no prop an English default", () => {
    // An enum default ("md", "inline-end", "26rem") is lowercase and unspaced.
    // Prose starts with a capital or contains a space.
    const englishDefault = /^\s*([A-Za-z]\w*) = "([A-Z][^"]*|[^"]*\s[^"]*)"/gm;
    const offenders: string[] = [];
    for (const [name, code] of componentFiles) {
      for (const [, prop, value] of code.matchAll(englishDefault)) {
        offenders.push(`${name}: ${prop} = "${value}"`);
      }
    }
    expect(offenders, "route these through KIT_TEXT via useUiText()").toEqual([]);
  });

  it("only asks the catalogue for keys it has", () => {
    for (const [name, code] of componentFiles) {
      for (const match of code.matchAll(/\bt\("(\w+)"/g)) {
        const key = match[1] ?? "";
        expect(KIT_TEXT.en, `${name} reads t("${key}")`).toHaveProperty(key);
      }
    }
  });

  it.each(["data.tsx", "ai.tsx"])("%s renders no English of its own", (name) => {
    const code = read(join(SRC, name))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");
    for (const literal of banned) {
      expect(code.includes(literal), `${name} must not contain ${literal}`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("Table is reachable from the keyboard", () => {
  const data = read(join(SRC, "data.tsx"));

  it("names its scroll region and gives it a tab stop", () => {
    // WCAG 2.2 AA scrollable-region-focusable: a pointer-only scroller strands
    // keyboard users on every wide table in the product.
    expect(data).toMatch(/role="region"[\s\S]{0,240}tabIndex=\{0\}/);
  });

  it("never calls a table row a button", () => {
    // role="button" on a <tr> deletes the row/cell semantics screen readers
    // navigate a table with; the row keeps its tabIndex and Enter handler.
    expect(data).not.toMatch(/role:\s*"button"/);
  });
});

/* -------------------------------------------------------------------------- */

describe("shortRef hides storage keys without hiding anything else", () => {
  it("keeps the prefix and both ends of a ULID", () => {
    expect(shortRef("us_01KE953T07XY8ZQK4M2N6VJH3B")).toBe("us_01KE…JH3B");
  });

  it("keeps a scope in front of the ref", () => {
    expect(shortRef("user:us_01KE953T07XY8ZQK4M2N6VJH3B")).toBe("user:us_01KE…JH3B");
  });

  // SCOUT's evidence chips scope with an underscore, and the radar dossier was
  // printing all 26 characters of `scout_cluster:clu_…` across a side panel.
  it("keeps an underscored scope in front of the ref", () => {
    expect(shortRef("scout_cluster:clu_01KE953T01PGEWT2MJW1EDH8R1")).toBe(
      "scout_cluster:clu_01KE…H8R1"
    );
  });

  // A transaction's idempotency key is `<txn-type>:<subject>` and sometimes
  // carries the period it covers on the end (docs/19 §3). The ledger printed
  // all 26 characters of `prem-remit:pol_…` in its REFERENCE column: the type
  // and the period are the readable parts, the ULID in the middle is not.
  it("keeps a hyphenated scope and a trailing qualifier", () => {
    expect(shortRef("prem-remit:pol_01KZZWT01BM04WBABVJZ3CAFY1")).toBe("prem-remit:pol_01KZ…AFY1");
    expect(shortRef("sub-invoice:pv_01KZTR0J1CT91BSD37TMG0TSQ5:2026-08")).toBe(
      "sub-invoice:pv_01KZ…TSQ5:2026-08"
    );
    // AXIS spells its own with a dot: `axis.renew:pol_…`.
    expect(shortRef("axis.renew:pol_01KZZWT01C29RTQZ426J7TTEP5")).toBe("axis.renew:pol_01KZ…TEP5");
  });

  it.each([
    "CASE-1042",
    "sara@example.com",
    "Sara Haddad",
    "MOTOR-COMP",
    "",
    "funnel:gonxt-web/renewal-compare",
    "app-store:ae/gonxt-app/2026-01"
  ])(
    "leaves %s alone",
    (value) => {
      expect(shortRef(value)).toBe(value);
    }
  );
});

/* -------------------------------------------------------------------------- */

describe("Hijri dates are pinned, not just requested", () => {
  // 8 January 2026, 10:41:03 in Riyadh — 19 Rajab 1447 in the Umm al-Qura
  // calendar. A golden per precision: an ICU upgrade that shifted the reckoning
  // by a day would otherwise surface as a customer noticing their contract date
  // moved.
  const instant = new Date("2026-01-08T07:41:03Z");
  const riyadh = { locale: "en", timeZone: "Asia/Riyadh", calendar: "islamic-umalqura" } as const;

  it.each([
    ["day", "Raj. 19, 1447 AH"],
    ["minute", "Raj. 19, 1447 AH, 10:41 AM"],
    ["second", "Raj. 19, 1447 AH, 10:41:03 AM"]
  ] as const)("renders %s precision as %s", (precision, expected) => {
    expect(formatDate(instant, { ...riyadh, precision })).toBe(expected);
  });

  it("reckons in Arabic too, since that is who asks for it", () => {
    expect(formatDate(instant, { ...riyadh, locale: "ar", precision: "day" })).toBe(
      "19 رجب 1447 هـ"
    );
  });

  it("leaves the Gregorian rendering alone", () => {
    expect(formatDate(instant, { locale: "en", timeZone: "Asia/Riyadh", precision: "day" })).toBe(
      "Jan 08, 2026"
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("Eastern Arabic-Indic digits are pinned, not just requested", () => {
  // docs/27 F42. A golden per surface, for the Hijri goldens' reason: the
  // numbering system is CLDR data, so an ICU upgrade that changed which digits
  // `ar-SA` resolves to would otherwise reach a Riyadh customer before it
  // reached us. And unlike a date, nothing on the page looks wrong to the
  // engineer reading it in English.
  //
  // The pair is the point. `ar` and `ar-SA` are the same language and the same
  // catalogue; the only thing the region subtag changes is this. So a
  // resolution step that strips it — which is what `localeFrom` did, and why
  // this describe exists — cannot be caught by any test of the Arabic
  // catalogue, only by a test of the digits.
  it("numbers ar-SA in ١٢٣ and ar in 123", () => {
    expect(new Intl.NumberFormat("ar-SA").format(1523)).toBe("١٬٥٢٣");
    expect(new Intl.NumberFormat("ar").format(1523)).toBe("1,523");
  });

  it("carries the numbering system into money, which is where a customer meets it", () => {
    // Escaped in full because three of the characters are invisible and one is
    // a non-breaking space: U+200F is the RTL mark Intl wraps an Arabic
    // currency amount in, U+066C the thousands separator, U+066B the decimal.
    expect(formatMoney(1_234_50, "AED", "ar-SA")).toBe("‏١٬٢٣٤٫٥٠ د.إ.‏");
    expect(formatMoney(1_234_50, "AED", "ar")).toBe("‏1,234.50 د.إ.‏");
    expect(formatMoney(1_234_50, "AED", "en")).toBe("AED 1,234.50");
  });

  it("reckons the decimal and grouping separators regionally too", () => {
    // ar-MA groups on "." and points on "," — the same language, a third set of
    // conventions. A base-subtag-only resolution renders all three identically.
    expect(new Intl.NumberFormat("ar-MA").format(1234567.89)).toBe("1.234.567,89");
    expect(new Intl.NumberFormat("ar-EG").format(1234567.89)).toBe("١٬٢٣٤٬٥٦٧٫٨٩");
  });

  // The other half of the same finding is verified where it lives, because
  // @lyra/ui does not depend on @lyra/core and must not start: once a screen
  // renders ١٢٣, a model asked to narrate it writes ١٢٣ back, and
  // `extractNumbers` matched ASCII only — so NORTH's number-verification gate
  // passed every Arabic fabrication (docs/27 F46). See
  // packages/core/src/narrator-verify.test.ts, "numbers written in Arabic".
});

/* -------------------------------------------------------------------------- */

describe("CommandBar keeps its rows in the order the caller gave them", () => {
  const rows = [
    { id: "a", label: "Operations", group: "Go to", onSelect: () => {} },
    { id: "b", label: "Service", group: "Go to", onSelect: () => {} },
    { id: "c", label: "CASE-1042", group: "Results", onSelect: () => {} }
  ];

  it("collects consecutive rows under one heading", () => {
    expect(groupCommandItems(rows).map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([
      ["Go to", ["a", "b"]],
      ["Results", ["c"]]
    ]);
  });

  it("leaves ungrouped rows unlabelled rather than inventing a heading", () => {
    const plain = [{ id: "x", label: "Sign out", onSelect: () => {} }];
    expect(groupCommandItems(plain)).toEqual([{ name: null, items: plain }]);
  });

  it("never merges two runs of the same name into one block", () => {
    // Order is the caller's answer to relevance; regrouping would reorder it.
    const interleaved = [rows[0]!, rows[2]!, rows[1]!];
    expect(groupCommandItems(interleaved).map((g) => g.name)).toEqual(["Go to", "Results", "Go to"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("package surface", () => {
  const index = read(join(SRC, "index.ts"));
  it("re-exports every module", () => {
    for (const [name] of componentFiles) {
      if (name === "index.ts") continue;
      expect(index).toContain(`./${name.replace(/\.tsx?$/, "")}.js`);
    }
  });

  it("exports the names apps/web is written against", () => {
    const all = componentFiles.map(([, s]) => s).join("\n");
    for (const c of ["Button", "Input", "Field", "Card", "Table", "Badge"]) {
      expect(all, `${c} must be exported`).toMatch(new RegExp(`export (?:function|const) ${c}\\b`));
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("Select submits what it shows", () => {
  const primitives = read(join(SRC, "primitives.tsx"));

  // Radix's own hidden <select> is keyed by the options its items register,
  // and those items unmount with the portalled popup — so it can remount
  // mid-interaction and carry the previous value into the submit. J-O1 caught
  // a case saved as `status=intake` while its trigger read "Failed".
  it("never delegates the form value to Radix's bubble select", () => {
    expect(primitives).not.toMatch(/RSelect\.Root[\s\S]{0,400}?\{ name \}/);
  });

  it("submits the same state the trigger renders", () => {
    expect(primitives).toMatch(/<input type="hidden" name=\{name\} value=\{current\} \/>/);
  });
});
