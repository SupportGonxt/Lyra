import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { generateBriefing, queryRows, takeAnomaly, type Row } from "../../src/api";
import {
  anomalyOwner,
  bps,
  briefNarrative,
  canTakeAnomaly,
  chosenBriefing,
  highlightsOf,
  todayIso,
  unownedAnomaly
} from "../../src/journeys";
import { humanize } from "../../src/rows";
import { useSession } from "../../src/session";
import { RADIUS, SPACE } from "../../src/theme";
import {
  Body,
  Button,
  Loading,
  Muted,
  Notice,
  Title,
  errorKeyFor,
  requestIdOf,
  type Chrome
} from "../../src/ui";
import { useLoad } from "../../src/useLoad";

// J-E1, the executive brief on a phone: the narrative NORTH wrote, the figures
// behind it, and the one deviation nobody has taken yet — and the button that
// takes it. Same selection and narrative rules as the web brief
// (apps/web/app/routes/north-shared.tsx `chosen`, `narrative`) — see
// src/journeys.ts.

export default function Brief() {
  const session = useSession();
  const chrome: Chrome = { theme: session.theme, t: session.t, dir: session.dir };
  const { t, theme, token } = session;
  const insets = useSafeAreaInsets();
  const [asked, setAsked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<unknown>(null);
  const [taking, setTaking] = useState(false);
  const [taken, setTaken] = useState(false);

  const briefs = useLoad(
    (signal) =>
      token
        ? queryRows(token, "north/briefings", { sort: "date", order: "desc", limit: 7 }, signal)
        : Promise.resolve({ data: [] as Row[] }),
    [token]
  );
  const anomalies = useLoad(
    (signal) =>
      token
        ? queryRows(
            token,
            "north/anomalies",
            { state: "new", sort: "detectedAt", order: "desc", limit: 10 },
            signal
          )
        : Promise.resolve({ data: [] as Row[] }),
    [token]
  );

  if (session.status === "loading") return <Loading chrome={chrome} />;
  if (session.status !== "signedIn") return <Redirect href="/login" />;

  const rows = briefs.data?.data ?? [];
  const brief = chosenBriefing(rows, null, session.locale);
  const highlights = highlightsOf(brief?.highlightsJson);
  const anomaly = unownedAnomaly(anomalies.data?.data ?? null);
  const owner = anomalyOwner(session.me);
  const mayTake = canTakeAnomaly(session.me?.permissions) && owner !== null;
  const error = briefs.error ?? anomalies.error;

  // Asking for a brief starts a workflow; the row is not readable the instant
  // the call returns, so the screen says what was asked for rather than
  // pretending the answer is already here.
  const ask = async () => {
    if (!token || busy) return;
    const date = todayIso();
    setBusy(true);
    setWriteError(null);
    try {
      await generateBriefing(token, { date, locale: session.dir === "rtl" ? "ar" : "en" });
      setAsked(date);
      briefs.reload();
    } catch (caught) {
      setWriteError(caught);
    } finally {
      setBusy(false);
    }
  };

  // J-E1's last step: the reader puts their name to the deviation, the same
  // close the web's anomaly queue calls "Take it on". Once the row is
  // somebody's it leaves the unowned list, so the reload clears the card and
  // the quiet line below says why.
  const take = async (id: string) => {
    if (!token || !owner || taking) return;
    setTaking(true);
    setWriteError(null);
    setTaken(false);
    try {
      await takeAnomaly(token, id, owner);
      setTaken(true);
      anomalies.reload();
    } catch (caught) {
      setWriteError(caught);
    } finally {
      setTaking(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={{
        gap: SPACE.lg,
        padding: SPACE.lg,
        paddingTop: insets.top + SPACE.lg,
        paddingBottom: insets.bottom + SPACE.xl
      }}
    >
      <Title chrome={chrome}>{t("brief.title")}</Title>

      {briefs.loading || anomalies.loading ? <Muted chrome={chrome}>{t("app.loading")}</Muted> : null}

      {error ? (
        <>
          <Notice chrome={chrome} message={t(errorKeyFor(error))} requestId={requestIdOf(error)} />
          <Button
            chrome={chrome}
            variant="quiet"
            label={t("error.retry")}
            onPress={() => {
              briefs.reload();
              anomalies.reload();
            }}
          />
        </>
      ) : null}

      {writeError ? (
        <Notice
          chrome={chrome}
          message={t(errorKeyFor(writeError))}
          requestId={requestIdOf(writeError)}
        />
      ) : null}

      {asked ? <Muted chrome={chrome}>{t("brief.generated", { date: asked })}</Muted> : null}

      {brief ? (
        <Card chrome={chrome}>
          <Muted chrome={chrome}>
            {t("brief.status", {
              status: humanize(String(brief.status ?? "")),
              date: String(brief.date ?? "")
            })}
          </Muted>
          {paragraphs(briefNarrative(brief.narrativeRef)).map((text, index) => (
            <Body chrome={chrome} key={index}>
              {text}
            </Body>
          ))}
        </Card>
      ) : briefs.loading ? null : (
        <Body chrome={chrome} style={{ color: theme.muted }}>
          {t("brief.empty")}
        </Body>
      )}

      <Button chrome={chrome} label={t("brief.generate")} onPress={ask} busy={busy} />

      <Card chrome={chrome}>
        <Body chrome={chrome} style={{ fontWeight: "600" }}>
          {t("brief.highlights")}
        </Body>
        {highlights.length ? (
          highlights.map((highlight) => (
            <View key={`${highlight.metricKey}-${highlight.period}`} style={{ gap: SPACE.xs }}>
              <Body chrome={chrome}>
                {`${humanize(highlight.metricKey)} · ${highlight.value}`}
              </Body>
              <Muted chrome={chrome}>
                {[highlight.period, bps(highlight.deltaBps)].filter(Boolean).join(" · ")}
              </Muted>
            </View>
          ))
        ) : (
          <Muted chrome={chrome}>{t("brief.noHighlights")}</Muted>
        )}
      </Card>

      <Card chrome={chrome}>
        <Body chrome={chrome} style={{ fontWeight: "600" }}>
          {t("brief.anomaly")}
        </Body>
        {taken ? <Muted chrome={chrome}>{t("brief.taken")}</Muted> : null}
        {anomaly ? (
          <>
            <Body chrome={chrome}>
              {t("brief.anomalyLine", {
                metric: humanize(String(anomaly.metricKey ?? "")),
                delta: bps(typeof anomaly.magnitude === "number" ? anomaly.magnitude : null) ?? "—",
                window: String(anomaly.window ?? "")
              })}
            </Body>
            {mayTake ? (
              <Button
                chrome={chrome}
                variant="quiet"
                label={t("brief.takeOn")}
                onPress={() => void take(anomaly.id)}
                busy={taking}
              />
            ) : null}
          </>
        ) : taken ? null : (
          <Muted chrome={chrome}>{t("brief.anomalyNone")}</Muted>
        )}
      </Card>

      {brief && rows.length > 1 ? (
        <Card chrome={chrome}>
          <Body chrome={chrome} style={{ fontWeight: "600" }}>
            {t("brief.recent")}
          </Body>
          {rows
            .filter((row) => row.id !== brief.id)
            .map((row) => (
              <Muted chrome={chrome} key={row.id}>
                {t("brief.status", {
                  status: humanize(String(row.status ?? "")),
                  date: String(row.date ?? "")
                })}
              </Muted>
            ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

/** The narrative as paragraphs. Blank lines are the model's own breaks. */
function paragraphs(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function Card({ chrome, children }: { chrome: Chrome; children: React.ReactNode }) {
  return (
    <View
      style={{
        gap: SPACE.sm,
        padding: SPACE.lg,
        borderRadius: RADIUS.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: chrome.theme.border,
        backgroundColor: chrome.theme.surface
      }}
    >
      {children}
    </View>
  );
}
