import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ASK_INPUT, NothingProposed, labelsIn } from "./command-center";

// Role adoption: the demo seat's command center led with an empty "Waiting
// for a decision" panel whose only advice was that proposals "appear here when
// a run wants to change something" — true, and nothing to do about it. A
// proposal comes from a run, and a run starts at the ask box, so the empty
// feed's one action takes the reader there.

describe("an empty proposal feed", () => {
  for (const locale of ["en", "ar"]) {
    it(`points at the ask box (${locale})`, () => {
      const t = labelsIn(locale);
      const html = renderToStaticMarkup(createElement(NothingProposed, { t }));
      expect(html).toContain(`href="#${ASK_INPUT}"`);
      expect(t("feed.ask")).not.toBe("feed.ask");
      expect(html).toContain(t("feed.ask"));
      expect(html).toContain(t("feed.empty.body"));
    });
  }
});
