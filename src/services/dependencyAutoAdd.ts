import { ArmaServerMod } from "./armaConfig.js";
import { resolveModName } from "./modNameResolver.js";

function normalizeModId(modId: string): string {
  return modId.trim();
}

function dependencyKey(modId: string): string {
  return normalizeModId(modId).toUpperCase();
}

export async function expandModsWithDependencies(
  mods: ArmaServerMod[],
  existingModIds: Iterable<string> = []
): Promise<ArmaServerMod[]> {
  const queue = [...mods];
  const installedSet = new Set(Array.from(existingModIds, (modId) => dependencyKey(modId)));
  const processedSet = new Set<string>();
  const expanded: ArmaServerMod[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const modId = normalizeModId(current.modId ?? current.modID ?? "");
    if (!modId) {
      continue;
    }

    const key = dependencyKey(modId);
    if (processedSet.has(key)) {
      continue;
    }

    processedSet.add(key);

    let resolved;
    try {
      resolved = await resolveModName(modId);
    } catch {
      resolved = undefined;
    }

    expanded.push({
      modId,
      name: current.name ?? resolved?.name,
      version: current.version ?? resolved?.version,
      required: current.required ?? false,
      contentType: current.contentType
    });

    for (const dependencyId of resolved?.dependencies ?? []) {
      const trimmedDependencyId = dependencyId.trim();
      if (!trimmedDependencyId) {
        continue;
      }

      const dependencyIdKey = dependencyKey(trimmedDependencyId);
      if (processedSet.has(dependencyIdKey) || installedSet.has(dependencyIdKey)) {
        continue;
      }

      queue.push({
        modId: trimmedDependencyId,
        required: true
      });
    }
  }

  return expanded;
}