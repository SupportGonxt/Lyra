import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_BLOCK_MAX,
  KNOWLEDGE_PACKS,
  knowledgeBlock,
  knowledgeFacts,
  knowledgePack
} from "./knowledge.js";
import { DEFAULT_PACK } from "./vocabulary.js";

// CLAUDE.md rule 14 / docs/21 §3, the knowledge half. Two properties matter more
// than the words themselves: every fact says where it came from and when it was
// true, and the block a prompt carries is bounded and deterministic — an eval
// that cannot be diffed is not an eval.

describe("the knowledge pack", () => {
  it("gives every fact a source and a date", () => {
    for (const pack of KNOWLEDGE_PACKS.values()) {
      for (const fact of pack.facts) {
        expect(fact.source, fact.key).toBeTruthy();
        expect(fact.asOf, fact.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(fact.statement.length, fact.key).toBeGreaterThan(20);
        expect(fact.key, fact.key).toMatch(/^(market|product|money|compliance|method|metric)\./);
      }
    }
  });

  it("uses unique keys, because a caller selects by key", () => {
    for (const pack of KNOWLEDGE_PACKS.values()) {
      const keys = pack.facts.map((f) => f.key);
      expect(new Set(keys).size, pack.key).toBe(keys.length);
    }
  });

  it("degrades an unknown pack to the default rather than to nothing", () => {
    // A prompt with no world in it writes generic copy, and generic is the failure.
    expect(knowledgePack("something-unregistered").key).toBe(DEFAULT_PACK);
    expect(knowledgePack(undefined).key).toBe(DEFAULT_PACK);
    expect(knowledgeFacts("something-unregistered").length).toBeGreaterThan(0);
  });

  it("carries the market rates only where the market applies", () => {
    const saudi = knowledgeFacts("insurance-gulf", { markets: ["SA"] }).map((f) => f.key);
    expect(saudi).toContain("market.ksa.vat");
    expect(saudi).not.toContain("market.uae.vat");
    // A fact scoped to nowhere is always in scope.
    expect(saudi).toContain("compliance.quiet-hours");
  });

  it("narrows by kind", () => {
    const compliance = knowledgeFacts("insurance-gulf", { kinds: ["compliance"] });
    expect(compliance.length).toBeGreaterThan(4);
    expect(compliance.every((f) => f.kind === "compliance")).toBe(true);
  });

  it("states the launch market and the sequence", () => {
    const statements = knowledgeFacts("insurance-gulf", { markets: ["AE"] }).map((f) => f.statement).join(" ");
    expect(statements).toContain("CBUAE");
    expect(statements).toContain("5%");
  });

  it("never asserts a rate it cannot point at", () => {
    // The Egyptian table levy is the one rate this platform seeds but does not
    // claim: the fact has to say whose call it is.
    const [levy] = knowledgeFacts("insurance-gulf").filter((f) => f.key === "market.egypt.vat");
    expect(levy!.statement).toContain("the tenant's to confirm");
  });

  it("does not put a market's rates in the default pack", () => {
    const generic = knowledgeFacts(DEFAULT_PACK).map((f) => f.key);
    expect(generic).toContain("compliance.quiet-hours");
    expect(generic).not.toContain("market.ksa.vat");
  });
});

describe("knowledgeBlock", () => {
  it("is bounded, and says what it is", () => {
    const block = knowledgeBlock("insurance-gulf");
    const lines = block.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(KNOWLEDGE_BLOCK_MAX);
    expect(block).toContain("pack insurance-gulf");
    // The line that keeps knowledge out of the evidence set.
    expect(block).toContain("not this call's data");
  });

  it("is deterministic, so an eval can be diffed", () => {
    expect(knowledgeBlock("insurance-gulf", { markets: ["AE"] })).toBe(
      knowledgeBlock("insurance-gulf", { markets: ["AE"] })
    );
  });

  it("renders nothing at all when nothing is in scope", () => {
    expect(knowledgeBlock("insurance-gulf", { kinds: [] })).toBe("");
  });

  it("honours a caller's own cap", () => {
    const block = knowledgeBlock("insurance-gulf", { max: 3 });
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });
});
