// Keyless GIF search. Reads the public search pages of Tenor (which embed the
// full result list as JSON) and falls back to Giphy's (GIF ids scraped from the
// page). No API key, no rating parameter: results are whatever the site's web
// search returns. Pages change; if both break, the agent can still find a GIF
// with web_search and send it by URL.

export type Gif = {
  url: string;
  description: string;
  bytes?: number;
  seconds?: number;
  source: "tenor" | "giphy";
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
// Larger GIFs are slow to download/upload and to load on phones.
const MAX_BYTES = 12 << 20;

async function page(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

const slug = (q: string) =>
  q
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

type TenorFormat = { url?: string; size?: number; duration?: number };
type TenorResult = {
  content_description?: string;
  title?: string;
  flags?: string[];
  media_formats?: Record<string, TenorFormat>;
};

function findResults(node: unknown, depth = 0): TenorResult[] | undefined {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    if (node.length && (node[0] as TenorResult)?.media_formats)
      return node as TenorResult[];
    for (const v of node) {
      const r = findResults(v, depth + 1);
      if (r) return r;
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  // Prefer the search results over the page's other GIF lists (trending etc.).
  const keys = Object.keys(obj).sort(
    (a, b) => Number(b === "search") - Number(a === "search"),
  );
  for (const k of keys) {
    const r = findResults(obj[k], depth + 1);
    if (r) return r;
  }
}

export async function searchTenor(query: string): Promise<Gif[]> {
  const html = await page(`https://tenor.com/search/${slug(query)}-gifs`);
  const m = html.match(/<script id="store-cache"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  const store = JSON.parse(m[1]) as Record<string, unknown>;
  const results = findResults(store.universal) ?? findResults(store.gifs) ?? [];
  const gifs: Gif[] = [];
  for (const r of results) {
    const f = r.media_formats ?? {};
    // Many Tenor "GIFs" are single still images; skip them.
    if (r.flags?.includes("static") || f.gif?.duration === 0) continue;
    // mediumgif is a good size/quality trade-off; full "gif" can be 10+ MB.
    const pickFmt = [f.mediumgif, f.gif, f.tinygif].find(
      (x) => x?.url && (!x.size || x.size <= MAX_BYTES),
    );
    if (pickFmt?.url) {
      gifs.push({
        url: pickFmt.url,
        bytes: pickFmt.size,
        seconds: f.gif?.duration,
        description: r.content_description || r.title || "",
        source: "tenor",
      });
    }
  }
  return gifs;
}

export async function searchGiphy(query: string): Promise<Gif[]> {
  const html = await page(`https://giphy.com/search/${slug(query)}`);
  const ids: string[] = [];
  for (const m of html.matchAll(
    /media\d?\.giphy\.com\/media\/(?:v1\.[A-Za-z0-9_=-]+\/)?([A-Za-z0-9]{8,})\/(?:giphy|\d+w?|200_d)\.(?:gif|webp)/g,
  )) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids.map((id) => ({
    url: `https://i.giphy.com/${id}.gif`,
    description: "",
    source: "giphy" as const,
  }));
}

export async function searchGifs(
  query: string,
): Promise<{ gifs: Gif[]; errors: string[] }> {
  const errors: string[] = [];
  for (const search of [searchTenor, searchGiphy]) {
    try {
      const gifs = await search(query);
      if (gifs.length) return { gifs, errors };
      errors.push(`${search.name}: no results`);
    } catch (err) {
      errors.push(
        `${search.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { gifs: [], errors };
}
