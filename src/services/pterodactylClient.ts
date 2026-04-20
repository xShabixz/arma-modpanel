import axios, { AxiosInstance } from "axios";
import { config } from "../config.js";

function formatAxiosError(error: unknown, fallback: string): Error {
  if (!axios.isAxiosError(error)) {
    return new Error(fallback);
  }

  const axiosError = error as {
    response?: {
      status?: number;
      data?: unknown;
    };
    message: string;
  };
  const status = axiosError.response?.status;
  const responseData =
    typeof axiosError.response?.data === "string"
      ? axiosError.response.data
      : JSON.stringify(axiosError.response?.data ?? {});

  const detail = status
    ? `${fallback} (status=${status}, response=${responseData})`
    : `${fallback} (${axiosError.message})`;

  return new Error(detail);
}

export class PterodactylClient {
  private readonly http: AxiosInstance;

  constructor() {
    if (!config.PTERODACTYL_BASE_URL || !config.PTERODACTYL_API_KEY) {
      throw new Error("Missing Pterodactyl configuration. Set PTERODACTYL_BASE_URL and PTERODACTYL_API_KEY");
    }

    this.http = axios.create({
      baseURL: config.PTERODACTYL_BASE_URL,
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${config.PTERODACTYL_API_KEY}`,
        Accept: "Application/vnd.pterodactyl.v1+json",
        "Content-Type": "application/json"
      }
    });
  }

  async restartServer(serverId: string): Promise<void> {
    try {
      if (config.PTERODACTYL_API_KIND === "client") {
        await this.http.post(`/api/client/servers/${serverId}/power`, {
          signal: "restart"
        });
        return;
      }

      await this.http.post(`/api/application/servers/${serverId}/power`, {
        signal: "restart"
      });
    } catch (error) {
      throw formatAxiosError(error, "Failed to restart server via Pterodactyl");
    }
  }

  async readServerFile(serverId: string, filePath: string): Promise<string> {
    if (config.PTERODACTYL_API_KIND !== "client") {
      throw new Error("readServerFile requires PTERODACTYL_API_KIND=client");
    }

    try {
      const response = await this.http.get<string>(
        `/api/client/servers/${serverId}/files/contents`,
        {
          params: {
            file: filePath
          },
          responseType: "text"
        }
      );

      return response.data;
    } catch (error) {
      throw formatAxiosError(
        error,
        `Failed to read file '${filePath}' from server '${serverId}'`
      );
    }
  }

  async writeServerFile(serverId: string, filePath: string, content: string): Promise<void> {
    if (config.PTERODACTYL_API_KIND !== "client") {
      throw new Error("writeServerFile requires PTERODACTYL_API_KIND=client");
    }

    try {
      await this.http.post(`/api/client/servers/${serverId}/files/write`, content, {
        params: {
          file: filePath
        },
        headers: {
          "Content-Type": "text/plain"
        }
      });
    } catch (error) {
      throw formatAxiosError(
        error,
        `Failed to write file '${filePath}' on server '${serverId}'`
      );
    }
  }

  async readServerStartup(serverId: string): Promise<unknown> {
    if (config.PTERODACTYL_API_KIND !== "client") {
      throw new Error("readServerStartup requires PTERODACTYL_API_KIND=client");
    }

    try {
      const response = await this.http.get(`/api/client/servers/${serverId}/startup`);
      return response.data;
    } catch (error) {
      throw formatAxiosError(
        error,
        `Failed to read startup metadata for server '${serverId}'`
      );
    }
  }

  async getServerWebsocket(serverId: string): Promise<{ token: string; socket: string }> {
    if (config.PTERODACTYL_API_KIND !== "client") {
      throw new Error("getServerWebsocket requires PTERODACTYL_API_KIND=client");
    }

    try {
      const response = await this.http.get(`/api/client/servers/${serverId}/websocket`);
      return {
        token: String(response.data?.data?.token ?? ""),
        socket: String(response.data?.data?.socket ?? "")
      };
    } catch (error) {
      throw formatAxiosError(
        error,
        `Failed to read websocket details for server '${serverId}'`
      );
    }
  }

  async getServerConsoleSnapshot(
    serverId: string,
    limit = 80,
    timeoutMs = 2500
  ): Promise<{ state: string; lines: string[] }> {
    if (config.PTERODACTYL_API_KIND !== "client") {
      throw new Error("getServerConsoleSnapshot requires PTERODACTYL_API_KIND=client");
    }

    const details = await this.getServerWebsocket(serverId);
    const socketUrl = String(details.socket).replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const lines: string[] = [];
    let state = "connecting";

    type ConsoleSocket = {
      send(data: string): void;
      close(): void;
      onopen: ((event: unknown) => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: ((event: unknown) => void) | null;
      onclose: ((event: unknown) => void) | null;
    };

    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => ConsoleSocket }).WebSocket;

    if (!WebSocketCtor) {
      throw new Error("WebSocket is not available in this Node.js runtime");
    }

    return await new Promise((resolve, reject) => {
      const socket = new WebSocketCtor(socketUrl);
      const startedAt = Date.now();
      let finished = false;

      const finish = (result: { state: string; lines: string[] } | Error) => {
        if (finished) {
          return;
        }
        finished = true;
        try {
          socket.close();
        } catch {
          // ignore close failures while resolving the snapshot
        }

        if (result instanceof Error) {
          reject(result);
          return;
        }

        resolve(result);
      };

      const timer = (globalThis as any).setTimeout(() => {
        finish({ state, lines: lines.slice(-limit) });
      }, timeoutMs);

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ event: "auth", args: [details.token] }));
        } catch (error) {
          (globalThis as any).clearTimeout(timer);
          finish(error instanceof Error ? error : new Error("Failed to send websocket auth"));
        }
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          const eventName = String(payload?.event || "").toLowerCase();
          const args = Array.isArray(payload?.args) ? payload.args : [];
          const message = args.map((value: unknown) => String(value)).join("");

          if (eventName === "auth success") {
            state = "connected";
            socket.send(JSON.stringify({ event: "send logs", args: [] }));
            return;
          }

          if (eventName === "daemon error") {
            lines.push(message || "Daemon error");
            return;
          }

          if (
            eventName === "console output" ||
            eventName === "install output" ||
            eventName === "transfer logs" ||
            eventName === "daemon message"
          ) {
            lines.push(message || "[empty]");
            if (lines.length > limit) {
              lines.splice(0, lines.length - limit);
            }
            return;
          }

          if (eventName === "jwt error") {
            (globalThis as any).clearTimeout(timer);
            finish(new Error(message || "Wings rejected the websocket token"));
          }
        } catch {
          // Ignore malformed messages; just keep collecting the good ones.
        }

        if (Date.now() - startedAt > timeoutMs) {
          (globalThis as any).clearTimeout(timer);
          finish({ state, lines: lines.slice(-limit) });
        }
      };

      socket.onerror = () => {
        (globalThis as any).clearTimeout(timer);
        finish({ state: "error", lines: lines.slice(-limit) });
      };

      socket.onclose = () => {
        (globalThis as any).clearTimeout(timer);
        finish({ state, lines: lines.slice(-limit) });
      };
    });
  }
}
