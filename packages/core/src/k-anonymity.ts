// docs/modules/scout.md §2.5 — an aggregate cell that describes fewer than
// its floor's worth of underlying records can name the one counterparty
// behind it (a panel-bench row is a provider x line x period cut, so a thin
// one is one provider), so it must never leave the server: suppress it
// instead of returning it half-anonymous.

import type { PolicyJson } from "@lyra/db";
import { moduleSettings } from "./module-config.js";

/** Default floor for a SCOUT aggregate with no product-specific `aggregationMin`. */
export const DEFAULT_K_FLOOR = 20;

export interface KAnonymityResult {
  readonly allowed: boolean;
  readonly cellCount: number;
  readonly floor: number;
}

/** A cell of exactly `floor` records is the smallest one still allowed through. */
export function checkKAnonymity(cellCount: number, floor: number): KAnonymityResult {
  return { allowed: cellCount >= floor, cellCount, floor };
}

/**
 * docs/27 P2: `DEFAULT_K_FLOOR` was a plain constant with no per-tenant dial —
 * every caller enforced the same floor regardless of that tenant's own panel
 * size or risk appetite. Read through the same seam every other per-module
 * knob goes through (`moduleSettings`, packages/core/src/module-config.ts),
 * under `moduleConfig.<module>.settings.kAnonymityFloor` — an operator changes
 * it with the existing `PATCH /v1/modules/:module/config` endpoint, no new
 * route required.
 *
 * A value that is not a positive integer is ignored rather than applied: this
 * is a privacy floor, and a malformed entry in a free-form settings blob must
 * fail toward *more* suppression (the default), never toward none.
 */
export function kAnonymityFloor(policy: PolicyJson, module: string): number {
  const raw = moduleSettings(policy, module).settings["kAnonymityFloor"];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_K_FLOOR;
}
