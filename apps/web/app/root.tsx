import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigation,
  useRouteError,
  useRouteLoaderData,
  type LinksFunction,
  type LoaderFunctionArgs
} from "react-router";
import { UiTextProvider, UiTimeZoneProvider } from "@lyra/ui";
import "./app.css";
import { ErrorPanel } from "./components/error-panel";
import {
  DEFAULT_LOCALE,
  dirFor,
  formatLocaleFrom,
  langFor,
  localeFrom,
  readCookie,
  translator
} from "./i18n";

// Only the two first-paint faces (packages/ui/FONTS.md §Preload; ADR-0026).
// The mono, the four Arabic cuts, and Instrument Serif are discovered when
// they first match an element — preloading them would fetch bytes most page
// loads never render. `crossOrigin` is mandatory even same-origin: fonts are
// fetched in CORS mode, and a preload without it is a second, unused request.
export const links: LinksFunction = () => [
  {
    rel: "preload",
    href: "/fonts/instrument-sans-latin-wght-normal.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous"
  },
  {
    rel: "preload",
    href: "/fonts/archivo-latin-wght-normal.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous"
  }
];

// The document. Locale is resolved here rather than in the shell so that the
// login page — which has no session and therefore no profile — still renders in
// the right direction on the first frame.

/**
 * Horizon is two palettes, not one behind a filter (tokens.css): daylight is a
 * white page with no starfield, night is the deep field. Resolving the choice on
 * the server is the whole point — a client-side flip flashes the wrong palette
 * on every navigation. Dark is the product default (docs/01-brand.md: "dark-
 * first"): absent a cookie, every visitor gets dark regardless of OS
 * preference, until they opt into light via the toggle.
 */
function themeFrom(request: Request): "dark" | "light" {
  const theme = readCookie(request.headers.get("cookie"), "lyra_theme");
  return theme === "light" ? "light" : "dark";
}

export function loader({ request }: LoaderFunctionArgs) {
  // Two locales, on purpose (docs/27 F42, apps/web/app/i18n.ts). `locale` picks
  // the string catalogue and is region-free; `formatLocale` keeps the region
  // subtag, because that is the whole input to which digits a number renders in
  // — `ar` is Latin numerals, `ar-SA` is ١٢٣. Both come off the one request, so
  // the server pass and the first client pass cannot disagree.
  return {
    locale: localeFrom(request),
    formatLocale: formatLocaleFrom(request),
    theme: themeFrom(request)
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined while the root loader itself is failing; the document still has
  // to render, so fall back rather than throw a second time.
  const data = useRouteLoaderData<typeof loader>("root");
  const locale = data?.locale ?? DEFAULT_LOCALE;
  // `<html lang>` takes the region-qualified tag: it is what a screen reader
  // announces numbers from, and it is the tag a browser's own number rendering
  // reads. `dirFor` is unaffected — direction is a property of the script.
  const formatLocale = data?.formatLocale ?? locale;

  return (
    <html lang={langFor(formatLocale)} dir={dirFor(locale)} data-theme={data?.theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="strict-origin-when-cross-origin" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">
        {/* One locale for every @lyra/ui surface below: kit chrome, <Money>,
            <DateTime>. Without it the kit formats in English under an Arabic
            document, and 98 Table call sites each have to remember a prop. */}
        <UiTextProvider locale={formatLocale}>
          {/* Timestamps render UTC on the server and on the first client pass,
              then the reader's own zone once mounted. Unpinned, the two passes
              disagree and React drops the route to the error boundary.
              No zone here on purpose: this mount is the document, which also
              carries the screens that have no tenant yet — login, the public
              ORBIT portals. A tenant's own zone is mounted a level down, once
              per shell, by components/region.tsx SessionRegion. */}
          <UiTimeZoneProvider>{children}</UiTimeZoneProvider>
        </UiTextProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Every route already handles its own local pending state (busy buttons,
  // disabled forms); this is the one cue that isn't per-screen — the shell
  // notices the navigation itself, not what it's waiting on.
  const navigation = useNavigation();
  return (
    <>
      {navigation.state !== "idle" ? <div aria-hidden="true" className="lyra-nav-progress" /> : null}
      <Outlet />
    </>
  );
}

/**
 * The last boundary: whatever failed, failed before a session existed — the
 * root loader itself, or the document. Nothing is loaded, so the panel gets a
 * bare page. A failure *inside* the session renders in the shell instead
 * (routes/workspace.tsx): losing the rail on a mistyped URL reads as a crash.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const data = useRouteLoaderData<typeof loader>("root");
  const t = translator(data?.locale ?? DEFAULT_LOCALE);

  return (
    <main className="mx-auto flex min-h-screen max-w-prose flex-col justify-center p-8">
      <ErrorPanel error={error} t={t} />
    </main>
  );
}
