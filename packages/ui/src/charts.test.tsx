import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DonutChart, LineChart, Sparkline } from "./data.js";

// The two shapes a dashboard tile needs that a sparkline cannot make: a series
// with a scale a reader can name, and a share of a whole (docs/ui.md §7 P3-12,
// ADR-0053). Both are SVG in this package — the arithmetic is ours, so it is
// tested here rather than trusted to a library.

describe("LineChart", () => {
  it("puts the high and the low on the scale, formatted", () => {
    const markup = renderToStaticMarkup(
      <LineChart values={[10, 40, 25]} label="Premium by month" format={(v) => `R${v}`} />
    );
    expect(markup).toContain("R40");
    // The floor is zero, not the smallest value: a series that runs 10 to 40 is
    // a third taller than it looks if the axis starts at 10.
    expect(markup).toContain("R0");
    expect(markup).toContain('aria-label="Premium by month"');
  });

  // The mark NORTH needs: a definition change, drawn *from the change date*. It
  // is an index into the series rather than a date, so the mark travels with the
  // data instead of needing the chart to parse a calendar.
  it("marks an event at its point, and names it in the alternative", () => {
    const markup = renderToStaticMarkup(
      <LineChart
        values={[10, 20, 30, 40]}
        label="Policies issued"
        xLabels={["2026-01", "2026-02", "2026-03", "2026-04"]}
        annotations={[{ index: 2, label: "Definition changed" }]}
      />
    );
    // The mark sits at the same x the third point does: 2/3 of the width.
    expect(markup).toContain('x1="66.67"');
    // A screen reader gets the event, its date and its label — the plot itself
    // cannot be read aloud.
    expect(markup).toContain("Marked: 2026-03 — Definition changed");
    // And a sighted reader gets a key, not an unexplained line.
    expect(markup).toContain("Definition changed");
  });

  it("draws no mark at all when there is nothing to mark", () => {
    const markup = renderToStaticMarkup(<LineChart values={[1, 2, 3]} label="Series" />);
    expect(markup).not.toContain("Marked:");
    expect(markup).not.toContain("stroke-dasharray");
  });

  it("drops an out-of-range mark rather than clamping it onto a real point", () => {
    // A mark on the wrong point is worse than no mark: it is read as evidence.
    const markup = renderToStaticMarkup(
      <LineChart values={[1, 2, 3]} label="Series" xLabels={["a", "b", "c"]} annotations={[{ index: 9, label: "Ghost" }]} />
    );
    expect(markup).not.toContain("Ghost");
    expect(markup).not.toContain("Marked:");
  });

  it("plots the series across the full width, top for the highest", () => {
    const markup = renderToStaticMarkup(<LineChart values={[0, 100]} label="Two points" />);
    expect(markup).toContain('points="0.00,40.00 100.00,0.00"');
  });

  // A dash pattern on a non-scaling stroke is measured in screen pixels, not in
  // `pathLength` units, so the "draw" dash chopped every line into segments.
  it("draws one continuous line, never a dash pattern", () => {
    const markup = renderToStaticMarkup(<LineChart values={[1, 3, 2, 5]} label="Series" />);
    expect(markup).not.toContain("stroke-dasharray");
  });

  it("holds a single reading in the middle rather than at the edge", () => {
    const markup = renderToStaticMarkup(<LineChart values={[7]} label="One point" />);
    expect(markup).toContain('points="50.00,');
  });
});

describe("DonutChart", () => {
  it("gives each slice its share of the ring and says the percentage", () => {
    const markup = renderToStaticMarkup(
      <DonutChart
        label="Claims by state"
        slices={[
          { name: "Open", value: 30 },
          { name: "Settled", value: 10 }
        ]}
      />
    );
    // Circumference is 100 units, so a dash length is a percentage outright.
    expect(markup).toContain('stroke-dasharray="75.00 25.00"');
    expect(markup).toContain('stroke-dasharray="25.00 75.00"');
    // The second slice starts where the first ended.
    expect(markup).toContain('stroke-dashoffset="-75.00"');
    expect(markup).toContain("75%");
    expect(markup).toContain("Settled");
  });

  it("draws nothing but the track when every figure is zero", () => {
    const markup = renderToStaticMarkup(
      <DonutChart label="Empty" slices={[{ name: "None", value: 0 }]} />
    );
    expect(markup).not.toContain("stroke-dasharray");
  });
});

describe("Sparkline", () => {
  it("draws one continuous line, never a dash pattern", () => {
    const markup = renderToStaticMarkup(<Sparkline values={[1, 3, 2]} label="Trend" />);
    expect(markup).not.toContain("stroke-dasharray");
  });
});
