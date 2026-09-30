import type { BENCH } from "./bench.js";
import type { Client } from "./lib.js";
import type { Seat } from "./month.js";

export interface FlowContext {
  base: string;
  anon: Client;
  people: Seat[];
  admin: Seat;
  bench: typeof BENCH;
}

/**
 * The business month, one virtual day at a time. setup() runs once before day
 * 1, day() per simulated day after the nightly tick, close() after the last
 * day, invariants() at the end to prove the books and counts still agree.
 */
export function flows(_ctx: FlowContext) {
  return {
    async setup(): Promise<void> {},
    async day(_n: number): Promise<void> {},
    async close(): Promise<void> {},
    async invariants(): Promise<void> {}
  };
}
