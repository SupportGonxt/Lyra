import { WORKSPACES } from "./modules";

// ADR-0085. Where a record opens, given what the notes API says it is: the
// API's module and resource path (`dist`, `channels`). The generic record
// screen (`/:module/:resource/:id`, record.tsx) is the one place every
// spec-driven record renders — and it carries the `recordLink` onward to any
// bespoke screen — so that is the destination, found through the tab whose
// `api` is that resource.

const BY_API = new Map<string, string>();
for (const spec of WORKSPACES) {
  for (const tab of spec.tabs) {
    // First tab wins: a resource listed twice (a filtered view beside the full
    // list) opens the same record either way.
    if (!BY_API.has(tab.api)) BY_API.set(tab.api, `${spec.path}/${tab.key}`);
  }
}

export function recordHref(module: string, resource: string, id: string): string | null {
  const base = BY_API.get(`/v1/${module}/${resource}`);
  return base ? `${base}/${encodeURIComponent(id)}` : null;
}
