import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import axios from "axios";
import { resolveMissingDependencies } from "./dependencyResolver.js";
import { ResolveRequest } from "./types.js";
import { scanModJar } from "./modMetadata.js";

interface InstallOptions {
  jarPath: string;
  modsDir: string;
  resolveRequest: ResolveRequest;
  installedIds?: string[];
  continueOnUnresolved?: boolean;
}

interface InstalledFile {
  dependencyId: string;
  fileName: string;
  targetPath: string;
}

export interface InstallResult {
  scannedMod: ReturnType<typeof scanModJar>;
  missingCount: number;
  unresolvedCount: number;
  installedFiles: InstalledFile[];
  unresolvedDependencies: string[];
}

async function downloadFile(url: string, outPath: string): Promise<void> {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 30000
  });

  await new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(outPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

export async function installResolvedDependencies(options: InstallOptions): Promise<InstallResult> {
  if (!existsSync(options.modsDir)) {
    throw new Error(`modsDir not found: ${options.modsDir}`);
  }

  const scannedMod = scanModJar(options.jarPath);
  const resolution = await resolveMissingDependencies(
    scannedMod,
    options.resolveRequest,
    options.installedIds ?? []
  );

  if (!options.continueOnUnresolved && resolution.unresolved.length > 0) {
    throw new Error(
      `Unresolved dependencies: ${resolution.unresolved.map((dep) => dep.id).join(", ")}`
    );
  }

  const tmpBase = await mkdtemp(path.join(tmpdir(), "ptero-mod-manager-"));
  const stagingDir = path.join(tmpBase, "staging");
  await mkdir(stagingDir, { recursive: true });

  const installedFiles: InstalledFile[] = [];
  const copiedPaths: string[] = [];

  try {
    for (const item of resolution.resolved) {
      const stagedPath = path.join(stagingDir, item.fileName);
      await downloadFile(item.downloadUrl, stagedPath);

      const targetPath = path.join(options.modsDir, item.fileName);
      await cp(stagedPath, targetPath, { force: true });

      copiedPaths.push(targetPath);
      installedFiles.push({
        dependencyId: item.dependencyId,
        fileName: item.fileName,
        targetPath
      });
    }

    return {
      scannedMod,
      missingCount: resolution.missing.length,
      unresolvedCount: resolution.unresolved.length,
      installedFiles,
      unresolvedDependencies: resolution.unresolved.map((dep) => dep.id)
    };
  } catch (error) {
    await Promise.all(
      copiedPaths.map(async (copiedPath) => {
        await rm(copiedPath, { force: true });
      })
    );
    throw error;
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
}
