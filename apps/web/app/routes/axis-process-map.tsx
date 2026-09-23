import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { EmptyState, Panel } from "@lyra/ui";
import { api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { arrowFor, translator } from "../i18n";
import { labelsFrom, rowsOf, safe, tag, type Label, type Page } from "./detail-kit";
import { useAxisSessionData } from "./axis-shell";

// Tenant-wide process mining, not one case's timeline — case-detail.tsx
// already tables a single case's steps. This reads axis_process_events across
// every case in a capped recent window and turns the step-to-step transitions
// into a flow diagram: where work actually goes, and where it pools
// (packages/db/src/schema/axis.ts's comment on the table: "Normalized step
// events for process mining").

const PERM = { read: "axis:metrics:read" } as const;
// 200 is the backend's MAX_PAGE (apps/api/src/http.ts) — a request above it 400s.
const WINDOW = 200;

export interface EventRow {
  id: string;
  caseId: string;
  step: string;
  ts: number;
  durationMs?: number | null;
}

/* ------------------------------------------------------------------- flow */

export interface FlowEvent {
  caseId: string;
  step: string;
  ts: number;
  durationMs?: number | null;
}

export interface FlowNode {
  step: string;
  rank: number;
  total: number;
}

export interface FlowLink {
  from: string;
  to: string;
  count: number;
  avgMs: number;
}

export interface Flow {
  nodes: FlowNode[];
  links: FlowLink[];
}

/** One row per case, chronological, tallied into step-to-step transitions. */
export function flowFrom(events: readonly FlowEvent[]): Flow {
  const byCase = new Map<string, FlowEvent[]>();
  for (const event of events) {
    const bucket = byCase.get(event.caseId);
    if (bucket) bucket.push(event);
    else byCase.set(event.caseId, [event]);
  }

  const total = new Map<string, number>();
  const linkKey = (from: string, to: string) => JSON.stringify([from, to]);
  const linkCount = new Map<string, number>();
  const linkDuration = new Map<string, number>();
  const allSteps = new Set<string>();
  const predecessors = new Map<string, Set<string>>(); // step -> set of predecessors

  for (const caseEvents of byCase.values()) {
    const sequence = [...caseEvents].sort((a, b) => a.ts - b.ts);
    let previous: FlowEvent | null = null;
    for (const event of sequence) {
      allSteps.add(event.step);
      total.set(event.step, (total.get(event.step) ?? 0) + 1);
      if (previous) {
        const key = linkKey(previous.step, event.step);
        linkCount.set(key, (linkCount.get(key) ?? 0) + 1);
        linkDuration.set(
          key,
          (linkDuration.get(key) ?? 0) + (event.durationMs ?? 0),
        );

        // Track predecessors for rank calculation
        if (!predecessors.has(event.step))
          predecessors.set(event.step, new Set());
        predecessors.get(event.step)!.add(previous.step);
      }
      previous = event;
    }
  }

  // Calculate ranks based on longest path from any source
  const rank = new Map<string, number>();
  const visited = new Set<string>();

  function calculateRank(step: string): number {
    if (rank.has(step)) return rank.get(step)!;

    if (visited.has(step)) return 0; // cycle detection
    visited.add(step);

    const preds = predecessors.get(step);
    if (!preds || preds.size === 0) {
      rank.set(step, 0);
      return 0;
    }

    let maxPredecessorRank = -1;
    for (const pred of preds) {
      maxPredecessorRank = Math.max(maxPredecessorRank, calculateRank(pred));
    }

    const r = maxPredecessorRank + 1;
    rank.set(step, r);
    return r;
  }

  // Calculate ranks for all steps
  for (const step of allSteps) {
    calculateRank(step);
  }

  const nodes = [...rank.entries()]
    .map(([step, r]) => ({ step, rank: r, total: total.get(step) ?? 0 }))
    .sort((a, b) => a.rank - b.rank);

  const links = [...linkCount.entries()].map(([key, count]) => {
    const [from, to] = JSON.parse(key) as [string, string];
    return { from, to, count, avgMs: (linkDuration.get(key) ?? 0) / count };
  });

  return { nodes, links };
}

export interface LaidOutNode extends FlowNode {
  x: number;
  y: number;
  /** How much work the step saw, as the length of its bar. */
  width: number;
}

export interface LaidOutLink extends FlowLink {
  path: string;
  width: number;
}

export interface Layout {
  nodes: LaidOutNode[];
  links: LaidOutLink[];
}

/** How thick a step's bar is. The bar's *length* carries how much work it saw. */
const NODE_HEIGHT = 14;
const NODE_GAP = 12;
/** Vertical room per rank: the bar plus space for its ribbons to fan out. */
export const ROW_HEIGHT = 56;
/** The tallest a step's bar gets, as a share of the canvas width. */
const BAR_SHARE = 0.26;

/** The canvas a flow needs. Ranks run down the page, so depth is height. */
export function flowHeight(flow: Flow): number {
  const maxRank = flow.nodes.reduce((max, node) => Math.max(max, node.rank), 0);
  return Math.max(ROW_HEIGHT * 2, (maxRank + 1) * ROW_HEIGHT);
}

/**
 * ponytail: hand-rolled bezier ribbons — the same call Sparkline makes for a
 * line chart, no chart library.
 *
 * The flow runs top to bottom, not left to right. Laid out sideways, ten ranks
 * across 880px left each step 87px of column — narrower than "Documents
 * requested (1)" — so every label overwrote its neighbour and the last one ran
 * off the canvas, while the 420px of height went unused. Down the page each step
 * gets the full width for its name.
 */
export function layoutFlow(flow: Flow, width: number, height: number): Layout {
  const maxRank = flow.nodes.reduce((max, node) => Math.max(max, node.rank), 0);
  const rowHeight = maxRank > 0 ? (height - NODE_HEIGHT) / maxRank : 0;
  const maxTotal = flow.nodes.reduce((max, node) => Math.max(max, node.total), 0) || 1;

  const byRow = new Map<number, FlowNode[]>();
  for (const node of flow.nodes) {
    const bucket = byRow.get(node.rank);
    if (bucket) bucket.push(node);
    else byRow.set(node.rank, [node]);
  }

  const positioned = new Map<string, LaidOutNode>();
  for (const row of byRow.values()) {
    let x = 0;
    for (const node of row) {
      const nodeWidth = Math.max(4, (node.total / maxTotal) * width * BAR_SHARE);
      positioned.set(node.step, { ...node, x, y: node.rank * rowHeight, width: nodeWidth });
      x += nodeWidth + NODE_GAP;
    }
  }

  const outOffset = new Map<string, number>();
  const inOffset = new Map<string, number>();
  const maxCount = flow.links.reduce((max, link) => Math.max(max, link.count), 0) || 1;

  const links = flow.links.map((link) => {
    const source = positioned.get(link.from);
    const target = positioned.get(link.to);
    if (!source || !target) return { ...link, path: "", width: 0 };

    const linkWidth = Math.max(1, (link.count / maxCount) * 24);
    const sourceX = source.x + (outOffset.get(link.from) ?? 0) + linkWidth / 2;
    const targetX = target.x + (inOffset.get(link.to) ?? 0) + linkWidth / 2;
    outOffset.set(link.from, (outOffset.get(link.from) ?? 0) + linkWidth);
    inOffset.set(link.to, (inOffset.get(link.to) ?? 0) + linkWidth);

    const y1 = source.y + NODE_HEIGHT;
    const y2 = target.y;
    const midY = (y1 + y2) / 2;
    return {
      ...link,
      path: `M ${sourceX} ${y1} C ${sourceX} ${midY}, ${targetX} ${midY}, ${targetX} ${y2}`,
      width: linkWidth
    };
  });

  return { nodes: [...positioned.values()], links };
}

/** The single slowest step-to-step transition — the concrete answer to "where
 *  does it pool". Ties keep the first one seen, which is stable output order
 *  from `flowFrom`. */
export function worstBottleneck(links: readonly FlowLink[]): FlowLink | null {
  return links.reduce<FlowLink | null>(
    (worst, link) => (worst === null || link.avgMs > worst.avgMs ? link : worst),
    null,
  );
}

// Arithmetic on the flow the caller already has, not an agent, so it never
// carries the ✦ mark (CLAUDE.md §11).
export function headlineFor(flow: Flow, l: Label): string {
  if (flow.nodes.length === 0) return l("headline.empty");
  const worst = worstBottleneck(flow.links);
  if (worst && worst.avgMs > 0)
    return l("headline.bottleneck", {
      from: tag(l, "step", worst.from),
      to: tag(l, "step", worst.to),
    });
  return l("headline.moving");
}

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Process map",
    intro: `Where work actually flows across the last ${WINDOW} recorded steps, and where it pools.`,
    "headline.empty": "No steps recorded yet",
    "headline.bottleneck": "Work pools most between {from} and {to}",
    "headline.moving": "Work is moving with no clear bottleneck",
    none: "Nothing has moved through this process yet.",
    "none.body": "The map draws itself from recorded steps — as soon as a case, claim or quote changes state, its path appears here.",
  },
  ar: {
    title: "خريطة العملية",
    intro: `مسار سير العمل الفعلي عبر آخر ${WINDOW} خطوة مسجّلة، ومواضع تراكمه.`,
    "headline.empty": "لا توجد خطوات مسجّلة بعد",
    "headline.bottleneck": "يتراكم العمل أكثر بين {from} و{to}",
    "headline.moving": "العمل يتحرك دون عائق واضح",
    none: "لم يمر أي عمل عبر هذه العملية بعد.",
    "none.body": "تُرسم الخريطة من الخطوات المسجّلة — بمجرد أن تغيّر حالة قضية أو مطالبة أو عرض سعر، يظهر مسارها هنا.",
  },
};

export const labelsIn = labelsFrom(LABELS);

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const may = me.permissions.includes(PERM.read);
  const page = may
    ? await safe(
        () =>
          api<Page<EventRow>>(
            `/v1/axis/process-events?sort=ts&order=asc&limit=${WINDOW}`,
            { env, request },
          ),
        null,
      )
    : null;
  return { may, flow: flowFrom(rowsOf(page)) };
}

/* --------------------------------------------------------------- component */

const WIDTH = 880;

export default function AxisProcessMap() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useAxisSessionData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);
  const height = flowHeight(loaded.flow);
  const laid = layoutFlow(loaded.flow, WIDTH, height);
  // Denied means no data was even fetched, so the headline stays static —
  // headlineFor's "no steps" reading would misreport a permission gap as an
  // empty process.
  const headline = loaded.may ? headlineFor(loaded.flow, l) : l("title");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{headline}</h1>
        <p className="max-w-prose font-ui text-13 text-subtle">{l("intro")}</p>
      </header>

      {!loaded.may ? (
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      ) : laid.nodes.length === 0 ? (
        <EmptyState title={l("none")} body={l("none.body")} />
      ) : (
        // The diagram is the screen, so it gets the screen's container rather
        // than floating on the page background like a debug render.
        <Panel>
          <svg
            viewBox={`0 0 ${WIDTH} ${height}`}
            role="img"
            aria-label={l("title")}
            className="h-auto w-full"
          >
            {laid.links.map((link, i) => (
              <path
                key={i}
                d={link.path}
                fill="none"
                stroke="var(--accent)"
                strokeOpacity={0.35}
                strokeWidth={link.width}
              >
                <title>
                  {`${tag(l, "step", link.from)} ${arrowFor(locale)} ${tag(l, "step", link.to)}: ${link.count} (avg ${Math.round(link.avgMs)}ms)`}
                </title>
              </path>
            ))}
            {laid.nodes.map((node) => (
              <g key={node.step}>
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={NODE_HEIGHT}
                  rx={3}
                  fill="var(--accent)"
                />
                <text
                  x={node.x + node.width + 8}
                  y={node.y + NODE_HEIGHT / 2}
                  dominantBaseline="middle"
                  className="fill-text font-ui text-12"
                >
                  {`${tag(l, "step", node.step)} (${node.total})`}
                </text>
              </g>
            ))}
          </svg>
        </Panel>
      )}
    </div>
  );
}
