import { Form, Link } from "react-router";
import { AGENT_MARK, Button, GuardrailNotice } from "@lyra/ui";
import { PERM, type Label } from "../routes/scout.shared";

// Handing a whitespace to the campaign studio is consequential (CLAUDE.md §4):
// it creates a campaign and has the model write its content. So the button says
// what it does and no more, the API may answer "queued for approval" instead of
// "done", and the drafts land in a tray to be read — never a modal, never sent
// (docs/15 §4 pattern 3).

/** What the handover answers with. Contract in ./whitespace-api.server.ts. */
export interface PromotedToSignal {
  /** "committed" once it is through; anything else is still waiting. */
  state: string;
  campaignId: string | null;
  drafts: number;
}

/**
 * `may` false renders the reason instead of a button nobody can press: a
 * disabled control is unfocusable, so its explanation would never be announced
 * (docs/22 §5.4).
 */
export function PromoteToSignal({
  whitespaceId,
  formKey,
  may,
  busy,
  l
}: {
  whitespaceId: string;
  formKey: string;
  may: boolean;
  busy: boolean;
  l: Label;
}) {
  if (!may) {
    return (
      <GuardrailNotice
        tone="info"
        title={l("wc.convert")}
        reason={l("wc.convertDenied", { perm: PERM.whitespacesPromote })}
      />
    );
  }
  return (
    <Form method="post" className="flex flex-col gap-2 border-t border-line pt-3">
      <input type="hidden" name="intent" value="promote-signal" />
      {/* One key per load, so a double click is one campaign. */}
      <input type="hidden" name="key" value={formKey} />
      <input type="hidden" name="whitespaceId" value={whitespaceId} />
      <Button type="submit" variant="secondary" disabled={busy}>
        {l("wc.convert")}
      </Button>
      <span className="font-ui text-12 text-subtle">{l("wc.convertHint")}</span>
    </Form>
  );
}

/** The drafts the model wrote, as a tray to open — not a thing that happened. */
export function DraftTray({
  promoted,
  mayOpen,
  l,
  locale
}: {
  promoted: PromotedToSignal;
  mayOpen: boolean;
  l: Label;
  locale: string;
}) {
  const queued = promoted.state !== "committed";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-2 p-3 font-ui text-13"
    >
      <span aria-hidden="true" className="text-accent">
        {AGENT_MARK}
      </span>
      <span className="eyebrow">{l("wc.drafts")}</span>
      <p className={queued ? "text-muted" : "text-success"}>
        {queued
          ? l("wc.queued")
          : promoted.drafts > 0
            ? l("wc.drafted", { n: promoted.drafts.toLocaleString(locale) })
            : l("wc.draftedNone")}
      </p>
      {!queued && promoted.campaignId !== null && mayOpen ? (
        <Link
          to={`/signal/studio?campaignId=${encodeURIComponent(promoted.campaignId)}`}
          className="text-accent underline underline-offset-2"
        >
          {l("wc.inspect")}
        </Link>
      ) : null}
    </div>
  );
}
