import { translator, type Translate } from "./i18n";
import { workspaceFor } from "./modules";
import { labelsFor } from "./modules/spec";

/**
 * The document <title> for a path: the screen, the workspace it sits in, the
 * product — "Quote desk · Operations · GONXT". Read from the same catalogue the
 * rail uses, so a screen is called the same thing in the tab as in the nav.
 * Opaque ids are never part of it; a record is titled by its resource.
 */
export function documentTitle(pathname: string, t: Translate, product: string, locale: string, pack?: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (!segments.length) return join([t("nav.home"), product]);

  const known = (key: string) => {
    const value = t(key);
    return value === key ? null : value;
  };

  const workspace = known(`nav.${segments[0]}`);
  // Deepest nav key the path reaches: /axis/claims/desk before /axis/claims.
  let screen: string | null = null;
  for (let depth = segments.length; depth > 1 && !screen; depth--) {
    screen = known(`nav.${segments.slice(0, depth).join("/")}`);
  }
  // A generic resource tab (/axis/cases, /axis/cases/:id) is named by its spec.
  if (!screen && segments[1]) {
    const spec = workspaceFor(`/${segments[0]}`);
    if (spec?.tabs.some((tab) => tab.key === segments[1])) screen = labelsFor(spec, locale, pack)(segments[1]);
  }
  return join([screen, workspace, product]);
}

function join(parts: (string | null)[]): string {
  return [...new Set(parts.filter((part): part is string => Boolean(part)))].join(" · ");
}

interface TitleSession {
  locale: string;
  overrides?: Record<string, string>;
  brand?: { name?: string | null } | null;
  tenantName: string;
  domainPack?: string;
}

/** The `meta` every session layout exports: one title rule for the whole app. */
export function sessionMeta({ loaderData, location }: { loaderData?: TitleSession; location: { pathname: string } }) {
  if (!loaderData) return [];
  const t = translator(loaderData.locale, loaderData.overrides);
  const product = loaderData.brand?.name ?? loaderData.tenantName;
  return [{ title: documentTitle(location.pathname, t, product, loaderData.locale, loaderData.domainPack) }];
}
