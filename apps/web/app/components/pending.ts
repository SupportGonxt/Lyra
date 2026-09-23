import { useNavigation } from "react-router";

/**
 * Which submission is in flight. One page-wide `navigation.state !== "idle"`
 * spun every button at once — a filter GET spun Create, a Save spun Delete.
 * `pending("create")` is true only while the form carrying that intent is
 * submitting; `pending.get` only while a GET (a filter) is.
 */
export function usePending(): ((intent: string) => boolean) & { get: boolean } {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const intent = navigation.formData?.get("intent");
  const pending = (wanted: string) => busy && intent === wanted;
  return Object.assign(pending, { get: busy && navigation.formMethod?.toUpperCase() === "GET" });
}
