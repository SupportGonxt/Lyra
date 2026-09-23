// The one place this app talks to apps/api. Mobile has no cookie jar worth
// trusting, so it authenticates with `Authorization: Bearer <session token>` —
// the same opaque session token /v1/auth/login returns to the web shell in its
// Set-Cookie. apps/api accepts either (apps/api/src/auth.ts).

/** Base URL of apps/api. Public config, never a secret — see README. */
export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ?? "https://api.lyra.vantax.co.za";

/** RFC 9457, the shape apps/api renders every failure in (docs/04 §1). */
export interface Problem {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly problem: Problem,
    /** `x-request-id` from the response — the one thing support needs. */
    readonly requestId: string | null
  ) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
  }

  get status(): number {
    return this.problem.status;
  }
}

/** A dropped connection is not a 500; it needs its own message and a retry. */
export class NetworkError extends Error {
  readonly name = "NetworkError";
}

export interface RequestOptions {
  token?: string | null;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON unless it is a FormData, which goes over the wire as multipart. */
  body?: unknown;
  signal?: AbortSignal;
}

/** A hung connection must become a NetworkError, not a spinner that never
 *  stops. ponytail: one flat deadline to the response headers; per-endpoint
 *  budgets when an endpoint earns one. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * True when a 401 means "this session is dead". The /v1/auth routes answer 401
 * for a wrong password or code, which is a form error, not a sign-out.
 */
export function endsSession(path: string, status: number): boolean {
  return status === 401 && !path.startsWith("/v1/auth/");
}

// Registered once by SessionProvider: a dead session must land every screen on
// sign-in, instead of each screen offering a Retry that re-sends a dead token.
let onSessionEnd: (() => void) | null = null;
export function setOnSessionEnd(handler: (() => void) | null): void {
  onSessionEnd = handler;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, method = "GET", body, signal } = options;
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // A FormData carries its own multipart boundary; naming a content-type here
  // would produce a body the server cannot parse.
  const multipart = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !multipart) headers["content-type"] = "application/json";

  // Manual timeout rather than AbortSignal.timeout/any: boring, and it works
  // on Hermes as well as in Node. The caller's own signal is followed too.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const follow = () => controller.abort();
  if (signal?.aborted) follow();
  signal?.addEventListener("abort", follow, { once: true });

  let response: Response;
  try {
    response = await fetch(new URL(path, API_BASE).toString(), {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: multipart ? (body as FormData) : JSON.stringify(body) }),
      signal: controller.signal
    });
  } catch (cause) {
    // fetch only rejects for transport failures; anything else is a status.
    throw new NetworkError(cause instanceof Error ? cause.message : "request failed");
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", follow);
  }

  if (!response.ok) {
    const problem = await problemFrom(response, path);
    if (endsSession(path, response.status)) onSessionEnd?.();
    throw problem;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function problemFrom(response: Response, path: string): Promise<ApiError> {
  let problem: Problem = { title: response.statusText || "error", status: response.status };
  try {
    const parsed: unknown = await response.json();
    // Trust the shape only far enough to read it: a proxy error page is HTML
    // behind a JSON content type often enough to matter.
    if (parsed && typeof parsed === "object" && "status" in parsed) {
      const p = parsed as Problem;
      problem = { ...p, status: Number(p.status) || response.status };
    }
  } catch {
    /* keep the status-derived problem */
  }
  problem.instance ??= path;
  return new ApiError(problem, response.headers.get("x-request-id"));
}

/* ------------------------------------------------------------------ shapes */

export interface LoginResponse {
  token: string;
  expiresAt: number;
  mfaRequired: boolean;
  /** Which second-factor screen to draw. Absent when there is nothing to clear. */
  mfaStep?: MfaStep;
  user: { id: string; name: string; email: string; locale: string; tenantId: string };
  roles: string[];
}

export type MfaStep = "verify" | "enrol";

/** Enrolment returns the shared secret exactly once (apps/api/src/auth.ts). */
export interface Enrolment {
  secret: string;
  otpauthUri: string;
}

export interface NavItem {
  /** i18n key — the API never sends display text (docs/07 §2). */
  labelKey: string;
  href: string;
  icon: string;
  children?: NavItem[];
}

/** The whitelabel contract, docs/01 §6. All optional: a tenant that overrides
 *  nothing gets the default Deep Field skin. */
export interface Brand {
  name?: string;
  logo?: { light?: string; dark?: string; mark?: string };
  palette?: { accent?: string; accentHover?: string; accentContrast?: string };
  /** One of BrandJson's approved typefaces (packages/db/src/json.ts). Typed as a
   *  plain string on purpose: it arrives over the wire, so it is validated at
   *  the point it becomes a style (theme.ts `fontFamilyFor`), not by this type. */
  font?: string;
}

export interface Me {
  actor: { kind: string; id: string };
  profile: { id: string; name: string; email: string; locale: string; status: string } | null;
  tenant: {
    id: string;
    slug: string;
    name: string;
    plan: string;
    region: string;
    status: string;
    brand: Brand | null;
  };
  locale: string;
  roles: string[];
  permissions: string[];
  entitlements: Record<string, unknown>;
  policy: Record<string, unknown>;
  nav: NavItem[];
}

/** Every generated CRUD list answers in this shape (apps/api/src/http.ts). */
export interface Page<T> {
  data: T[];
  /** Opaque; pass back as `?cursor=`. Absent once the last page has been read. */
  cursor?: string;
  total?: number;
}

export type Row = Record<string, unknown> & { id: string };

export const login = (
  body: { email: string; password: string; tenantSlug?: string },
  signal?: AbortSignal
): Promise<LoginResponse> =>
  request<LoginResponse>("/v1/auth/login", { method: "POST", body, ...(signal ? { signal } : {}) });

/**
 * The TOTP second factor. Accepts a TOTP code or a single-use recovery code;
 * a code that is neither is a 401, which the caller reads as "wrong code".
 */
export const verifyMfa = (
  token: string,
  code: string
): Promise<{ mfaSatisfied: true; usedRecovery: boolean }> =>
  request("/v1/auth/mfa/verify", { method: "POST", token, body: { code } });

/** Begins enrolment for a session whose role requires a factor it has not set up. */
export const startEnrolment = (token: string): Promise<Enrolment> =>
  request<Enrolment>("/v1/auth/mfa/enrol", { method: "POST", token });

/** Proves the authenticator was captured. Clears the factor on this session and
 *  returns the recovery codes — the only time they are readable. */
export const confirmEnrolment = (token: string, code: string): Promise<string[]> =>
  request<{ recoveryCodes: string[] }>("/v1/auth/mfa/enrol/confirm", {
    method: "POST",
    token,
    body: { code }
  }).then((r) => r.recoveryCodes);

/* --------------------------------------------------------- the step machine */

// The same four steps apps/web/app/routes/login.tsx walks, kept here as pure
// functions so both the screen and the session agree on where a response lands
// and so the transitions are testable without rendering anything.

export type AuthStep = "password" | "totp" | "enrol" | "recovery" | "app";

/** Where a successful /v1/auth/login puts the user. */
export function stepAfterLogin(result: Pick<LoginResponse, "mfaRequired" | "mfaStep">): AuthStep {
  if (result.mfaStep === "enrol") return "enrol";
  return result.mfaRequired ? "totp" : "app";
}

/** Where clearing the current step lands: a verified code opens the app, a
 *  confirmed enrolment owes the user their recovery codes first. */
export function stepAfterClearing(step: AuthStep): AuthStep {
  return step === "enrol" ? "recovery" : "app";
}

/**
 * The step a 403 from any authenticated call demands, or null when the failure
 * is not about the second factor. A session that exists but has not cleared MFA
 * must not read as a sign-out.
 */
export function mfaStepOf(error: unknown): AuthStep | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  const { type, title, step, detail } = error.problem as Problem & { step?: unknown };
  if (!/mfa_required/.test(type ?? title)) return null;
  const named = typeof step === "string" ? step : detail;
  return named === "enrol" ? "enrol" : "totp";
}

/**
 * Wraps the verify→load pair so a load() that fails *after* a successful
 * verify is retried without re-spending the one-time code — resubmitting a
 * consumed TOTP answers 401, which would read back as "wrong code".
 */
export function verifyThenLoad(
  verify: (code: string) => Promise<unknown>,
  load: () => Promise<unknown>
): (code: string) => Promise<void> {
  let verified = false;
  return async (code) => {
    if (!verified) {
      await verify(code);
      verified = true;
    }
    await load();
    verified = false;
  };
}

export const fetchMe = (token: string, signal?: AbortSignal): Promise<Me> =>
  request<Me>("/v1/me", { token, ...(signal ? { signal } : {}) });

export const logout = (token: string): Promise<void> =>
  request<void>("/v1/auth/logout", { method: "POST", token });

export const listRows = (
  token: string,
  resource: string,
  signal?: AbortSignal,
  /** Pass `Page.cursor` back to read past the first 50 rows. */
  cursor?: string
): Promise<Page<Row>> =>
  request<Page<Row>>(
    `/v1/${resource}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    { token, ...(signal ? { signal } : {}) }
  );

/** A sorted or filtered read of the same collection. The caller owns the query
 *  because sort keys are per-resource (`date` for briefings, `detectedAt` for
 *  anomalies); the shape of the answer is identical. */
export const queryRows = (
  token: string,
  resource: string,
  params: Record<string, string | number>,
  signal?: AbortSignal
): Promise<Page<Row>> => {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
  return request<Page<Row>>(`/v1/${resource}${query ? `?${query}` : ""}`, {
    token,
    ...(signal ? { signal } : {})
  });
};

export const getRow = (
  token: string,
  resource: string,
  id: string,
  signal?: AbortSignal
): Promise<Row> =>
  request<Row>(`/v1/${resource}/${encodeURIComponent(id)}`, {
    token,
    ...(signal ? { signal } : {})
  });

/* ------------------------------------------------------------ write calls */

// Everything above this line reads. These six are the only calls that change
// something on the server, and each is the transport half of one journey
// screen. Nothing here decides *whether* an action is allowed: the API owns
// the permission, the approval gate and the audit row (CLAUDE.md rules 3, 4).

/** One approval waiting on the signed-in user (apps/api/src/routes/me.ts). */
export interface Approval extends Row {
  id: string;
  policyKey: string;
  status: string;
  subjectRef: string;
  requestedBy: string | null;
  contextJson?: string | null;
  createdAt: number;
}

export interface Notification extends Row {
  id: string;
  kind: string;
  title: string;
  bodyText?: string | null;
  linkHref?: string | null;
  createdAt: number;
}

export interface Inbox {
  approvals: Approval[];
  notifications: Notification[];
  counts: { approvals: number; notifications: number };
}

/** The caller's work queue — the same one the web shell's inbox draws. */
export const fetchInbox = (token: string, signal?: AbortSignal): Promise<Inbox> =>
  request<Inbox>("/v1/me/inbox", { token, ...(signal ? { signal } : {}) });

/**
 * Decide one approval. A rejection with no reason is allowed by the API, so
 * the reason is omitted rather than sent empty — an empty string would land in
 * the audit row as a reason that was never given.
 */
export const decideApproval = (
  token: string,
  id: string,
  decision: "approved" | "rejected",
  reason?: string
): Promise<Row> =>
  request<Row>(`/v1/me/approvals/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    token,
    body: { decision, ...(reason ? { reason } : {}) }
  });

export const markNotificationRead = (token: string, id: string): Promise<void> =>
  request<void>(`/v1/me/notifications/${encodeURIComponent(id)}/read`, {
    method: "POST",
    token
  });

/** Asks NORTH to narrate a day. 201 with the briefing row (J-E1). */
export const generateBriefing = (
  token: string,
  input: { date: string; audience?: string; locale?: string }
): Promise<Row> =>
  request<Row>("/v1/north/briefings/generate", { method: "POST", token, body: input });

/**
 * Takes an anomaly on: the same PATCH the web's /north/anomalies "Take it on"
 * sends (apps/web/app/routes/north-anomalies.tsx `action`, intent `own`) —
 * state `action_created`, signed with the reader's name (J-E1).
 */
export const takeAnomaly = (token: string, id: string, owner: string): Promise<Row> =>
  request<Row>(`/v1/north/anomalies/${encodeURIComponent(id)}`, {
    method: "PATCH",
    token,
    body: { state: "action_created", explainedBy: owner }
  });

/** Sends a human reply out over the conversation's bound channel (ADR-0038). */
export const replyToConversation = (token: string, id: string, text: string): Promise<Row> =>
  request<Row>(`/v1/orbit/conversations/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    token,
    body: { text }
  });

/**
 * Files a captured photo or scan against an AXIS case. The camera hands back a
 * `file://` uri, which React Native's FormData uploads by reference — the app
 * never holds the bytes, so a 10MB scan does not become a 13MB base64 string
 * in memory.
 */
export const uploadDocument = (
  token: string,
  capture: { caseId: string; docType: string; uri: string; contentType: string; name?: string }
): Promise<Row> => {
  const form = new FormData();
  form.append("caseId", capture.caseId);
  form.append("docType", capture.docType);
  form.append("file", {
    uri: capture.uri,
    name: capture.name ?? capture.uri.split("/").pop() ?? "capture",
    type: capture.contentType
  } as unknown as Blob);
  return request<Row>("/v1/axis/documents/upload", { method: "POST", token, body: form });
};
