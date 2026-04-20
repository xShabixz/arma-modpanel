import { ModrinthClient } from "./modrinthClient.js";
import { ModDependency, ResolveRequest, ResolveResult, ScannedMod } from "./types.js";

export async function resolveMissingDependencies(
  scannedMod: ScannedMod,
  request: ResolveRequest,
  installedIds: string[] = []
): Promise<ResolveResult> {
  const modrinth = new ModrinthClient();
  const installedSet = new Set(installedIds.map((id) => id.toLowerCase()));

  const missing = scannedMod.dependencies.filter(
    (dep) => dep.required && !installedSet.has(dep.id.toLowerCase())
  );

  const resolved: ResolveResult["resolved"] = [];
  const unresolved: ModDependency[] = [];

  for (const dep of missing) {
    const projectId = await modrinth.findProjectIdByDependencyId(dep.id);
    if (!projectId) {
      unresolved.push(dep);
      continue;
    }

    const version = await modrinth.findCompatibleVersion(
      projectId,
      request.minecraftVersion,
      request.loader
    );

    if (!version) {
      unresolved.push(dep);
      continue;
    }

    resolved.push({
      dependencyId: dep.id,
      projectId: version.projectId,
      versionId: version.versionId,
      fileName: version.fileName,
      downloadUrl: version.downloadUrl
    });
  }

  return {
    scannedMod,
    missing,
    resolved,
    unresolved
  };
}
