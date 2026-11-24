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
