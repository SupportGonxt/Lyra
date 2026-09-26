/**
 * The designer studio's engine (docs/30, ST1). One brief — headline, body,
 * kicker, call to action, an image — laid out in any of five templates at any
 * of the sizes a network, an ad slot or an inbox takes, from the tenant's own
 * brand kit (CLAUDE.md §5: name, colours, face and logo, never a literal).
 *
 * It emits an SVG string rather than JSX for the reason post-card.ts did: the
 * preview, the SVG download and the PNG the browser rasterises are the same
 * bytes. Standalone SVG cannot fetch the app's webfonts, so each face names a
 * Google Fonts family (docs/02 §9) with a system fallback.
 */

import { esc, wrap as wrapWords } from "./post-card.js";

/** Greedy wrap that also breaks a word longer than a line (a URL, a long compound) instead of running it off the frame. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).flatMap((word) => (word.length <= perLine ? [word] : word.match(new RegExp(`.{1,${perLine}}`, "gu")) ?? [word]));
  return wrapWords(words.join(" "), perLine, maxLines);
}

/** Every size the studio lays out, in pixels. */
export const FORMATS = {
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  story: { w: 1080, h: 1920 },
  landscape: { w: 1200, h: 628 },
  display: { w: 300, h: 250 },
  leaderboard: { w: 728, h: 90 },
  email: { w: 1200, h: 400 }
} as const;
export type DesignFormat = keyof typeof FORMATS;

export const TEMPLATES = ["spotlight", "split", "quote", "offer", "clean"] as const;
export type DesignTemplate = (typeof TEMPLATES)[number];

/** BrandJson.font → the family a standalone SVG can name. */
const FACES: Record<string, string> = {
  "space-grotesk": "'Space Grotesk'",
  inter: "Inter",
  "ibm-plex-sans-arabic": "'IBM Plex Sans Arabic'"
};
const LATIN = "Archivo, 'Instrument Sans', system-ui, sans-serif";
const ARABIC = "'IBM Plex Sans Arabic', 'Instrument Sans', system-ui, sans-serif";

const INK = "#0b0e13";
const INK_UP = "#161c28";
const PAPER = "#edf1f7";
const WHITE = "#f7f8fa";
const MUTED = "#aeb6c6";
const SLATE = "#4a5467";
const VEGA = "#c8f163";

// `| undefined` on every optional: exactOptionalPropertyTypes, read straight
// off a partial brand record.
export interface DesignBrand {
  name: string;
  accent?: string | undefined;
  accentContrast?: string | undefined;
  font?: string | undefined;
  logoHref?: string | undefined;
}

/** The elements a designer can move and resize. */
export const DESIGN_SLOTS = ["headline", "body", "kicker", "cta", "brand"] as const;
export type DesignSlot = (typeof DESIGN_SLOTS)[number];

/** A nudge from the layout's own placement: pixels in the frame, and a size factor. */
export interface DesignEdit {
  dx: number;
  dy: number;
  scale: number;
}

export interface DesignInput {
  template: DesignTemplate;
  format: DesignFormat;
  headline: string;
  body?: string | undefined;
  kicker?: string | undefined;
  cta?: string | undefined;
  imageHref?: string | undefined;
  brand: DesignBrand;
  locale?: string | undefined;
  /** Canvas edits per element (ST2); the layout's placement when absent. */
  edits?: Partial<Record<DesignSlot, DesignEdit>> | undefined;
}

interface Scheme {
  ground: string;
  head: string;
  body: string;
  kicker: string;
  /** The call-to-action pill and the text on it. */
  pill: string;
  onPill: string;
  brand: string;
}

function schemeOf(template: DesignTemplate, accent: string, onAccent: string): Scheme {
  switch (template) {
    case "clean":
      return { ground: WHITE, head: INK, body: SLATE, kicker: SLATE, pill: accent, onPill: onAccent, brand: INK };
    case "quote":
      return { ground: accent, head: onAccent, body: onAccent, kicker: onAccent, pill: onAccent, onPill: accent, brand: onAccent };
    case "offer":
      return { ground: INK, head: accent, body: PAPER, kicker: MUTED, pill: accent, onPill: onAccent, brand: PAPER };
    default:
      return { ground: INK, head: PAPER, body: MUTED, kicker: accent, pill: accent, onPill: onAccent, brand: PAPER };
  }
}

/** WCAG 2.2 contrast between two six-digit hex colours; null when either is not one. */
export function contrastRatio(a: string, b: string): number | null {
  const lum = (value: string): number | null => {
    const hex = value.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    const int = Number.parseInt(hex, 16);
    const [r, g, bl] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((raw) => {
      const s = raw / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const la = lum(a);
  const lb = lum(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface DesignFinding {
  slot: "headline" | "body" | "kicker" | "cta";
  ratio: number;
  /** 3 for display-size text, 4.5 for the rest (WCAG 2.2 AA). */
  required: number;
}

/**
 * The text a brand colour makes unreadable in this template. A creative with a
 * finding is a pre-flight fail: an ad nobody can read is not compliant copy.
 */
export function designFindings(input: Pick<DesignInput, "template" | "brand">): DesignFinding[] {
  const accent = input.brand.accent || VEGA;
  const s = schemeOf(input.template, accent, input.brand.accentContrast || INK);
  const pairs: Array<[DesignFinding["slot"], string, string, number]> = [
    ["headline", s.head, s.ground, 3],
    ["body", s.body, s.ground, 4.5],
    ["kicker", s.kicker, s.ground, 4.5],
    ["cta", s.onPill, s.pill, 3]
  ];
  return pairs.flatMap(([slot, fg, bg, required]) => {
    const ratio = contrastRatio(fg, bg);
    return ratio !== null && ratio < required ? [{ slot, ratio: Math.round(ratio * 100) / 100, required }] : [];
  });
}

const headlineSize = (length: number, u: number): number => Math.round((length <= 42 ? 92 : length <= 90 ? 72 : 56) * u);

export function designSvg(input: DesignInput): string {
  const { w, h } = FORMATS[input.format];
  const rtl = (input.locale ?? "en").startsWith("ar");
  const face = input.brand.font ? FACES[input.brand.font] : undefined;
  const family = face ? `${face}, ${rtl ? ARABIC : LATIN}` : rtl ? ARABIC : LATIN;
  const accent = input.brand.accent || VEGA;
  const s = schemeOf(input.template, accent, input.brand.accentContrast || INK);
  // SVG anchoring is logical: under direction="rtl", "start" is the right edge.
  // So the copy anchors at "start" in both scripts, and "end" is the far side.
  const anchor = "start";
  // Only a strip too shallow for a column (a leaderboard) reads as a banner.
  const banner = h / w < 0.2;
  // Wide frames are read at their height, not their width: a 1200×400 header
  // set at a square's scale prints body copy nobody can read.
  const u = banner ? h / 400 : w > h * 1.3 ? h / 620 : Math.min(w, h) / 1080;

  const text = (x: number, y: number, cls: string, value: string, extra = "") =>
    `<text x="${Math.round(x)}" y="${Math.round(y)}" class="${cls}"${extra}>${esc(value)}</text>`;
  // One group per element, so the editor grabs a whole headline, not a line of
  // it. An edit moves the group and scales it about its own origin, clamped to
  // the frame and to half-to-double size.
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
  const slot = (name: DesignSlot, ox: number, oy: number, inner: string, attrs = "") => {
    const e = input.edits?.[name];
    if (!inner) return "";
    const t = e
      ? ` transform="translate(${Math.round(clamp(e.dx, -w, w))} ${Math.round(clamp(e.dy, -h, h))}) translate(${Math.round(ox)} ${Math.round(oy)}) scale(${clamp(e.scale || 1, 0.5, 2)}) translate(${-Math.round(ox)} ${-Math.round(oy)})"`
      : "";
    return `<g data-slot="${name}"${attrs}${t}>${inner}</g>`;
  };
  const pill = (x: number, y: number, size: number, label: string, alignEnd: boolean) => {
    const pw = Math.round(label.length * size * 0.58 + size * 1.6);
    const ph = Math.round(size * 2);
    const left = alignEnd ? x - pw : x;
    return `<rect x="${Math.round(left)}" y="${Math.round(y)}" width="${pw}" height="${ph}" rx="${Math.round(ph / 2)}" fill="${s.pill}"/>${text(left + pw / 2, y + ph * 0.66, "cta", label, ' text-anchor="middle"')}`;
  };
  const logo = (x: number, y: number, size: number, alignEnd: boolean) =>
    input.brand.logoHref
      ? `<image href="${esc(input.brand.logoHref)}" x="${Math.round(alignEnd ? x - size : x)}" y="${Math.round(y)}" width="${Math.round(size)}" height="${Math.round(size)}" preserveAspectRatio="xMidYMid meet"/>`
      : "";

  const parts: string[] = [];
  const style = (head: number, body: number, kicker: number, cta: number, brand: number) => `<style>
text { font-family: ${family}; }
.kicker { fill: ${s.kicker}; font-size: ${kicker}px; letter-spacing: ${Math.max(1, Math.round(kicker / 8))}px; text-transform: uppercase; }
.head { fill: ${s.head}; font-size: ${head}px; font-weight: 700; }
.body { fill: ${s.body}; font-size: ${body}px; }
.cta { fill: ${s.onPill}; font-size: ${cta}px; font-weight: 700; }
.brand { fill: ${s.brand}; font-size: ${brand}px; font-weight: 700; }
</style>`;

  if (banner) {
    // One line of headline between the brand and the call to action: a banner
    // is read in a glance or not at all.
    const pad = Math.round(h * 0.18);
    const size = Math.round(h * 0.3);
    const cta = input.cta ?? "";
    const ctaSize = Math.round(h * 0.16);
    const brandW = Math.round(input.brand.name.length * size * 0.45 + (input.brand.logoHref ? h * 0.6 : 0));
    const ctaW = cta ? Math.round(cta.length * ctaSize * 0.58 + ctaSize * 1.6) + pad : 0;
    const room = w - pad * 3 - brandW - ctaW;
    const [line] = wrap(input.headline, Math.max(8, Math.floor(room / (size * 0.52))), 1);
    const start = rtl ? w - pad : pad;
    parts.push(style(size, 0, 0, ctaSize, Math.round(size * 0.7)));
    parts.push(`<rect width="${w}" height="${h}" fill="${s.ground}"/>`);
    const nameX = rtl ? start - (input.brand.logoHref ? h * 0.6 : 0) : start + (input.brand.logoHref ? h * 0.6 : 0);
    parts.push(slot("brand", start, h / 2, logo(start, (h - h * 0.5) / 2, h * 0.5, rtl) + text(nameX, h * 0.6, "brand", input.brand.name), ` text-anchor="${anchor}"`));
    const headX = rtl ? start - brandW - pad : start + brandW + pad;
    parts.push(slot("headline", headX, h / 2, text(headX, h * 0.62, "head", line ?? ""), ` text-anchor="${anchor}"`));
    if (cta) parts.push(slot("cta", rtl ? pad : w - pad, h / 2, pill(rtl ? pad : w - pad, (h - ctaSize * 2) / 2, ctaSize, cta, !rtl)));
  } else {
    const pad = Math.round(88 * u);
    const size = headlineSize(input.headline.length, u) * (input.template === "offer" ? 1.4 : 1);
    const bodySize = Math.round(34 * u);
    const kickerSize = Math.round(30 * u);
    const ctaSize = Math.round(30 * u);
    const brandSize = Math.round(32 * u);

    // The text column: the whole card, or the half the image does not take.
    const split = input.template === "split";
    const wide = w > h * 1.3;
    let colX = pad;
    let colW = w - pad * 2;
    let top = h * 0.42;
    let headSize = size;
    if (split) {
      if (wide) {
        const imgX = rtl ? w / 2 : 0;
        parts.push(`<clipPath id="half"><rect x="${imgX}" y="0" width="${w / 2}" height="${h}"/></clipPath>`);
        colX = rtl ? pad : w / 2 + pad;
        colW = w / 2 - pad * 2;
        headSize = Math.round(size * 0.7);
        top = h * 0.4;
      } else {
        parts.push(`<clipPath id="half"><rect x="0" y="0" width="${w}" height="${h * 0.44}"/></clipPath>`);
        headSize = Math.round(size * 0.78);
        top = h * 0.44 + headSize + pad * 0.9;
      }
    }
    const x = rtl ? colX + colW : colX;
    const perLine = Math.max(6, Math.floor(colW / (headSize * 0.6)));
    const headLines = wrap(input.headline, perLine, input.template === "offer" ? 2 : split && !wide ? 2 : 4);
    const bodyRoom = split ? 2 : h > w * 1.2 ? 6 : 3;
    const bodyLines = input.body ? wrap(input.body, Math.max(10, Math.floor(colW / (bodySize * 0.5))), bodyRoom) : [];
    const lead = Math.round(headSize * 1.14);

    parts.push(style(Math.round(headSize), bodySize, kickerSize, ctaSize, brandSize));
    parts.push(`<rect width="${w}" height="${h}" fill="${s.ground}"/>`);
    if (input.template === "spotlight" || input.template === "offer") {
      parts.push(
        `<radialGradient id="glow" cx="${rtl ? "0.85" : "0.15"}" cy="0.12" r="0.75"><stop offset="0" stop-color="${accent}" stop-opacity="0.3"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient><rect width="${w}" height="${h}" fill="url(#glow)"/><rect width="${w}" height="${h}" fill="${INK_UP}" opacity="0.25"/>`
      );
    }
    if (split) {
      const [cx, cy, cw, ch] = wide ? [rtl ? w / 2 : 0, 0, w / 2, h] : [0, 0, w, h * 0.44];
      parts.push(
        input.imageHref
          ? `<image href="${esc(input.imageHref)}" x="${cx}" y="${cy}" width="${cw}" height="${ch}" preserveAspectRatio="xMidYMid slice" clip-path="url(#half)"/>`
          : `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="${accent}"/>`
      );
    }
    if (input.template === "quote") {
      parts.push(`<text x="${Math.round(x)}" y="${Math.round(top - headSize * 0.9)}" class="head" text-anchor="${anchor}" style="font-size:${Math.round(headSize * 2.2)}px">“</text>`);
    }
    if (input.template === "spotlight") {
      parts.push(`<rect x="${Math.round(rtl ? x + 16 * u : x - 22 * u)}" y="${Math.round(top - headSize - 40 * u)}" width="${Math.max(2, Math.round(6 * u))}" height="${Math.round(headSize + 48 * u)}" fill="${accent}"/>`);
    }

    // The block never runs into the brand line: taller copy starts higher.
    const block = headLines.length * lead + 44 * u + bodyLines.length * bodySize * 1.4 + (input.cta ? 24 * u + ctaSize * 2 : 0);
    // A wide frame's brand sits in the top corner, so the copy may run to the foot.
    const brandTop = wide && !split;
    const floor = brandTop ? h - pad * 0.6 : h - pad * 0.8 - brandSize * 1.8;
    if (top + block > floor) top = Math.max(headSize + kickerSize + pad * 0.6, floor - block);
    const bodyTop = top + headLines.length * lead + 44 * u;
    // The quote mark is the quote layout's kicker; both would collide.
    if (input.kicker && input.template !== "quote") {
      parts.push(slot("kicker", x, top - headSize, text(x, top - headSize - 6 * u, "kicker", input.kicker), ` text-anchor="${anchor}"`));
    }
    parts.push(slot("headline", x, top, headLines.map((line, i) => text(x, top + i * lead, "head", line)).join(""), ` text-anchor="${anchor}"`));
    parts.push(slot("body", x, bodyTop, bodyLines.map((line, i) => text(x, bodyTop + i * bodySize * 1.4, "body", line)).join(""), ` text-anchor="${anchor}"`));
    const afterBody = bodyTop + bodyLines.length * bodySize * 1.4 + 24 * u;
    if (input.cta) parts.push(slot("cta", x, afterBody, pill(x, afterBody, ctaSize, input.cta, rtl)));

    // The brand sits on the foot of the text column with its mark — or, on a
    // wide frame, in the top corner opposite the copy's start.
    const footY = brandTop ? pad * 0.9 : h - pad * 0.8;
    const bx = brandTop ? (rtl ? pad : w - pad) : x;
    const bEnd = brandTop ? !rtl : rtl;
    const markSize = brandSize * 1.6;
    const nameX = input.brand.logoHref ? (bEnd ? bx - markSize - 16 * u : bx + markSize + 16 * u) : bx;
    parts.push(
      slot("brand", bx, footY, logo(bx, footY - markSize * 0.8, markSize, bEnd) + text(nameX, footY, "brand", input.brand.name), ` text-anchor="${brandTop ? "end" : "start"}"`)
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(input.headline)}" direction="${rtl ? "rtl" : "ltr"}">
${parts.filter(Boolean).join("\n")}
</svg>`;
}
