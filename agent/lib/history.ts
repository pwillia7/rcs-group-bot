import { randomUUID } from "node:crypto";

import { keys, pushOutbox, redis } from "./redis";

export type HistoryMessage = { ts: number; sender: string; text: string };

export type HistoryResult = {
  messages: HistoryMessage[];
  nextCursor?: string;
  scanned: number;
  error?: string;
};

/** Ask the connector for a page of history (same RPC `read_history` uses). Returns null if the phone doesn't answer. */
export async function fetchHistory(
  conversationId: string,
  { count, cursor, timeoutMs = 25_000 }: { count: number; cursor?: string; timeoutMs?: number },
): Promise<HistoryResult | null> {
  const replyKey = `rpc:${randomUUID()}`;
  await pushOutbox({ id: replyKey, kind: "history", conversationId, count, cursor, replyKey });

  const deadline = Date.now() + timeoutMs;
  let result: HistoryResult | null = null;
  while (Date.now() < deadline) {
    result = await redis().get<HistoryResult>(keys.rpc(replyKey));
    if (result) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!result) return null;
  await redis().del(keys.rpc(replyKey));
  // The connector is Go: a page with nothing in it can come back as `messages: null`.
  return { ...result, messages: result.messages ?? [] };
}
