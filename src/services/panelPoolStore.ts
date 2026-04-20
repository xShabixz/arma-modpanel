import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";

export interface PanelPoolMod {
  modId: string;
  name?: string;
  version?: string;
  required: boolean;
  contentType: "mod" | "game";
}

interface PanelPoolStoreFile {
  contexts: Record<string, PanelPoolMod[]>;
}

function contextKey(serverId: string, configPath: string): string {
  return `${serverId.trim()}::${configPath.trim()}`;
}

function normalizeContentType(value: unknown): "mod" | "game" {
  return String(value || "mod").trim().toLowerCase() === "game" ? "game" : "mod";
}

function normalizePoolMod(mod: Partial<PanelPoolMod> & { modId: string }): PanelPoolMod {
  return {
    modId: String(mod.modId || "").trim().toUpperCase(),
    name: typeof mod.name === "string" && mod.name.trim() ? mod.name.trim() : undefined,
    version: typeof mod.version === "string" && mod.version.trim() ? mod.version.trim() : undefined,
    required: Boolean(mod.required),
    contentType: normalizeContentType(mod.contentType)
  };
}

async function readStore(): Promise<PanelPoolStoreFile> {
  try {
    const raw = await readFile(config.PANEL_POOL_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PanelPoolStoreFile>;
    if (parsed && typeof parsed === "object" && parsed.contexts && typeof parsed.contexts === "object") {
      return { contexts: parsed.contexts as Record<string, PanelPoolMod[]> };
    }
    return { contexts: {} };
  } catch {
    return { contexts: {} };
  }
}

async function writeStore(store: PanelPoolStoreFile): Promise<void> {
  const filePath = config.PANEL_POOL_STORE_PATH;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2), "utf8");
}

export async function getPanelPool(serverId: string, configPath: string): Promise<PanelPoolMod[]> {
  const store = await readStore();
  const key = contextKey(serverId, configPath);
  const mods = Array.isArray(store.contexts[key]) ? store.contexts[key] : [];
  return mods
    .filter((mod) => mod && typeof mod.modId === "string" && mod.modId.trim().length > 0)
    .map((mod) => normalizePoolMod(mod));
}

export async function setPanelPool(
  serverId: string,
  configPath: string,
  mods: Array<Partial<PanelPoolMod> & { modId: string }>
): Promise<PanelPoolMod[]> {
  const store = await readStore();
  const key = contextKey(serverId, configPath);
  const map = new Map<string, PanelPoolMod>();
  for (const input of mods) {
    const normalized = normalizePoolMod(input);
    if (!normalized.modId) {
      continue;
    }
    map.set(normalized.modId, normalized);
  }
  const next = Array.from(map.values());
  store.contexts[key] = next;
  await writeStore(store);
  return next;
}

export async function upsertPanelPool(
  serverId: string,
  configPath: string,
  mods: Array<Partial<PanelPoolMod> & { modId: string }>
): Promise<PanelPoolMod[]> {
  const store = await readStore();
  const key = contextKey(serverId, configPath);
  const current = Array.isArray(store.contexts[key]) ? store.contexts[key] : [];
  const map = new Map(current.map((mod) => [String(mod.modId).trim().toUpperCase(), normalizePoolMod(mod)]));

  for (const input of mods) {
    const normalized = normalizePoolMod(input);
    if (!normalized.modId) {
      continue;
    }
    const prev = map.get(normalized.modId);
    map.set(normalized.modId, {
      modId: normalized.modId,
      name: normalized.name ?? prev?.name,
      version: normalized.version ?? prev?.version,
      required: normalized.required,
      contentType: normalized.contentType ?? prev?.contentType ?? "mod"
    });
  }

  const next = Array.from(map.values());
  store.contexts[key] = next;
  await writeStore(store);
  return next;
}

export async function removePanelPoolMods(
  serverId: string,
  configPath: string,
  modIDs: string[]
): Promise<PanelPoolMod[]> {
  const store = await readStore();
  const key = contextKey(serverId, configPath);
  const current = Array.isArray(store.contexts[key]) ? store.contexts[key] : [];
  const removeSet = new Set(modIDs.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean));
  const next = current
    .map((mod) => normalizePoolMod(mod))
    .filter((mod) => !removeSet.has(mod.modId));
  store.contexts[key] = next;
  await writeStore(store);
  return next;
}
