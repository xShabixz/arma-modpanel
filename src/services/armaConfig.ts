import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

export interface ArmaServerMod {
  modId: string;
  modID?: string;
  name?: string;
  version?: string;
  required?: boolean;
  contentType?: "mod" | "game";
}

type RawArmaServerMod = (ArmaServerMod & Record<string, unknown>) | string;

interface ArmaServerConfig {
  game?: {
    mods?: RawArmaServerMod[];
  };
  mods?: RawArmaServerMod[];
  [key: string]: unknown;
}

const ARMA_VERSION_PATTERN = /^\d{1,10}\.\d{1,10}\.\d{1,10}$/;

function normalizeArmaVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return ARMA_VERSION_PATTERN.test(trimmed) ? trimmed : undefined;
}

function normalizeContentType(value: unknown): "mod" | "game" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (trimmed === "mod" || trimmed === "game") {
    return trimmed;
  }

  return undefined;
}

function sanitizeModVersionEntry(mod: RawArmaServerMod): RawArmaServerMod {
  if (typeof mod === "string") {
    return mod;
  }

  const normalizedVersion = normalizeArmaVersion(mod.version);
  if (normalizedVersion) {
    if (mod.version === normalizedVersion) {
      return mod;
    }

    return {
      ...mod,
      version: normalizedVersion
    };
  }

  if (!("version" in mod)) {
    return mod;
  }

  const sanitized = { ...mod };
  delete sanitized.version;
  return sanitized;
}

function getModIdentifier(mod: Partial<ArmaServerMod> | string): string {
  if (typeof mod === "string") {
    return mod.trim();
  }

  return String(mod.modId ?? mod.modID ?? "").trim();
}

function toStoredMod(mod: Partial<ArmaServerMod> | string): ArmaServerMod {
  if (typeof mod === "string") {
    const modId = mod.trim();
    if (!modId) {
      throw new Error("Each mod entry must include modId (or modID)");
    }

    return { modId };
  }

  const modId = getModIdentifier(mod);
  if (!modId) {
    throw new Error("Each mod entry must include modId (or modID)");
  }

  const stored: ArmaServerMod = {
    modId,
    name: mod.name,
    version: normalizeArmaVersion(mod.version),
    required: mod.required
  };

  const contentType = normalizeContentType(mod.contentType);
  if (contentType) {
    stored.contentType = contentType;
  }

  return stored;
}

function ensureGameMods(config: ArmaServerConfig): RawArmaServerMod[] {
  if (!config.game) {
    config.game = {};
  }

  if (!Array.isArray(config.game.mods)) {
    if (Array.isArray(config.mods)) {
      config.game.mods = config.mods;
    } else {
      config.game.mods = [];
    }
  }

  config.game.mods = config.game.mods.map((mod) => sanitizeModVersionEntry(mod));

  return config.game.mods;
}

export function parseServerConfig(raw: string): ArmaServerConfig {
  return JSON.parse(raw) as ArmaServerConfig;
}

export function serializeServerConfig(config: ArmaServerConfig): string {
  return JSON.stringify(config, null, 2);
}

export function listModsFromConfig(config: ArmaServerConfig): ArmaServerMod[] {
  return ensureGameMods(config).map((mod) => toStoredMod(mod));
}

export function upsertModsInConfig(
  config: ArmaServerConfig,
  modsToUpsert: ArmaServerMod[]
): ArmaServerMod[] {
  const mods = ensureGameMods(config);

  const modIndex = new Map<string, number>();
  mods.forEach((mod, index) => {
    const id = getModIdentifier(mod);
    if (id) {
      modIndex.set(id, index);
    }
  });

  for (const mod of modsToUpsert) {
    const normalized = toStoredMod(mod);
    const existing = modIndex.get(normalized.modId);

    if (existing === undefined) {
      mods.push(normalized as RawArmaServerMod);
      modIndex.set(normalized.modId, mods.length - 1);
      continue;
    }

    const current = mods[existing];
    const currentObject = typeof current === "string" ? {} : current;
    const merged: ArmaServerMod = {
      ...currentObject,
      ...normalized
    };
    delete merged.modID;

    mods[existing] = merged as RawArmaServerMod;
  }

  return listModsFromConfig(config);
}

export function removeModsFromConfig(config: ArmaServerConfig, modIDs: string[]): ArmaServerMod[] {
  const mods = ensureGameMods(config);
  const removeSet = new Set(modIDs);

  config.game!.mods = mods.filter((mod) => !removeSet.has(getModIdentifier(mod)));
  return listModsFromConfig(config);
}

export async function loadServerConfig(configPath: string): Promise<ArmaServerConfig> {
  if (!existsSync(configPath)) {
    throw new Error(`Server config not found: ${configPath}`);
  }

  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw) as ArmaServerConfig;
}

export async function saveServerConfig(configPath: string, config: ArmaServerConfig): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

export async function listMods(configPath: string): Promise<ArmaServerMod[]> {
  const config = await loadServerConfig(configPath);
  return listModsFromConfig(config);
}

export async function addOrUpdateMods(
  configPath: string,
  modsToUpsert: ArmaServerMod[]
): Promise<ArmaServerMod[]> {
  const config = await loadServerConfig(configPath);
  const mods = upsertModsInConfig(config, modsToUpsert);

  await saveServerConfig(configPath, config);
  return mods;
}

export async function removeMods(configPath: string, modIDs: string[]): Promise<ArmaServerMod[]> {
  const config = await loadServerConfig(configPath);
  const updatedMods = removeModsFromConfig(config, modIDs);
  await saveServerConfig(configPath, config);

  return updatedMods;
}

export function detectMissingDependencies(
  installedMods: ArmaServerMod[],
  dependencyMap: Record<string, string[]>
): Array<{ modId: string; missing: string[] }> {
  const installedSet = new Set(installedMods.map((mod) => mod.modId));
  const result: Array<{ modId: string; missing: string[] }> = [];

  for (const mod of installedMods) {
    const deps = dependencyMap[mod.modId] ?? [];
    const missing = deps.filter((dep) => !installedSet.has(dep));
    if (missing.length > 0) {
      result.push({ modId: mod.modId, missing });
    }
  }

  return result;
}
