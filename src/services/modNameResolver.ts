import axios from "axios";
import { config } from "../config.js";

export interface ModNameResolution {
  name?: string;
  version?: string;
  dependencies?: string[];
  source: "steam" | "reforger" | "custom-template" | "unresolved";
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

function sanitizeTitle(input: string): string {
  return input
    .replace(/\s*\|\s*Arma Reforger.*$/i, "")
    .replace(/\s*-\s*Arma Reforger.*$/i, "")
    .trim();
}

function isLikelyReforgerModId(modId: string): boolean {
  return /^[A-F0-9]{16}$/i.test(modId);
}

function normalizeWorkshopBaseUrl(): string {
  return "https://reforger.armaplatform.com";
}

function normalizeDependencyIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const dependencies = value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }

      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as Record<string, unknown>;
      const candidate =
        record.id ??
        record.modId ??
        record.modID ??
        record.publishedfileid ??
        record.publishedFileId ??
        record.dependencyId;

      return typeof candidate === "string" ? candidate.trim() : "";
    })
    .filter((value) => value.length > 0);

  return Array.from(new Set(dependencies));
}

function extractDependencies(source: unknown): string[] {
  if (!source || typeof source !== "object") {
    return [];
  }

  const record = source as Record<string, unknown>;
  const candidates = [
    record.dependencies,
    record.dependencyIds,
    record.requiredDependencies,
    record.children,
    record.deps
  ];

  return Array.from(new Set(candidates.flatMap((candidate) => normalizeDependencyIds(candidate))));
}

async function resolveFromSteam(
  modId: string
): Promise<{ name?: string; version?: string; dependencies?: string[] }> {
  if (!/^\d+$/.test(modId)) {
    return {};
  }

  const body = new URLSearchParams();
  body.set("itemcount", "1");
  body.set("publishedfileids[0]", modId);

  const response = await axios.post(
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
    body,
    {
      timeout: 8000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  const details = response.data?.response?.publishedfiledetails;
  if (!Array.isArray(details) || details.length === 0) {
    return {};
  }

  const first = details[0] ?? {};
  const title = String(first?.title ?? "").trim() || undefined;

  return {
    name: title,
    dependencies: extractDependencies(first)
  };
}

async function resolveFromTemplate(
  modId: string
): Promise<{ name?: string; version?: string; dependencies?: string[] }> {
  const template = config.MOD_NAME_LOOKUP_URL_TEMPLATE;
  if (!template) {
    return {};
  }

  const encoded = encodeURIComponent(modId);
  const url = template
    .replaceAll("{modId}", modId)
    .replaceAll("{modIdEncoded}", encoded);

  const response = await axios.get<string>(url, {
    timeout: 8000,
    responseType: "text",
    headers: {
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8"
    }
  });

  const data = String(response.data ?? "");
  const trimmed = data.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const dependencies = extractDependencies(parsed);
      const version = normalizeArmaVersion(parsed.version);
      const nameValue = parsed.name ?? parsed.title ?? parsed.displayName;

      if (typeof nameValue === "string" && nameValue.trim()) {
        return {
          name: sanitizeTitle(nameValue),
          version,
          dependencies
        };
      }

      return {
        version,
        dependencies
      };
    } catch {
      // Fall back to HTML/text parsing below.
    }
  }

  let version: string | undefined;
  const jsonVersionMatch = data.match(/"version"\s*:\s*"([^\"]+)"/i);
  if (jsonVersionMatch?.[1]) {
    version = normalizeArmaVersion(jsonVersionMatch[1]);
  }

  const jsonNameMatch = data.match(/"name"\s*:\s*"([^\"]+)"/i);
  if (jsonNameMatch?.[1]) {
    return {
      name: sanitizeTitle(jsonNameMatch[1]),
      version
    };
  }

  const ogMatch = data.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (ogMatch?.[1]) {
    return {
      name: sanitizeTitle(ogMatch[1]),
      version
    };
  }

  const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch?.[1]) {
    return {
      name: sanitizeTitle(titleMatch[1]),
      version
    };
  }

  return { version };
}

async function resolveFromReforgerApi(
  modId: string
): Promise<{ name?: string; version?: string; dependencies?: string[] }> {
  if (!isLikelyReforgerModId(modId)) {
    return {};
  }

  const baseUrl = config.REFORGER_MODS_API_BASE_URL.replace(/\/+$/, "");
  const response = await axios.get(`${baseUrl}/mod/${encodeURIComponent(modId)}`, {
    timeout: 8000,
    responseType: "text",
    headers: {
      Accept: "application/json,text/plain,*/*"
    }
  });

  const data = String(response.data ?? "").trim();
  if (!data) {
    return {};
  }

  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const nameValue = parsed.name ?? parsed.title ?? parsed.displayName ?? parsed.modName;
    const version = normalizeArmaVersion(parsed.version ?? parsed.modVersion ?? parsed.buildVersion);
    const dependencies = extractDependencies(parsed);

    if (typeof nameValue === "string" && nameValue.trim()) {
      return {
        name: sanitizeTitle(nameValue),
        version,
        dependencies
      };
    }

    const idValue = parsed.id ?? parsed.modId ?? parsed.modID;
    if (typeof idValue === "string" && idValue.trim()) {
      return {
        version,
        dependencies
      };
    }

    return {
      version,
      dependencies
    };
  } catch {
    const nameMatch = data.match(/"(?:name|title|displayName|modName)"\s*:\s*"([^\"]+)"/i);
    const versionMatch = data.match(/"(?:version|modVersion|buildVersion)"\s*:\s*"([^\"]+)"/i);

    if (nameMatch?.[1] || versionMatch?.[1]) {
      return {
        name: nameMatch?.[1] ? sanitizeTitle(nameMatch[1]) : undefined,
        version: normalizeArmaVersion(versionMatch?.[1])
      };
    }

    const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) {
      return {
        name: sanitizeTitle(titleMatch[1])
      };
    }

    return {};
  }
}

async function resolveFromReforgerWorkshop(
  modId: string
): Promise<{ name?: string; version?: string; dependencies?: string[] }> {
  if (!isLikelyReforgerModId(modId)) {
    return {};
  }

  const baseUrl = normalizeWorkshopBaseUrl();
  const response = await axios.get(`${baseUrl}/workshop/${encodeURIComponent(modId)}`, {
    timeout: 8000,
    responseType: "text",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  const data = String(response.data ?? "");
  if (!data.trim()) {
    return {};
  }

  const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
  const headingMatch = data.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const versionMatch = data.match(/<dt>\s*Version\s*<\/dt>\s*<dd>\s*([^<]+)\s*<\/dd>/i);
  const gameVersionMatch = data.match(/<dt>\s*Game Version\s*<\/dt>\s*<dd>\s*([^<]+)\s*<\/dd>/i);

  const nameCandidate = headingMatch?.[1] ?? titleMatch?.[1];
  const name = typeof nameCandidate === "string" && nameCandidate.trim() ? sanitizeTitle(nameCandidate) : undefined;
  const version = normalizeArmaVersion(versionMatch?.[1] ?? gameVersionMatch?.[1]);

  if (name || version) {
    return {
      name,
      version
    };
  }

  return {};
}

export async function resolveModName(modId: string): Promise<ModNameResolution> {
  const id = modId.trim();
  if (!id) {
    return { source: "unresolved" };
  }

  try {
    const steamMeta = await resolveFromSteam(id);
    if (steamMeta.name || steamMeta.version || (steamMeta.dependencies?.length ?? 0) > 0) {
      return {
        name: steamMeta.name,
        version: steamMeta.version,
        dependencies: steamMeta.dependencies,
        source: "steam"
      };
    }
  } catch {
    // ignore and continue to other sources
  }

  try {
    const templateMeta = await resolveFromTemplate(id);
    if (templateMeta.name || templateMeta.version || (templateMeta.dependencies?.length ?? 0) > 0) {
      return {
        name: templateMeta.name,
        version: templateMeta.version,
        dependencies: templateMeta.dependencies,
        source: "custom-template"
      };
    }
  } catch {
    // ignore and return unresolved
  }

  try {
    const reforgerMeta = await resolveFromReforgerWorkshop(id);
    if (reforgerMeta.name || reforgerMeta.version || (reforgerMeta.dependencies?.length ?? 0) > 0) {
      return {
        name: reforgerMeta.name,
        version: reforgerMeta.version,
        dependencies: reforgerMeta.dependencies,
        source: "reforger"
      };
    }
  } catch {
    // ignore and return unresolved
  }

  try {
    const reforgerMeta = await resolveFromReforgerApi(id);
    if (reforgerMeta.name || reforgerMeta.version || (reforgerMeta.dependencies?.length ?? 0) > 0) {
      return {
        name: reforgerMeta.name,
        version: reforgerMeta.version,
        dependencies: reforgerMeta.dependencies,
        source: "reforger"
      };
    }
  } catch {
    // ignore and return unresolved
  }

  return { source: "unresolved" };
}
