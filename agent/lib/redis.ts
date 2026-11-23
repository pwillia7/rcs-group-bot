import { Redis } from "@upstash/redis";

// Upstash via the Vercel Marketplace sets KV_REST_API_*; plain Upstash uses UPSTASH_REDIS_REST_*.
let client: Redis | undefined;
export function redis(): Redis {
  client ??= new Redis({
    url: process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "",
    token: process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
  });
  return client;
}

// Must match the connector's REDIS_PREFIX.
const prefix = process.env.REDIS_PREFIX ?? "gm";
export const keys = {
  outbox: `${prefix}:outbox`,
  modelMode: `${prefix}:model-mode`,
  /** Set (with a TTL) when Qwen missed its first-token deadline; auto mode uses Claude meanwhile. */
  qwenSlow: `${prefix}:qwen-slow`,
  /** "qwen" | "claude": backend of the latest model output, for the reply's emoji. */
  lastBackend: `${prefix}:last-backend`,
  state: `${prefix}:state`,
  heartbeat: `${prefix}:heartbeat`,
  recent: (conversationId: string) => `${prefix}:recent:${conversationId}`,
  recentMedia: (conversationId: string) => `${prefix}:recent-media:${conversationId}`,
  media: (key: string) => `${prefix}:${key}`,
  /** "1" while the connector is fetching a photo in this conversation. */
  photoPending: (conversationId: string) => `${prefix}:photo-pending:${conversationId}`,
  /** Full Redis key for an RPC reply; the connector writes `${prefix}:${suffix}`. */
  rpc: (suffix: string) => `${prefix}:${suffix}`,
  alert: (name: string) => `${prefix}:alert-agent:${name}`,
  /** Last deployment the bot was told about in this conversation (see deployNote). */
  deployNoted: (conversationId: string) => `${prefix}:deploy-noted:${conversationId}`,
  /** Set by send_gif: the GIF is the reply, so the turn's closing text is dropped. */
  gifSent: (conversationId: string) => `${prefix}:gif-sent:${conversationId}`,
};

export type OutboxItem = {
  id: string;
  kind?: "text" | "typing" | "history" | "cookies";
  conversationId: string;
  text?: string;
  replyToMessageId?: string;
  /** Public https image/GIF/video the connector sends as an attachment; `text` becomes its caption. */
  mediaUrl?: string;
  count?: number;
  search?: string;
  cursor?: string;
  replyKey?: string;
  cookies?: Record<string, string>;
  force?: boolean;
};

export type ConnectorState = { state: string; reason?: string; at: number };

export async function pushOutbox(item: OutboxItem): Promise<void> {
  await redis().lpush(keys.outbox, JSON.stringify(item));
}
