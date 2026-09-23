import { isRouteErrorResponse } from "react-router";

// What happened → what we did → what you can do, with a copyable reference
// (docs/07 §5). No stack traces: they are in the logs, keyed by that reference.
//
// One panel, two homes: the root boundary renders it on a bare page (nothing
// has loaded, so there is no shell to render it in), and the workspace boundary
// renders it inside the shell (docs/15: a screen that fails is still a screen —
// losing the rail and the header on a mistyped URL reads as a crash).

/** Which sentence explains this error. Exported for the test and the boundaries. */
export function messageKeyFor(error: unknown): string {
  if (!isRouteErrorResponse(error)) return "error.generic";
  if (error.status === 404) return "error.notFound";
  if (error.status === 403) return "error.forbidden";
  if (error.status === 401) return "error.unauthorized";
  return "error.generic";
}

/**
 * Which headline this error deserves. "This did not load" is untrue of a
 * refusal — nothing failed; the door is simply not theirs — and untrue of an
 * address that never held anything.
 */
export function titleKeyFor(error: unknown): string {
  if (!isRouteErrorResponse(error)) return "error.title";
  if (error.status === 404) return "error.notFoundTitle";
  if (error.status === 403) return "error.forbiddenTitle";
  return "error.title";
}

/**
 * The support reference. `throw data(requestId, { status })` in a loader puts
 * the id in `error.data`, which is what the API logged the failure under.
 */
export function requestIdFor(error: unknown): string | null {
  if (!isRouteErrorResponse(error) || typeof error.data !== "string") return null;
  // An id carries a digit and no spaces. A dozen loaders throw a noun here
  // (`data("workspace", …)`), which support cannot trace.
  return /^[\w-]{6,}$/.test(error.data) && /\d/.test(error.data) ? error.data : null;
}

/**
 * True when retrying is the wrong offer. 403 and 404 are not transient — the
 * roles will not change on a reload, and there is still nothing at the address.
 * Sending someone back to work beats a button that reproduces the same page.
 */
export function isPermanent(error: unknown): boolean {
  return isRouteErrorResponse(error) && (error.status === 403 || error.status === 404);
}

export function ErrorPanel({
  error,
  t,
  className = ""
}: {
  error: unknown;
  t: (key: string, vars?: Record<string, string>) => string;
  className?: string;
}) {
  const requestId = requestIdFor(error);
  const permanent = isPermanent(error);

  return (
    <div className={`lyra-enter flex max-w-prose flex-col gap-4 ${className}`}>
      <h1 className="font-display text-28 text-tx0">{t(titleKeyFor(error))}</h1>
      <p className="text-14 leading-body text-tx4">{t(messageKeyFor(error))}</p>
      {requestId ? (
        <p className="font-mono text-12 text-muted" dir="ltr">
          {t("error.requestId", { id: requestId })}
        </p>
      ) : null}
      <p>
        {/* A plain anchor on purpose: the boundary may be rendering because the
            router itself could not build the tree, and a client navigation
            would land right back in it. */}
        <a
          className="text-accent underline underline-offset-4"
          href={permanent ? "/" : typeof location === "undefined" ? "/" : location.pathname}
        >
          {t(permanent ? "error.home" : "error.retry")}
        </a>
      </p>
    </div>
  );
}
