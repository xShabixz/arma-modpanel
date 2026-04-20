import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import {
  listModsFromConfig,
  parseServerConfig,
  removeModsFromConfig,
  serializeServerConfig,
  upsertModsInConfig
} from "../services/armaConfig.js";
import { appendAuditLog, buildAuditChanges, AuditModSnapshot, readAuditLog } from "../services/auditLog.js";
import { expandModsWithDependencies } from "../services/dependencyAutoAdd.js";
import { resolveModName } from "../services/modNameResolver.js";
import { getPanelPool, removePanelPoolMods, setPanelPool, upsertPanelPool } from "../services/panelPoolStore.js";
import { PterodactylClient } from "../services/pterodactylClient.js";

type PanelModState = "active" | "configured-only" | "runtime-only";

type SyncEventType =
  | "mods-upsert"
  | "mods-remove"
  | "pool-upsert"
  | "pool-remove"
  | "pool-set";

function extractRuntimeModIds(payload: unknown): string[] {
  const runtimeText = JSON.stringify(payload ?? {});
  const ids = runtimeText.match(/\b[A-F0-9]{16}\b/gi) ?? [];
  return Array.from(new Set(ids.map((id) => id.toUpperCase())));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const distViewsDir = resolve(__dirname, "..", "views");
const srcViewsDir = resolve(process.cwd(), "src", "views");
const viewsDir = existsSync(resolve(distViewsDir, "panel.html")) ? distViewsDir : srcViewsDir;

const panelCss = readFileSync(resolve(viewsDir, "panel.css"), "utf8");
const panelHtmlTemplate = readFileSync(resolve(viewsDir, "panel.html"), "utf8")
  .replace("{{CSS}}", panelCss);

export async function panelRoutes(app: FastifyInstance): Promise<void> {
  const syncStreams = new Map<string, Set<FastifyReply>>();

  const resolvePanelTarget = (input: { serverId?: string; configPath?: string }) => ({
    serverId: String(input.serverId || "").trim() || "873122ac",
    configPath: String(input.configPath || "").trim() || "/config.json"
  });

  const syncKey = (serverId: string, configPath: string): string =>
    `${serverId.trim()}::${configPath.trim()}`;

  const emitSync = (
    serverId: string,
    configPath: string,
    event: SyncEventType,
    detail: Record<string, unknown> = {}
  ) => {
    const key = syncKey(serverId, configPath);
    const listeners = syncStreams.get(key);
    if (!listeners || listeners.size === 0) {
      return;
    }

    const data = JSON.stringify({
      event,
      serverId,
      configPath,
      at: new Date().toISOString(),
      ...detail
    });

    for (const streamReply of listeners) {
      try {
        streamReply.raw.write(`event: sync\ndata: ${data}\n\n`);
      } catch {
        listeners.delete(streamReply);
      }
    }

    if (listeners.size === 0) {
      syncStreams.delete(key);
    }
  };

  app.get("/panel", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = z
      .object({
        serverId: z.string().optional(),
        configPath: z.string().optional()
      })
      .parse(request.query);

    const serverId = query.serverId?.trim() || "873122ac";
    const configPath = query.configPath?.trim() || "/config.json";
    let panelCanEdit = false;
    try {
      const client = new PterodactylClient();
      panelCanEdit = Boolean(client);
    } catch {
      panelCanEdit = false;
    }

    reply.type("text/html; charset=utf-8");
    return panelHtmlTemplate
      .replaceAll("__SERVER_ID__", serverId)
      .replaceAll("__CONFIG_PATH__", configPath)
      .replaceAll("__PANEL_CAN_EDIT__", panelCanEdit ? "true" : "false");
  });

  app.get("/panel/api/sync/stream", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z
      .object({
        serverId: z.string().optional(),
        configPath: z.string().optional()
      })
      .default({})
      .parse(request.query ?? {});

    const payload = resolvePanelTarget(parsed);
    const key = syncKey(payload.serverId, payload.configPath);

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    if (typeof reply.raw.flushHeaders === "function") {
      reply.raw.flushHeaders();
    }
    reply.hijack();

    const listeners = syncStreams.get(key) ?? new Set<FastifyReply>();
    listeners.add(reply);
    syncStreams.set(key, listeners);

    const connected = JSON.stringify({
      event: "connected",
      serverId: payload.serverId,
      configPath: payload.configPath,
      at: new Date().toISOString()
    });
    reply.raw.write(`event: connected\ndata: ${connected}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      const bucket = syncStreams.get(key);
      if (!bucket) {
        return;
      }
      bucket.delete(reply);
      if (bucket.size === 0) {
        syncStreams.delete(key);
      }
    });
  });

  const listModsHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
    source: unknown
  ) => {
    const parsed = z
      .object({
        serverId: z.string().optional(),
        configPath: z.string().optional()
      })
      .default({})
      .parse(source ?? {});

    const payload = resolvePanelTarget(parsed);

    try {
      const client = new PterodactylClient();
      const rawConfig = await client.readServerFile(payload.serverId, payload.configPath);
      const parsedConfig = parseServerConfig(rawConfig);
      const configuredMods = listModsFromConfig(parsedConfig);

      let runtimeModIds: string[] = [];
      try {
        const startup = await client.readServerStartup(payload.serverId);
        runtimeModIds = extractRuntimeModIds(startup);
      } catch {
        runtimeModIds = [];
      }

      const runtimeSet = new Set(runtimeModIds.map((id) => id.toUpperCase()));
      const configuredSet = new Set(configuredMods.map((mod) => mod.modId.toUpperCase()));

      const mods = configuredMods.map((mod) => ({
        ...mod,
        state: (runtimeSet.has(mod.modId.toUpperCase())
          ? "active"
          : "configured-only") as PanelModState
      }));

      for (const runtimeId of runtimeSet) {
        if (configuredSet.has(runtimeId)) {
          continue;
        }

        mods.push({
          modId: runtimeId,
          name: "(runtime only)",
          version: "",
          required: false,
          state: "runtime-only" as PanelModState
        });
      }

      const summary = {
        configuredCount: configuredMods.length,
        runtimeCount: runtimeSet.size,
        activeCount: mods.filter((mod) => mod.state === "active").length,
        configuredOnlyCount: mods.filter((mod) => mod.state === "configured-only").length,
        runtimeOnlyCount: mods.filter((mod) => mod.state === "runtime-only").length
      };

      return { mods, runtimeModIds, summary };
    } catch (error) {
      request.log.error(error, "Panel list mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel list mods failed"
      });
    }
  };

  app.post("/panel/api/mods/list", async (request: FastifyRequest, reply: FastifyReply) =>
    listModsHandler(request, reply, request.body)
  );

  app.get("/panel/api/mods/list", async (request: FastifyRequest, reply: FastifyReply) =>
    listModsHandler(request, reply, request.query)
  );

  app.post("/panel/api/mods/resolve", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        modId: z.string().optional(),
        modit: z.string().optional()
      })
      .refine((value: { modId?: string; modit?: string }) => Boolean(value.modId || value.modit), {
        message: "modId is required"
      })
      .parse(request.body);

    try {
      const modId = payload.modId ?? payload.modit!;
      const result = await resolveModName(modId);
      return result;
    } catch (error) {
      request.log.error(error, "Panel resolve mod name failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel resolve mod name failed"
      });
    }
  });

  app.post("/panel/api/server/websocket", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        serverId: z.string().min(1)
      })
      .parse(request.body);

    try {
      const client = new PterodactylClient();
      const websocket = await client.getServerWebsocket(payload.serverId);
      return websocket;
    } catch (error) {
      request.log.error(error, "Panel websocket fetch failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel websocket fetch failed"
      });
    }
  });

  app.post("/panel/api/server/console-snapshot", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        serverId: z.string().min(1),
        limit: z.coerce.number().int().positive().max(250).optional().default(80),
        timeoutMs: z.coerce.number().int().positive().max(10000).optional().default(2500)
      })
      .parse(request.body);

    try {
      const client = new PterodactylClient();
      return await client.getServerConsoleSnapshot(payload.serverId, payload.limit, payload.timeoutMs);
    } catch (error) {
      request.log.error(error, "Panel console snapshot fetch failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel console snapshot fetch failed"
      });
    }
  });

  app.post("/panel/api/mods/upsert", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        serverId: z.string().min(1),
        configPath: z.string().min(1).default("/config.json"),
        autoAddDependencies: z.boolean().optional().default(true),
        restartAfterInstall: z.boolean().optional().default(false),
        mods: z
          .array(
            z.object({
              modId: z.string().min(1),
              name: z.string().optional(),
              version: z.string().optional(),
                required: z.boolean().optional().default(false),
                contentType: z.enum(["mod", "game"]).optional()
            })
          )
          .min(1)
      })
      .parse(request.body);

    try {
      const client = new PterodactylClient();
      const rawConfig = await client.readServerFile(payload.serverId, payload.configPath);
      const parsedConfig = parseServerConfig(rawConfig);
      const currentMods = listModsFromConfig(parsedConfig);
      const beforeMods = currentMods.map((mod) => ({ ...mod }));
      const modsToWrite = payload.autoAddDependencies
        ? await expandModsWithDependencies(
            payload.mods,
            currentMods.map((mod) => mod.modId)
          )
        : payload.mods;
      const mods = upsertModsInConfig(parsedConfig, modsToWrite);

      await client.writeServerFile(payload.serverId, payload.configPath, serializeServerConfig(parsedConfig));
      const changes = buildAuditChanges(beforeMods as AuditModSnapshot[], mods as AuditModSnapshot[]);
      if (changes.length > 0) {
        await appendAuditLog({
          timestamp: new Date().toISOString(),
          event: "mods-upsert",
          scope: "panel",
          configPath: payload.configPath,
          serverId: payload.serverId,
          restartAfterInstall: payload.restartAfterInstall,
          changes
        });
      }

      let restarted = false;
      if (payload.restartAfterInstall) {
        await client.restartServer(payload.serverId);
        restarted = true;
      }

      emitSync(payload.serverId, payload.configPath, "mods-upsert", {
        changedCount: changes.length,
        restarted
      });

      return { mods, restarted };
    } catch (error) {
      request.log.error(error, "Panel upsert mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel upsert mods failed"
      });
    }
  });

  app.post("/panel/api/mods/remove", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        serverId: z.string().min(1),
        configPath: z.string().min(1).default("/config.json"),
        restartAfterInstall: z.boolean().optional().default(false),
        modIDs: z.array(z.string().min(1)).min(1)
      })
      .parse(request.body);

    try {
      const client = new PterodactylClient();
      const rawConfig = await client.readServerFile(payload.serverId, payload.configPath);
      const parsedConfig = parseServerConfig(rawConfig);
      const beforeMods = listModsFromConfig(parsedConfig);
      const mods = removeModsFromConfig(parsedConfig, payload.modIDs);

      await client.writeServerFile(payload.serverId, payload.configPath, serializeServerConfig(parsedConfig));
      const changes = buildAuditChanges(beforeMods as AuditModSnapshot[], mods as AuditModSnapshot[]);
      if (changes.length > 0) {
        await appendAuditLog({
          timestamp: new Date().toISOString(),
          event: "mods-remove",
          scope: "panel",
          configPath: payload.configPath,
          serverId: payload.serverId,
          restartAfterInstall: payload.restartAfterInstall,
          changes
        });
      }

      let restarted = false;
      if (payload.restartAfterInstall) {
        await client.restartServer(payload.serverId);
        restarted = true;
      }

      emitSync(payload.serverId, payload.configPath, "mods-remove", {
        changedCount: changes.length,
        restarted
      });

      return { mods, restarted };
    } catch (error) {
      request.log.error(error, "Panel remove mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel remove mods failed"
      });
    }
  });

  const panelPoolModSchema = z.object({
    modId: z.string().min(1),
    name: z.string().optional(),
    version: z.string().optional(),
    required: z.boolean().optional().default(false),
    contentType: z.enum(["mod", "game"]).optional().default("mod")
  });

  app.post("/panel/api/pool/list", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z
      .object({
        serverId: z.string().optional(),
        configPath: z.string().optional()
      })
      .default({})
      .parse(request.body ?? {});

    const payload = resolvePanelTarget(parsed);
    try {
      const mods = await getPanelPool(payload.serverId, payload.configPath);
      return { mods };
    } catch (error) {
      request.log.error(error, "Panel pool list failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel pool list failed"
      });
    }
  });

  app.post("/panel/api/pool/upsert", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        serverId: z.string().min(1),
        configPath: z.string().min(1).default("/config.json"),
        mods: z.array(panelPoolModSchema).min(1)
      })
      .parse(request.body);

    try {
      const mods = await upsertPanelPool(payload.serverId, payload.configPath, payload.mods);
      emitSync(payload.serverId, payload.configPath, "pool-upsert", {
        changedCount: payload.mods.length
      });
      return { mods };
    } catch (error) {
      request.log.error(error, "Panel pool upsert failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel pool upsert failed"
      });
    }
  });

  app.post("/panel/api/pool/remove", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        serverId: z.string().min(1),
        configPath: z.string().min(1).default("/config.json"),
        modIDs: z.array(z.string().min(1)).min(1)
      })
      .parse(request.body);

    try {
      const mods = await removePanelPoolMods(payload.serverId, payload.configPath, payload.modIDs);
      emitSync(payload.serverId, payload.configPath, "pool-remove", {
        changedCount: payload.modIDs.length
      });
      return { mods };
    } catch (error) {
      request.log.error(error, "Panel pool remove failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel pool remove failed"
      });
    }
  });

  app.post("/panel/api/pool/set", async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = z
      .object({
        serverId: z.string().min(1),
        configPath: z.string().min(1).default("/config.json"),
        mods: z.array(panelPoolModSchema)
      })
      .parse(request.body);

    try {
      const mods = await setPanelPool(payload.serverId, payload.configPath, payload.mods);
      emitSync(payload.serverId, payload.configPath, "pool-set", {
        changedCount: payload.mods.length
      });
      return { mods };
    } catch (error) {
      request.log.error(error, "Panel pool set failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel pool set failed"
      });
    }
  });

  const auditLogHandler = async (request: FastifyRequest, reply: FastifyReply, source: unknown) => {
    const payload = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional().default(100)
      })
      .default({})
      .parse(source ?? {});

    try {
      const entries = await readAuditLog(payload.limit);
      return { entries };
    } catch (error) {
      request.log.error(error, "Panel audit log read failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Panel audit log read failed"
      });
    }
  };

  app.get("/panel/api/audit-log", async (request: FastifyRequest, reply: FastifyReply) =>
    auditLogHandler(request, reply, request.query)
  );

  app.post("/panel/api/audit-log", async (request: FastifyRequest, reply: FastifyReply) =>
    auditLogHandler(request, reply, request.body)
  );
}
