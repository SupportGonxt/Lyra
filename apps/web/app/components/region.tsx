import { UiCalendarProvider, UiCurrencyProvider, UiTimeZoneProvider } from "@lyra/ui";
import type { SessionBootstrap } from "../session.server";

/**
 * Every regional rendering preference a tenant holds, mounted once for a whole
 * shell rather than remembered at a call site. `<DateTime>` and `<Money>` read
 * these off context; there are ~124 of them.
 *
 * It exists as one component because the caller-by-caller version was already
 * wrong: `UiCalendarProvider` was mounted in workspace.tsx alone, so a tenant
 * on `islamic-umalqura` read Hijri dates in the classic workspace and Gregorian
 * ones in all five module shells — AXIS, ORBIT, SIGNAL, SCOUT and NORTH. Six
 * shells, one provider. Adding a seventh regional provider is now an edit here,
 * not six edits someone finds later.
 *
 * `timeZone` is deliberately allowed through as `undefined`: an unconfigured
 * tenant keeps `UiTimeZoneProvider`'s own behaviour, which is UTC on the server
 * and first client pass, then the reader's zone once mounted. A configured zone
 * is a fixed string on both passes, so it cannot mismatch on hydration.
 */
export function SessionRegion({
  session,
  children
}: {
  session: Pick<SessionBootstrap, "calendar" | "currency" | "timezone">;
  children: React.ReactNode;
}) {
  return (
    <UiCalendarProvider calendar={session.calendar}>
      {/* The tenant's functional currency, so a spec-driven money input knows what it
          is editing. `session.server.ts` resolves it from `me.policy.currency` and
          falls back to `FALLBACK_CURRENCY` (ADR-0121's launch market), so this is a
          decision already recorded rather than a default chosen here. */}
      <UiCurrencyProvider currency={session.currency}>
        <UiTimeZoneProvider timeZone={session.timezone}>{children}</UiTimeZoneProvider>
      </UiCurrencyProvider>
    </UiCalendarProvider>
  );
}
