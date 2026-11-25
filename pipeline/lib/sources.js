// Load and validate sources.yaml (Actions side; the Lambda receives the list in its event).

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCES_PATH = resolve(here, "../../sources.yaml");
export const AUTHORITIES = ["official", "standards", "lab", "research", "industry", "news", "vendor"];
export const SECTORS = ["financial-services"];

export async function loadSources(path = SOURCES_PATH) {
  const { sources } = parse(await readFile(path, "utf8"));
  const ids = new Set();
  for (const s of sources) {
    if (!s.id || ids.has(s.id)) throw new Error(`missing or duplicate source id: ${s.id}`);
    ids.add(s.id);
    if (!AUTHORITIES.includes(s.authority)) throw new Error(`${s.id}: bad authority ${s.authority}`);
    if (!s.homepage) throw new Error(`${s.id}: homepage required`);
    if (s.sector && !SECTORS.includes(s.sector)) throw new Error(`${s.id}: bad sector ${s.sector}`);
    for (const re of [].concat(s.must_match || [])) {
      try {
        new RegExp(re, "i");
      } catch {
        throw new Error(`${s.id}: bad must_match regex ${re}`);
      }
    }
    s.status ??= "active";
  }
  return sources;
}

export const activeSources = (sources) => sources.filter((s) => s.status !== "blocked");
