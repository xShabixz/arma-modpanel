export type LoaderType = "fabric" | "forge" | "neoforge" | "quilt" | "paper";

export interface ModDependency {
  id: string;
  required: boolean;
  versionRange?: string;
}

export interface ScannedMod {
  id: string;
  name: string;
  version: string;
  loader: LoaderType | "unknown";
  dependencies: ModDependency[];
}

export interface ResolveRequest {
  minecraftVersion: string;
  loader: LoaderType;
}

export interface ResolveResult {
  scannedMod: ScannedMod;
  missing: ModDependency[];
  resolved: Array<{
    dependencyId: string;
    projectId: string;
    versionId: string;
    fileName: string;
    downloadUrl: string;
  }>;
  unresolved: ModDependency[];
}
