import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";

export type AuditAction = "add" | "update" | "remove";

export interface AuditModSnapshot {
  modId: string;
  name?: string;
  version?: string;
  required?: boolean;
  contentType?: "mod" | "game";
}

export interface AuditChange {
  action: AuditAction;
  modId: string;
  before?: AuditModSnapshot;
  after?: AuditModSnapshot;
}

export interface AuditLogEntry {
  timestamp: string;
  event: "mods-upsert" | "mods-remove";
  scope: "panel" | "api" | "pterodactyl";
  serverId?: string;
  configPath: string;
  restartAfterInstall?: boolean;
  changes: AuditChange[];
}

function normalizeSnapshot(mod: AuditModSnapshot): AuditModSnapshot {
  return {
    modId: mod.modId,
    name: mod.name,
    version: mod.version,
    required: mod.required,
    contentType: mod.contentType
  };
}

function snapshotKey(mod: AuditModSnapshot): string {
  return mod.modId.trim().toUpperCase();
}

export function buildAuditChanges(
  beforeMods: AuditModSnapshot[],
  afterMods: AuditModSnapshot[]
): AuditChange[] {
  const beforeMap = new Map(beforeMods.map((mod) => [snapshotKey(mod), normalizeSnapshot(mod)]));
  const afterMap = new Map(afterMods.map((mod) => [snapshotKey(mod), normalizeSnapshot(mod)]));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changes: AuditChange[] = [];

  for (const key of keys) {
    const before = beforeMap.get(key);
    const after = afterMap.get(key);

    if (!before && after) {
      changes.push({ action: "add", modId: after.modId, after });
      continue;
    }

    if (before && !after) {
      changes.push({ action: "remove", modId: before.modId, before });
      continue;
    }

    if (before && after) {
      const beforeJson = JSON.stringify(before);
      const afterJson = JSON.stringify(after);
      if (beforeJson !== afterJson) {
        changes.push({ action: "update", modId: after.modId, before, after });
      }
    }
  }

  return changes;
}

export async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  const filePath = config.MOD_AUDIT_LOG_PATH;
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  const filePath = config.MOD_AUDIT_LOG_PATH;
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const entries = lines
      .map((line) => {
        try {
          return JSON.parse(line) as AuditLogEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is AuditLogEntry => Boolean(entry));

    return entries.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}