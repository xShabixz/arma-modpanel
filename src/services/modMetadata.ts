import { existsSync } from "node:fs";
import AdmZip from "adm-zip";
import { ScannedMod, ModDependency } from "./types.js";

function normalizeVersionRange(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function fabricDependencies(raw: Record<string, unknown> | undefined): ModDependency[] {
  if (!raw) {
    return [];
  }

  const deps: ModDependency[] = [];
  for (const [id, range] of Object.entries(raw)) {
    if (["minecraft", "fabricloader", "java"].includes(id)) {
      continue;
    }

    deps.push({
      id,
      required: true,
      versionRange: normalizeVersionRange(range)
    });
  }

  return deps;
}

function parseModsToml(content: string): {
  modId?: string;
  version?: string;
  displayName?: string;
  dependencies: ModDependency[];
} {
  const lines = content.split(/\r?\n/);
  let modId: string | undefined;
  let version: string | undefined;
  let displayName: string | undefined;
  const dependencies: ModDependency[] = [];

  let inDependencySection = false;
  let currentDep: Partial<ModDependency> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("[[mods]]")) {
      inDependencySection = false;
      continue;
    }

    if (line.startsWith("[[dependencies.")) {
      if (currentDep.id) {
        dependencies.push({
          id: currentDep.id,
          required: currentDep.required ?? true,
          versionRange: currentDep.versionRange
        });
      }
      currentDep = {};
      inDependencySection = true;
      continue;
    }

    const kvMatch = line.match(/^(\w+)\s*=\s*"?([^"\n]+)"?$/);
    if (!kvMatch) {
      continue;
    }

    const [, key, value] = kvMatch;

    if (!inDependencySection) {
      if (key === "modId") modId = value;
      if (key === "version") version = value;
      if (key === "displayName") displayName = value;
      continue;
    }

    if (key === "modId") currentDep.id = value;
    if (key === "mandatory") currentDep.required = value === "true";
    if (key === "versionRange") currentDep.versionRange = value;
  }

  if (currentDep.id) {
    dependencies.push({
      id: currentDep.id,
      required: currentDep.required ?? true,
      versionRange: currentDep.versionRange
    });
  }

  return { modId, version, displayName, dependencies };
}

function parsePluginYml(content: string): {
  name: string;
  version: string;
  dependencies: ModDependency[];
} {
  const name = content.match(/^name:\s*(.+)$/im)?.[1]?.trim() ?? "unknown-plugin";
  const version = content.match(/^version:\s*(.+)$/im)?.[1]?.trim() ?? "unknown";

  const dependsMatch = content.match(/^depend:\s*\[(.+)]$/im);
  const softDependsMatch = content.match(/^softdepend:\s*\[(.+)]$/im);

  const splitCsv = (value: string | undefined): string[] =>
    value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];

  const dependencies: ModDependency[] = [
    ...splitCsv(dependsMatch?.[1]).map((id) => ({ id, required: true })),
    ...splitCsv(softDependsMatch?.[1]).map((id) => ({ id, required: false }))
  ];

  return { name, version, dependencies };
}

export function scanModJar(jarPath: string): ScannedMod {
  if (!existsSync(jarPath)) {
    throw new Error(`JAR not found: ${jarPath}`);
  }

  const zip = new AdmZip(jarPath);

  const fabricEntry = zip.getEntry("fabric.mod.json");
  if (fabricEntry) {
    const raw = JSON.parse(fabricEntry.getData().toString("utf8")) as Record<string, unknown>;
    return {
      id: String(raw.id ?? "unknown"),
      name: String(raw.name ?? raw.id ?? "unknown"),
      version: String(raw.version ?? "unknown"),
      loader: "fabric",
      dependencies: fabricDependencies(raw.depends as Record<string, unknown> | undefined)
    };
  }

  const quiltEntry = zip.getEntry("quilt.mod.json");
  if (quiltEntry) {
    const raw = JSON.parse(quiltEntry.getData().toString("utf8")) as Record<string, unknown>;
    const quiltLoader = raw.quilt_loader as Record<string, unknown> | undefined;
    const depends = (quiltLoader?.depends ?? []) as Array<Record<string, unknown>>;
    return {
      id: String((quiltLoader?.id as string | undefined) ?? "unknown"),
      name: String((quiltLoader?.metadata as Record<string, unknown> | undefined)?.name ?? "unknown"),
      version: String(quiltLoader?.version ?? "unknown"),
      loader: "quilt",
      dependencies: depends
        .map((dep) => ({
          id: String(dep.id ?? ""),
          required: true,
          versionRange: normalizeVersionRange(dep.versions)
        }))
        .filter((dep) => dep.id)
    };
  }

  const modsTomlEntry = zip.getEntry("META-INF/mods.toml");
  if (modsTomlEntry) {
    const parsed = parseModsToml(modsTomlEntry.getData().toString("utf8"));
    return {
      id: parsed.modId ?? "unknown",
      name: parsed.displayName ?? parsed.modId ?? "unknown",
      version: parsed.version ?? "unknown",
      loader: "forge",
      dependencies: parsed.dependencies.filter((dep) => dep.id !== "minecraft" && dep.id !== "forge")
    };
  }

  const pluginYmlEntry = zip.getEntry("plugin.yml");
  if (pluginYmlEntry) {
    const parsed = parsePluginYml(pluginYmlEntry.getData().toString("utf8"));
    return {
      id: parsed.name.toLowerCase().replace(/\s+/g, "-"),
      name: parsed.name,
      version: parsed.version,
      loader: "paper",
      dependencies: parsed.dependencies
    };
  }

  return {
    id: "unknown",
    name: "unknown",
    version: "unknown",
    loader: "unknown",
    dependencies: []
  };
}
