// Git-backed item store: data/items/YYYY/MM/<id>.json (one file per item).
// Full source text is never stored (copyright) — only its sha256.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(here, "../../data");
export const ITEMS_DIR = join(DATA_DIR, "items");

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

export async function listItemIds(dir = ITEMS_DIR) {
  return (await walk(dir)).map((p) => p.split("/").pop().replace(/\.json$/, ""));
}

export async function loadItems(dir = ITEMS_DIR) {
  const files = await walk(dir);
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8"))));
}

export function itemPath(item, dir = ITEMS_DIR) {
  const d = new Date(item.publishedAt || item.fetchedAt);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(dir, yyyy, mm, `${item.id}.json`);
}

export async function saveItem(item, dir = ITEMS_DIR) {
  const p = itemPath(item, dir);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(item, null, 2) + "\n");
  return p;
}

// Sitemap pages already checked and rejected (not about AI / out of window), so
// the sitemap adapter doesn't re-fetch them daily. { "<item id>": "<checkedAt>" }.
export const SEEN_PATH = join(DATA_DIR, "seen", "sitemap.json");
const SEEN_TTL_DAYS = 200;

export async function loadSeen(path = SEEN_PATH) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/** Merge newly rejected ids and prune entries older than the TTL. */
export async function saveSeen(newIds, now = new Date(), path = SEEN_PATH) {
  const seen = await loadSeen(path);
  const stamp = now.toISOString();
  for (const id of newIds) seen[id] ??= stamp;
  const cutoff = new Date(now - SEEN_TTL_DAYS * 864e5).toISOString();
  for (const [id, t] of Object.entries(seen)) if (t < cutoff) delete seen[id];
  await mkdir(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(seen).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path, JSON.stringify(sorted, null, 1) + "\n");
  return Object.keys(sorted).length;
}
