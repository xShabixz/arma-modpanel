import axios, { AxiosInstance } from "axios";
import { config } from "../config.js";
import { LoaderType } from "./types.js";

interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  game_versions: string[];
  loaders: string[];
  files: ModrinthVersionFile[];
}

interface SearchHit {
  project_id: string;
  slug: string;
  title: string;
}

interface SearchResponse {
  hits: SearchHit[];
}

export class ModrinthClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.MODRINTH_API_BASE_URL,
      timeout: 15000,
      headers: {
        "User-Agent": "ptero-mod-manager/0.1.0"
      }
    });
  }

  async findProjectIdByDependencyId(dependencyId: string): Promise<string | null> {
    const facets = JSON.stringify([[`project_type:mod`]]);
    const { data } = await this.http.get<SearchResponse>("/search", {
      params: {
        query: dependencyId,
        limit: 10,
        facets
      }
    });

    const exact = data.hits.find((hit) =>
      hit.slug.toLowerCase() === dependencyId.toLowerCase() ||
      hit.title.toLowerCase() === dependencyId.toLowerCase()
    );

    return exact?.project_id ?? data.hits[0]?.project_id ?? null;
  }

  async findCompatibleVersion(
    projectId: string,
    minecraftVersion: string,
    loader: LoaderType
  ): Promise<{
    projectId: string;
    versionId: string;
    fileName: string;
    downloadUrl: string;
  } | null> {
    const { data } = await this.http.get<ModrinthVersion[]>(`/project/${projectId}/version`);

    const compatible = data.find(
      (version) =>
        version.game_versions.includes(minecraftVersion) &&
        version.loaders.includes(loader)
    );

    if (!compatible) {
      return null;
    }

    const selectedFile = compatible.files.find((file) => file.primary) ?? compatible.files[0];
    if (!selectedFile) {
      return null;
    }

    return {
      projectId: compatible.project_id,
      versionId: compatible.id,
      fileName: selectedFile.filename,
      downloadUrl: selectedFile.url
    };
  }
}
