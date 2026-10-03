import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { phoneJobsFor, type PhoneJob } from "../../src/jobs";
import { entriesFor, type NavEntry } from "../../src/nav";
import { useSession } from "../../src/session";
import { RADIUS, SPACE, TEXT, TOUCH_TARGET } from "../../src/theme";
import { Body, Button, Loading, Muted, Title, textOf, type Chrome } from "../../src/ui";

// The menu is the `nav` array from /v1/me, filtered server-side by the actor's
// permissions — never a list in this file. A role change therefore lands on the
// next launch with no app update, and no screen can offer something the API
// would refuse.

export default function More() {
  const session = useSession();
  const chrome: Chrome = { theme: session.theme, t: session.t, dir: session.dir };
  const { t, theme, me } = session;
  const insets = useSafeAreaInsets();
  const router = useRouter();

  if (session.status === "loading") return <Loading chrome={chrome} />;
  if (session.status !== "signedIn" || !me) return <Redirect href="/login" />;

  const entries = entriesFor(me.nav);
  // The same role -> jobs table the web home draws (@lyra/core/jobs), kept to
  // the jobs this app has a screen for (src/jobs.ts).
  const jobs = phoneJobsFor(me);

  return (
    <ScrollView
      contentContainerStyle={{
        gap: SPACE.xl,
        padding: SPACE.lg,
        paddingTop: insets.top + SPACE.lg,
        paddingBottom: insets.bottom + SPACE.xl
      }}
    >
      <View style={{ gap: SPACE.sm }}>
        {theme.logo ? (
          <Image
            accessible
            accessibilityRole="image"
            accessibilityLabel={session.brandName}
            source={{ uri: theme.logo }}
            resizeMode="contain"
            style={{
              width: 160,
              height: 40,
              alignSelf: session.dir === "rtl" ? "flex-end" : "flex-start"
            }}
          />
        ) : (
          <Title chrome={chrome}>{session.brandName}</Title>
        )}
        {me.profile ? <Muted chrome={chrome}>{t("home.signedInAs", { name: me.profile.name })}</Muted> : null}
      </View>

      {jobs.length ? (
        <View style={{ gap: SPACE.md }}>
          <Text
            accessibilityRole="header"
            style={textOf(chrome, {
              color: theme.muted,
              fontSize: TEXT.s13,
              fontWeight: "600",
              letterSpacing: 0.5,
              textTransform: "uppercase"
            })}
          >
            {t("home.jobs")}
          </Text>
          {jobs.map((job) => (
            <JobRow key={job.route} chrome={chrome} job={job} onPress={() => router.push(job.route)} />
          ))}
        </View>
      ) : null}

      <View style={{ gap: SPACE.md }}>
        <Text
          accessibilityRole="header"
          style={textOf(chrome, {
            color: theme.muted,
            fontSize: TEXT.s13,
            fontWeight: "600",
            letterSpacing: 0.5,
            textTransform: "uppercase"
          })}
        >
          {t("home.workspaces")}
        </Text>

        {entries.length === 0 ? (
          <Body chrome={chrome} style={{ color: theme.muted }}>
            {t("home.empty")}
          </Body>
        ) : (
          entries.map((entry) => (
            <NavRow
              key={entry.href}
              chrome={chrome}
              entry={entry}
              onPress={() => entry.route && router.push(entry.route)}
            />
          ))
        )}
      </View>

      <Button
        chrome={chrome}
        variant="quiet"
        label={t("home.signOut")}
        onPress={() => void session.signOut()}
      />
    </ScrollView>
  );
}

/**
 * One nav item. The label is always a visible Text — icons alone would leave a
 * screen-reader user, and anyone who does not already know the icon set, with
 * nothing to read (docs/07 §2, and the API sends no display text at all).
 */
function NavRow({
  chrome,
  entry,
  onPress
}: {
  chrome: Chrome;
  entry: NavEntry;
  onPress: () => void;
}) {
  const label = chrome.t(entry.labelKey);
  const reachable = entry.route !== undefined;
  return (
    <Pressable
      accessibilityRole={reachable ? "link" : "text"}
      accessibilityLabel={label}
      accessibilityHint={reachable ? undefined : chrome.t("nav.unavailable")}
      accessibilityState={{ disabled: !reachable }}
      disabled={!reachable}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET,
        justifyContent: "center",
        gap: SPACE.xs,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.md,
        borderRadius: RADIUS.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: chrome.theme.border,
        backgroundColor: pressed ? chrome.theme.surfaceRaised : chrome.theme.surface,
        opacity: reachable ? 1 : 0.6
      })}
    >
      <Text
        style={textOf(chrome, {
          color: chrome.theme.text,
          fontSize: TEXT.s16,
          fontWeight: "600"
        })}
      >
        {label}
      </Text>
      {reachable ? null : (
        <Text style={textOf(chrome, { color: chrome.theme.muted, fontSize: TEXT.s12 })}>
          {chrome.t("nav.unavailable")}
        </Text>
      )}
    </Pressable>
  );
}

/** One job: a link with its words visible, the same touch target as a nav row. */
function JobRow({ chrome, job, onPress }: { chrome: Chrome; job: PhoneJob; onPress: () => void }) {
  const label = chrome.t(job.labelKey);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET,
        justifyContent: "center",
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.md,
        borderRadius: RADIUS.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: chrome.theme.border,
        backgroundColor: pressed ? chrome.theme.surfaceRaised : chrome.theme.surface
      })}
    >
      <Text style={textOf(chrome, { color: chrome.theme.text, fontSize: TEXT.s16, fontWeight: "600" })}>{label}</Text>
    </Pressable>
  );
}
