import { and, count, eq, inArray } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { AppError, assertSeatAvailable, audit, emit, forbidden, require_, type Ctx } from "@lyra/core";
import { assertCanGrant, bundleOf } from "./staff.js";

// ADR-0096. SCIM 2.0 (RFC 7643/7644) over the tenant's people and roles. An
// identity provider is a caller like any other: an API key whose scopes are
// the permissions a person doing the same job would need, held to the same
// escalation guard (`assertCanGrant`) when it hands out a role.

export const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const BASE = "/v1/scim/v2";
const MAX_COUNT = 200;

/** A SCIM error: `scimType` rides in `code`, which the route renders. */
export const scimError = (status: number, scimType: string | null, detail: string) =>
  new AppError(status, scimType ?? "scim", "SCIM error", detail);

type UserRow = typeof schema.users.$inferSelect;
type RoleRow = typeof schema.roles.$inferSelect;
const iso = (ms: number) => new Date(ms).toISOString();

export function toUser(row: UserRow) {
  return {
    schemas: [USER],
    id: row.id,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    userName: row.email,
    name: { formatted: row.name },
    displayName: row.name,
    locale: row.locale,
    active: row.status !== "suspended",
    emails: [{ value: row.email, primary: true }],
    meta: { resourceType: "User", created: iso(row.createdAt), lastModified: iso(row.updatedAt), location: `${BASE}/Users/${row.id}` }
  };
}

/** `attr eq "value"` on the named attributes; anything else is refused, never widened to "all". */
function parseFilter(filter: string | undefined, attributes: readonly string[]): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attr = m && attributes.find((a) => a.toLowerCase() === m[1]!.toLowerCase());
  if (!m || !attr) throw scimError(400, "invalidFilter", `supported filters: ${attributes.map((a) => `${a} eq "…"`).join(", ")}`);
  return { attr, value: m[2]!.replace(/\\(.)/g, "$1") };
}

function page(startIndex: string | undefined, countParam: string | undefined) {
  const start = Math.max(1, Number(startIndex) || 1);
  const size = Math.min(MAX_COUNT, Math.max(0, countParam === undefined ? 100 : Number(countParam) || 0));
  return { start, size };
}

const listResponse = <T>(resources: T[], total: number, start: number) => ({
  schemas: [LIST],
  totalResults: total,
  startIndex: start,
  itemsPerPage: resources.length,
  Resources: resources
});

/* ---------------------------------------------------------------- users */

async function userById(ctx: Ctx, id: string): Promise<UserRow> {
  const [row] = await ctx.db.select().from(schema.users).where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.id, id))).limit(1);
  if (!row) throw scimError(404, null, `User ${id} not found`);
  return row;
}

export async function listUsers(ctx: Ctx, q: { filter?: string; startIndex?: string; count?: string }) {
  require_(ctx.actor, "core:users:read", { tenantId: ctx.tenantId, module: "core" });
  const f = parseFilter(q.filter, ["userName", "externalId"]);
  const { start, size } = page(q.startIndex, q.count);
  const where = and(
    eq(schema.users.tenantId, ctx.tenantId),
    f?.attr === "userName" ? eq(schema.users.email, f.value.trim().toLowerCase()) : undefined,
    f?.attr === "externalId" ? eq(schema.users.externalId, f.value) : undefined
  );
  const [{ total }] = (await ctx.db.select({ total: count() }).from(schema.users).where(where)) as [{ total: number }];
  const rows = size ? await ctx.db.select().from(schema.users).where(where).orderBy(schema.users.createdAt).limit(size).offset(start - 1) : [];
  return listResponse(rows.map(toUser), total, start);
}

export async function getUser(ctx: Ctx, id: string) {
  require_(ctx.actor, "core:users:read", { tenantId: ctx.tenantId, module: "core" });
  return toUser(await userById(ctx, id));
}

interface UserFields {
  userName?: string;
  name?: string;
  externalId?: string | null;
  active?: boolean;
  locale?: string;
}

const asBool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : typeof v === "string" && /^(true|false)$/i.test(v) ? v.toLowerCase() === "true" : undefined;

/** The attributes this service keeps, read from a SCIM User body. The rest are ignored, not refused: IdPs send far more than any one service stores. */
function fieldsOf(body: Record<string, unknown>): UserFields {
  const out: UserFields = {};
  if (typeof body.userName === "string") out.userName = body.userName;
  const name = body.name as { formatted?: unknown; givenName?: unknown; familyName?: unknown } | undefined;
  const formatted =
    (typeof name?.formatted === "string" && name.formatted) ||
    [name?.givenName, name?.familyName].filter((p): p is string => typeof p === "string" && !!p).join(" ") ||
    (typeof body.displayName === "string" && body.displayName) ||
    "";
  if (formatted) out.name = formatted;
  if (typeof body.externalId === "string" || body.externalId === null) out.externalId = body.externalId as string | null;
  const active = asBool(body.active);
  if (active !== undefined) out.active = active;
  if (typeof body.locale === "string" && /^(en|ar)/i.test(body.locale)) out.locale = body.locale.slice(0, 2).toLowerCase();
  return out;
}

function emailOf(userName: string): string {
  const email = userName.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw scimError(400, "invalidValue", "userName must be an email address");
  return email;
}

async function assertUnique(ctx: Ctx, email: string, except?: string) {
  const [clash] = await ctx.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.email, email)))
    .limit(1);
  if (clash && clash.id !== except) throw scimError(409, "uniqueness", `userName ${email} is already provisioned`);
}

export async function createUser(ctx: Ctx, body: Record<string, unknown>) {
  require_(ctx.actor, "core:users:create", { tenantId: ctx.tenantId, module: "core" });
  const f = fieldsOf(body);
  if (!f.userName) throw scimError(400, "invalidValue", "userName is required");
  const email = emailOf(f.userName);
  await assertUnique(ctx, email);
  await assertSeatAvailable(ctx);
  const row: typeof schema.users.$inferInsert = {
    id: newId("us", ctx.now),
    tenantId: ctx.tenantId,
    email,
    name: f.name ?? email,
    locale: f.locale ?? "en",
    // The IdP vouches for the person: they sign in through it, never with a
    // password this platform issued.
    status: f.active === false ? "suspended" : "active",
    authProvider: "oidc",
    externalId: f.externalId ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.users).values(row);
  await audit(ctx, { action: "core.scim.user_create", subjectRef: `users:${row.id}`, after: row });
  await emit(ctx, { module: "core", type: "core.scim.user_provisioned", subject: `users:${row.id}`, data: { userId: row.id } });
  return toUser(await userById(ctx, row.id));
}

async function applyUser(ctx: Ctx, before: UserRow, f: UserFields) {
  const patch: Partial<UserRow> = { updatedAt: ctx.now };
  if (f.userName !== undefined) {
    const email = emailOf(f.userName);
    if (email !== before.email) await assertUnique(ctx, email, before.id);
    patch.email = email;
  }
  if (f.name !== undefined) patch.name = f.name;
  if (f.externalId !== undefined) patch.externalId = f.externalId;
  if (f.locale !== undefined) patch.locale = f.locale;
  if (f.active !== undefined) patch.status = f.active ? (before.status === "suspended" ? "active" : before.status) : "suspended";
  await ctx.db.update(schema.users).set(patch).where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.id, before.id)));
  const after = await userById(ctx, before.id);
  const deactivated = before.status !== "suspended" && after.status === "suspended";
  await audit(ctx, {
    action: deactivated ? "core.scim.user_deactivate" : "core.scim.user_update",
    subjectRef: `users:${before.id}`,
    before,
    after
  });
  if (deactivated) {
    await emit(ctx, { module: "core", type: "core.scim.user_deactivated", subject: `users:${before.id}`, data: { userId: before.id } });
  }
  return toUser(after);
}

export async function replaceUser(ctx: Ctx, id: string, body: Record<string, unknown>) {
  require_(ctx.actor, "core:users:update", { tenantId: ctx.tenantId, module: "core" });
  const before = await userById(ctx, id);
  const f = fieldsOf(body);
  // PUT replaces: an absent `active` means the default, which is active.
  return applyUser(ctx, before, { ...f, active: f.active ?? true });
}

interface PatchOp {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

const opsOf = (body: Record<string, unknown>): PatchOp[] => {
  if (!Array.isArray(body.Operations) || !body.Operations.length) throw scimError(400, "invalidSyntax", "Operations is required");
  return body.Operations as PatchOp[];
};

export async function patchUser(ctx: Ctx, id: string, body: Record<string, unknown>) {
  require_(ctx.actor, "core:users:update", { tenantId: ctx.tenantId, module: "core" });
  const before = await userById(ctx, id);
  const f: UserFields = {};
  for (const operation of opsOf(body)) {
    const op = String(operation.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") throw scimError(400, "invalidSyntax", `unknown op ${String(operation.op)}`);
    const path = typeof operation.path === "string" ? operation.path : undefined;
    if (op === "remove") {
      if (path === "externalId") f.externalId = null;
      continue;
    }
    // Without a path the value is a partial User; with one it is that attribute.
    const partial = path
      ? path === "name.formatted" || path === "displayName"
        ? { name: { formatted: operation.value } }
        : path === "name.givenName" || path === "name.familyName"
          ? { name: { [path.slice(5)]: operation.value, ...(path === "name.givenName" ? { familyName: before.name.split(" ").slice(1).join(" ") } : { givenName: before.name.split(" ")[0] }) } }
          : { [path]: operation.value }
      : (operation.value as Record<string, unknown>) ?? {};
    Object.assign(f, fieldsOf(partial));
  }
  return applyUser(ctx, before, f);
}

/** DELETE deactivates: the person's history (audit, approvals, notes) stays attributable. */
export async function deactivateUser(ctx: Ctx, id: string): Promise<void> {
  require_(ctx.actor, "core:users:update", { tenantId: ctx.tenantId, module: "core" });
  await applyUser(ctx, await userById(ctx, id), { active: false });
}

/* --------------------------------------------------------------- groups */

async function membersOf(ctx: Ctx, roleIds: string[]): Promise<Map<string, { value: string; display: string }[]>> {
  const out = new Map<string, { value: string; display: string }[]>();
  if (!roleIds.length) return out;
  const rows = await ctx.db
    .select({ roleId: schema.userRoles.roleId, userId: schema.users.id, email: schema.users.email })
    .from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(and(eq(schema.userRoles.tenantId, ctx.tenantId), inArray(schema.userRoles.roleId, roleIds)));
  for (const r of rows) out.set(r.roleId, [...(out.get(r.roleId) ?? []), { value: r.userId, display: r.email }]);
  return out;
}

const toGroup = (role: RoleRow, members: { value: string; display: string }[]) => ({
  schemas: [GROUP],
  id: role.id,
  displayName: role.key,
  members: members.map((m) => ({ ...m, $ref: `${BASE}/Users/${m.value}` })),
  meta: { resourceType: "Group", created: iso(role.createdAt), location: `${BASE}/Groups/${role.id}` }
});

async function roleById(ctx: Ctx, id: string): Promise<RoleRow> {
  const [row] = await ctx.db.select().from(schema.roles).where(and(eq(schema.roles.tenantId, ctx.tenantId), eq(schema.roles.id, id))).limit(1);
  if (!row) throw scimError(404, null, `Group ${id} not found`);
  return row;
}

export async function listGroups(ctx: Ctx, q: { filter?: string; startIndex?: string; count?: string }) {
  require_(ctx.actor, "core:roles:read", { tenantId: ctx.tenantId, module: "core" });
  const f = parseFilter(q.filter, ["displayName"]);
  const { start, size } = page(q.startIndex, q.count);
  const where = and(eq(schema.roles.tenantId, ctx.tenantId), f ? eq(schema.roles.key, f.value) : undefined);
  const [{ total }] = (await ctx.db.select({ total: count() }).from(schema.roles).where(where)) as [{ total: number }];
  const rows = size ? await ctx.db.select().from(schema.roles).where(where).orderBy(schema.roles.key).limit(size).offset(start - 1) : [];
  const members = await membersOf(ctx, rows.map((r) => r.id));
  return listResponse(rows.map((r) => toGroup(r, members.get(r.id) ?? [])), total, start);
}

export async function getGroup(ctx: Ctx, id: string) {
  require_(ctx.actor, "core:roles:read", { tenantId: ctx.tenantId, module: "core" });
  const role = await roleById(ctx, id);
  return toGroup(role, (await membersOf(ctx, [role.id])).get(role.id) ?? []);
}

const memberIds = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .map((m) => (m as { value?: unknown }).value)
    .filter((v): v is string => typeof v === "string");

/**
 * Membership is the only thing a Group PATCH changes: a role's permissions are
 * the tenant administrator's to edit, never an IdP's. Adding a member is a role
 * grant, so the key must hold the whole bundle (`assertCanGrant`).
 */
export async function patchGroup(ctx: Ctx, id: string, body: Record<string, unknown>) {
  require_(ctx.actor, "core:roles:assign", { tenantId: ctx.tenantId, module: "core" });
  const role = await roleById(ctx, id);
  const current = new Set(((await membersOf(ctx, [role.id])).get(role.id) ?? []).map((m) => m.value));
  const next = new Set(current);
  for (const operation of opsOf(body)) {
    const op = String(operation.op ?? "").toLowerCase();
    const path = typeof operation.path === "string" ? operation.path : "";
    const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
    if (op === "add" && path === "members") memberIds(operation.value).forEach((m) => next.add(m));
    else if (op === "remove" && filtered) next.delete(filtered[1]!);
    else if (op === "remove" && path === "members") (operation.value === undefined ? [...next] : memberIds(operation.value)).forEach((m) => next.delete(m));
    else if (op === "replace" && path === "members") {
      next.clear();
      memberIds(operation.value).forEach((m) => next.add(m));
    } else if (op === "replace" && !path && Array.isArray((operation.value as { members?: unknown })?.members)) {
      next.clear();
      memberIds((operation.value as { members: unknown }).members).forEach((m) => next.add(m));
    } else if (op === "replace" && (path === "displayName" || (!path && (operation.value as { displayName?: unknown })?.displayName !== undefined))) {
      throw scimError(400, "mutability", "a Group's displayName is the role key, which SCIM cannot rename");
    } else throw scimError(400, "invalidPath", `unsupported Group operation ${op} ${path}`);
  }

  const added = [...next].filter((m) => !current.has(m));
  const removed = [...current].filter((m) => !next.has(m));
  if (added.length) {
    try {
      assertCanGrant(ctx, bundleOf(role), role.key);
    } catch {
      throw forbidden(`this key cannot grant ${role.key}: it does not hold every permission the role confers`);
    }
    const known = await ctx.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, ctx.tenantId), inArray(schema.users.id, added)));
    if (known.length !== added.length) throw scimError(400, "invalidValue", "a member is not a User of this tenant");
    await ctx.db
      .insert(schema.userRoles)
      .values(added.map((userId, i) => ({ id: newId("url", ctx.now + i), tenantId: ctx.tenantId, userId, roleId: role.id, createdAt: ctx.now })))
      .onConflictDoNothing();
  }
  if (removed.length) {
    await ctx.db
      .delete(schema.userRoles)
      .where(and(eq(schema.userRoles.tenantId, ctx.tenantId), eq(schema.userRoles.roleId, role.id), inArray(schema.userRoles.userId, removed)));
  }
  for (const userId of [...added, ...removed]) {
    const change = { userId, added: added.includes(userId) ? [role.key] : [], removed: removed.includes(userId) ? [role.key] : [] };
    await audit(ctx, { action: "core.staff.roles_changed", subjectRef: `users:${userId}`, after: { ...change, via: "scim" } });
    await emit(ctx, { module: "core", type: "core.staff.roles_changed", subject: `users:${userId}`, data: change });
  }
  return getGroup(ctx, id);
}
