import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { makeLibsqlDb } from "@lyra/db/libsql";
import type { CoreDb } from "@lyra/core";
import { dayKey } from "@lyra/core";
import { resyncSystemRolePermissions } from "@lyra/core/seed";
import { approvals, distNextBestOffers, northBriefings, signalBudgetMoves, tenants, users } from "@lyra/db/schema";
import { and, eq, like } from "drizzle-orm";
import { API_ORIGIN, DB_PATH, FILES_DIR, LIBSQL_URL } from "./env.js";

// NOT wired as Playwright's `globalSetup` — in playwright@1.62 the runner's
// own task order is [removeOutputDirs, ...pluginSetup (this is where webServer
// actually spawns), ...globalTeardowns, ...globalSetups], i.e. webServer always
// starts BEFORE globalSetup runs. So this file is invoked directly, ahead of
// `playwright test`, by the `e2e` pnpm script instead (see package.json).
//
// Skips the wipe when the DB already exists: webServer's reuseExistingServer
// (on outside CI) keeps a prior run's API process alive with the file open,
// so deleting+recreating it here yanks the inode out from under that live
// connection and every write fails SQLITE_READONLY_DBMOVED. Reuse the file
// along with the reused server; `rm -rf` the tmp dir for a genuinely fresh run.
export default async function globalSetup(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  mkdirSync(FILES_DIR, { recursive: true });
  writeFileSync(resolve(root, "apps/web/.dev.vars"), `API_ORIGIN=${API_ORIGIN}\n`);

  const dbEnv = { ...process.env, LIBSQL_URL, DATABASE_URL: LIBSQL_URL };
  if (existsSync(DB_PATH)) {
    // A reused file still takes the tree's migrations: they are forward-only
    // and in place, so the live connection above survives them, and a DB left
    // by an older checkout otherwise lacks every newer column — the month
    // simulation's UI sweep met /axis/bordereaux answering 500 on
    // `no such column: tolerance_minor` from a file three days old.
    execFileSync("pnpm", ["--filter", "@lyra/db", "migrate"], { cwd: root, env: dbEnv, stdio: "inherit" });
    // login.spec.ts's password-sign-in test enrols amina.saleh's TOTP from
    // scratch every run (login.tsx only shows the enrolment screen while
    // mfaEnrolled is false) and re-seeding is skipped above, so without this
    // her enrolment from a prior local run persists and the second run hits
    // the "enter your code" challenge instead — a screen the test has no
    // secret to answer. Reset her MFA state so re-running locally without a
    // full wipe stays reproducible.
    const db = makeLibsqlDb(LIBSQL_URL);
    await db
      .update(users)
      .set({ mfaEnrolled: false, mfaSecret: null, mfaRecoveryJson: null })
      .where(eq(users.email, "amina.saleh@gonxt.ae"));

    // signal-budget.spec.ts reverses this seeded move and self-approves the
    // gate (signal.budget_move, dualControl "never"). approvals.ts's gate()
    // bypasses a fresh request silently while a prior approved decision is
    // still within APPROVAL_TTL_MS (24h), so a rerun on the same reused DB
    // skips the refusal step the test asserts on. Reset both sides so the
    // spec is reproducible without a full wipe, same idiom as the MFA reset.
    const move = await db
      .select({ id: signalBudgetMoves.id })
      .from(signalBudgetMoves)
      .where(like(signalBudgetMoves.reason, "Bing's cost per policy%"));
    if (move[0]) {
      await db
        .update(signalBudgetMoves)
        .set({ reversedBy: null, reversedAt: null })
        .where(eq(signalBudgetMoves.id, move[0].id));
      await db
        .delete(approvals)
        .where(
          and(
            eq(approvals.subjectRef, `budget-moves:${move[0].id}`),
            eq(approvals.policyKey, "signal.budget_move")
          )
        );
    }

    // orbit-journeys.spec.ts's J-C3 surfaces a next-best-offer as axis.lead.
    // Surfacing is one-way — dist-offers.tsx only renders the button for an
    // offer still `proposed` — so on a reused DB the second run finds every
    // offer already surfaced and no button to press. Put them back, same
    // idiom as the two resets above.
    await db
      .update(distNextBestOffers)
      .set({ state: "proposed", surfacedAt: null })
      .where(eq(distNextBestOffers.state, "surfaced"));

    // north.spec.ts's J-E1 pins the seeded "yesterday" exec briefing by a
    // freshly computed dayKey(Date.now(), -1); seed.ts stamped `date` with
    // dayKey(seed-time now, -1), so a reused DB run on a later calendar day
    // no longer has a row for "yesterday". The published exec briefing with
    // the latest `date` is always that seeded row (seed.ts's other exec
    // briefing sits two days further back, and "today" is deliberately left
    // unseeded for J-E1 to generate) — re-stamp it forward, same idiom as
    // the resets above.
    const publishedExec = await db
      .select({ date: northBriefings.date })
      .from(northBriefings)
      .where(and(eq(northBriefings.audience, "exec"), eq(northBriefings.status, "published")));
    if (publishedExec.length) {
      const latestDate = publishedExec.map((r) => r.date).sort().at(-1)!;
      const freshYesterday = dayKey(Date.now(), -1);
      if (latestDate !== freshYesterday) {
        await db
          .update(northBriefings)
          .set({ date: freshYesterday })
          .where(and(eq(northBriefings.date, latestDate), eq(northBriefings.audience, "exec")));
      }
    }

    // core_roles.permissions_json is a snapshot taken at seed time, so a
    // permission added to a role in rbac.ts (e.g. ADR-0054) never reaches a
    // reused DB and the spec that demands it fails against stale grants.
    // Every seeded role here is a system role, compiled from rbac.ts — so
    // resyncing them is restoring the source of truth, not overriding an
    // operator's narrowing.
    const seeded = await db.select({ id: tenants.id }).from(tenants);
    for (const tenant of seeded) {
      await resyncSystemRolePermissions(db as unknown as CoreDb, tenant.id);
    }
    return;
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  execFileSync("pnpm", ["--filter", "@lyra/db", "migrate"], { cwd: root, env: dbEnv, stdio: "inherit" });
  execFileSync("pnpm", ["--filter", "@lyra/core", "seed"], { cwd: root, env: dbEnv, stdio: "inherit" });
}

await globalSetup();
