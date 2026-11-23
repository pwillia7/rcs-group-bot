import { keys, redis } from "./redis";

/** Push an alert to ntfy (NTFY_URL = https://ntfy.sh/<secret-topic>), at most once per `everySeconds`. */
export async function notify(
  name: string,
  title: string,
  message: string,
  { priority = 4, everySeconds = 3600 }: { priority?: number; everySeconds?: number } = {},
): Promise<void> {
  const target = process.env.NTFY_URL;
  if (!target) {
    console.warn(`[notify] ${title}: ${message}`);
    return;
  }
  try {
    const first = await redis().set(keys.alert(name), "1", { nx: true, ex: everySeconds });
    if (first !== "OK") return;
  } catch (error) {
    // No Redis to dedup with: send only in the first 10 min of each period (the watchdog runs every 10).
    console.warn("[notify] dedup unavailable", error);
    if ((Date.now() / 1000) % everySeconds >= 600) return;
  }
  const url = new URL(target);
  const topic = url.pathname.replace(/^\/+|\/+$/g, "");
  await fetch(new URL("/", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, title, message, priority, tags: ["robot"] }),
  }).catch((error) => console.warn("[notify] ntfy failed", error));
}
