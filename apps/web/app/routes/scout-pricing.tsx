import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Badge, Card, EmptyState, GuardrailNotice, Table, type Column } from "@lyra/ui";
import { api, names } from "../api.server";
import { cloudflare } from "../context";
import { who } from "../names";
import { useScoutSessionData } from "./scout-shell";
import {
  K_FLOOR,
  emptyPage,
  indexText,
  inPeriod,
  labelsIn,
  latestPeriod,
  losses,
  positionOf,
  rollByLine,
  safe,
  type Label,
  type LineBench,
  type Loss,
  type Page,
  type PanelRow
} from "./scout.shared";

// The same bench as the panel view, cut the other way. The panel answers "who
// are we up against"; this answers "which of our lines is priced wrong", which
// is the question an underwriting meeting actually opens with.
//
// The index is our quoted price over the median of the panel's replies to the
// same request (packages/core/src/seed/scout.ts writes it in basis points). It
// is not a market survey — nobody here sees a competitor's rate card — so the
// note under the table says so rather than letting the number imply it.
//
// "Where we lose" is per provider × line, not rolled up: a line that averages at
// market can still be losing every request against one counterparty, and the
// average is what hides it.

const LIMIT = 200;

/** The one sentence the bench opens with — line count and loss count already
 *  on the loader, no ✦ (arithmetic, not an agent's finding, CLAUDE.md §11). */
export function priceHeadline(lines: LineBench[], lost: Loss[], l: Label): string {
  if (lines.length === 0) return l("price.title");
  if (lost.length > 0) return l("price.headlineLosses", { n: String(lost.length), lines: String(lines.length) });
  return l("price.headlineCount", { n: String(lines.length) });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const bench = await safe(
    () => api<Page<PanelRow>>(`/v1/scout/panel-bench?sort=period&order=desc&limit=${LIMIT}`, { env, request }),
    emptyPage<PanelRow>()
  );

  // docs/27 P2 K_FLOOR follow-up: the resolved tenant value, not the compiled
  // default — falls back to it on a permission or network failure, same as
  // every other best-effort read on this loader.
  const kFloor = await safe(
    () => api<{ kFloor: number }>("/v1/scout/config", { env, request }).then((r) => r.kFloor),
    K_FLOOR
  );

  const period = latestPeriod(bench.data);
  const rows = inPeriod(bench.data, period);
  const lost = losses(rows);
  // A loss row carries a provider id and nothing a person could read (ADR-0048).
  const resolved = await names(
    lost.map((loss) => loss.providerId),
    { env, request }
  );

  return { period, lines: rollByLine(rows), losses: lost, resolved, kFloor };
}

export default function ScoutPricing() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useScoutSessionData();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-22 leading-[1.2] text-text">
            {priceHeadline(loaded.lines, loaded.losses, l)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("price.lede", { period: loaded.period ?? l("none") })}</p>
        </div>
      </header>

      <Card title={l("price.byLine")} description={l("price.note")}>
        {loaded.lines.length === 0 ? (
          <EmptyState title={l("price.empty")} body={l("price.empty.body")} className="mt-4" />
        ) : (
          <Table
            className="mt-4"
            caption={l("price.byLine")}
            captionHidden
            rowKey={(row) => row.line}
            rows={loaded.lines}
            columns={lineColumns(l, locale)}
          />
        )}
      </Card>

      <Card title={l("price.losing")}>
        {loaded.losses.length === 0 ? (
          <EmptyState title={l("price.allBelow")} body={l("price.allBelow.body")} className="mt-4" />
        ) : (
          <Table
            className="mt-4"
            caption={l("price.losing")}
            captionHidden
            rowKey={(loss) => `${loss.providerId}:${loss.line}`}
            rows={loaded.losses}
            columns={lossColumns(l, locale, loaded.resolved)}
          />
        )}
      </Card>

      <GuardrailNotice tone="info" title={l("kFloor")} reason={l("kFloorWhy", { k: String(loaded.kFloor) })} />

      <footer className="flex flex-wrap gap-4">
        <Link to="/scout/panel" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("panel.title")}
        </Link>
        <Link to="/scout/analytics" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("an.title")}
        </Link>
      </footer>
    </div>
  );
}

/** Percent above or below the median, said in words rather than a signed number:
 *  "3% above" cannot be misread the way "+3%" can. */
function distance(l: Label, locale: string, pct: number | null): string {
  if (pct === null) return l("none");
  const rounded = Math.abs(pct).toLocaleString(locale, { maximumFractionDigits: 1 });
  return pct >= 0 ? l("price.above", { pct: rounded }) : l("price.below", { pct: rounded });
}

export function lineColumns(l: Label, locale: string): Array<Column<LineBench>> {
  return [
    { key: "line", header: l("line"), render: (row) => row.line },
    { key: "volume", header: l("volume"), numeric: true, render: (row) => row.volume.toLocaleString(locale) },
    {
      key: "index",
      header: l("priceIndex"),
      numeric: true,
      render: (row) => indexText(row.ourIdx, locale) ?? l("none")
    },
    {
      key: "marketIndex",
      header: l("marketIndex"),
      numeric: true,
      render: (row) => indexText(row.marketIdx, locale) ?? l("none")
    },
    {
      key: "position",
      header: l("position"),
      render: (row) => {
        const tone = positionOf(row.pct);
        return (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={tone.tone === "neutral" ? "neutral" : tone.tone} size="sm">
              {l(tone.key)}
            </Badge>
            <span className="font-ui text-12 text-subtle">{distance(l, locale, row.pct)}</span>
          </span>
        );
      }
    }
  ];
}

export function lossColumns(
  l: Label,
  locale: string,
  resolved: Record<string, string> = {}
): Array<Column<Loss>> {
  return [
    { key: "providerId", header: l("insurer"), render: (loss) => who(loss.providerId, resolved) },
    { key: "line", header: l("line"), render: (loss) => loss.line },
    { key: "volume", header: l("volume"), numeric: true, render: (loss) => loss.volume.toLocaleString(locale) },
    {
      key: "pct",
      header: l("position"),
      render: (loss) => <span className="text-danger">{distance(l, locale, loss.pct)}</span>
    }
  ];
}
