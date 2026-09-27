import { Hono, type Context } from "hono";
import { AppError, ForbiddenError } from "@lyra/core";
import {
  ERROR,
  createUser,
  deactivateUser,
  getGroup,
  getUser,
  listGroups,
  listUsers,
  patchGroup,
  patchUser,
  replaceUser,
  scimError
} from "../engines/scim.js";
import type { App } from "../env.js";

// ADR-0096: /v1/scim/v2. Everything answers in SCIM's own media type and
// error shape (RFC 7644 §3.12), which is what an IdP's connector parses.

export const scimRoutes = new Hono<App>();
const TYPE = "application/scim+json";

const reply = (c: Context<App>, body: unknown, status = 200) =>
  c.body(JSON.stringify(body), status as 200, { "content-type": TYPE });

async function scimBody(c: Context<App>): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw scimError(400, "invalidSyntax", "the body is not a JSON object");
}

const SCIM_TYPES = new Set(["uniqueness", "invalidFilter", "invalidValue", "invalidSyntax", "invalidPath", "mutability"]);

// A refusal a client can act on (an AppError 4xx, or require_'s ForbiddenError)
// answers as SCIM; anything else is a real failure for the app's own handler.
scimRoutes.onError((err, c) => {
  const status = err instanceof ForbiddenError ? 403 : err instanceof AppError ? err.status : 500;
  if (status >= 500) throw err;
  const code = err instanceof AppError ? err.code : "";
  const detail = (err instanceof AppError ? err.detail : undefined) ?? err.message;
  return reply(c, { schemas: [ERROR], status: String(status), ...(SCIM_TYPES.has(code) ? { scimType: code } : {}), detail }, status);
});

const q = (c: Context<App>) => ({
  ...(c.req.query("filter") !== undefined ? { filter: c.req.query("filter")! } : {}),
  ...(c.req.query("startIndex") !== undefined ? { startIndex: c.req.query("startIndex")! } : {}),
  ...(c.req.query("count") !== undefined ? { count: c.req.query("count")! } : {})
});

scimRoutes.get("/ServiceProviderConfig", (c) =>
  reply(c, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "API key", description: "A tenant API key carrying core:users and core:roles scopes" }]
  })
);

scimRoutes.get("/Users", async (c) => reply(c, await listUsers(c.get("ctx"), q(c))));
scimRoutes.post("/Users", async (c) => reply(c, await createUser(c.get("ctx"), await scimBody(c)), 201));
scimRoutes.get("/Users/:id", async (c) => reply(c, await getUser(c.get("ctx"), c.req.param("id"))));
scimRoutes.put("/Users/:id", async (c) => reply(c, await replaceUser(c.get("ctx"), c.req.param("id"), await scimBody(c))));
scimRoutes.patch("/Users/:id", async (c) => reply(c, await patchUser(c.get("ctx"), c.req.param("id"), await scimBody(c))));
scimRoutes.delete("/Users/:id", async (c) => {
  await deactivateUser(c.get("ctx"), c.req.param("id"));
  return c.body(null, 204);
});

scimRoutes.get("/Groups", async (c) => reply(c, await listGroups(c.get("ctx"), q(c))));
scimRoutes.get("/Groups/:id", async (c) => reply(c, await getGroup(c.get("ctx"), c.req.param("id"))));
scimRoutes.patch("/Groups/:id", async (c) => reply(c, await patchGroup(c.get("ctx"), c.req.param("id"), await scimBody(c))));
// Roles are the administrator's to define; an IdP only manages who is in one.
scimRoutes.on(["POST", "PUT", "DELETE"], ["/Groups", "/Groups/:id"], () => {
  throw scimError(403, "mutability", "Groups are this tenant's roles; SCIM manages their members only");
});
