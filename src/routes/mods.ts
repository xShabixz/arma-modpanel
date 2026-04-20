import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addOrUpdateMods,
  detectMissingDependencies,
  listMods,
  listModsFromConfig,
  parseServerConfig,
  removeMods,
  removeModsFromConfig,
  serializeServerConfig,
  upsertModsInConfig
} from "../services/armaConfig.js";
import { appendAuditLog, buildAuditChanges, AuditModSnapshot, readAuditLog } from "../services/auditLog.js";
import { expandModsWithDependencies } from "../services/dependencyAutoAdd.js";
import { PterodactylClient } from "../services/pterodactylClient.js";
import { resolveModName } from "../services/modNameResolver.js";

const configPathSchema = z.object({
  configPath: z.string().min(1)
});

const modSchema = z.object({
  modId: z.string().min(1).optional(),
  modID: z.string().min(1).optional(),
  modit: z.string().min(1).optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  required: z.boolean().optional(),
  contentType: z.enum(["mod", "game"]).optional()
}).refine((value) => Boolean(value.modId || value.modID || value.modit), {
  message: "modId or modID or modit is required"
}).transform((value) => ({
  modId: value.modId ?? value.modID ?? value.modit!,
  name: value.name,
  version: value.version,
  required: value.required,
  contentType: value.contentType
}));

const upsertModsBodySchema = z.object({
  configPath: z.string().min(1),
  mods: z.array(modSchema).min(1),
  autoAddDependencies: z.boolean().default(true),
  restartAfterInstall: z.boolean().default(false),
  serverId: z.string().optional()
});

const removeModsBodySchema = z.object({
  configPath: z.string().min(1),
  modIDs: z.array(z.string().min(1)).min(1),
  restartAfterInstall: z.boolean().default(false),
  serverId: z.string().optional()
});

const dependencyCheckBodySchema = z.object({
  configPath: z.string().min(1),
  dependencyMap: z.record(z.array(z.string())).default({})
});

const pteroConfigSchema = z.object({
  serverId: z.string().min(1),
  configPath: z.string().min(1).default("/config.json")
});

const pteroUpsertSchema = z.object({
  serverId: z.string().min(1),
  configPath: z.string().min(1).default("/config.json"),
  mods: z.array(modSchema).min(1),
  autoAddDependencies: z.boolean().default(true),
  restartAfterInstall: z.boolean().default(false)
});

const pteroRemoveSchema = z.object({
  serverId: z.string().min(1),
  configPath: z.string().min(1).default("/config.json"),
  modIDs: z.array(z.string().min(1)).min(1),
  restartAfterInstall: z.boolean().default(false)
});

const pteroDependencyCheckSchema = z.object({
  serverId: z.string().min(1),
  configPath: z.string().min(1).default("/config.json"),
  dependencyMap: z.record(z.array(z.string())).default({})
});

const resolveNameSchema = z.object({
  modId: z.string().min(1).optional(),
  modit: z.string().min(1).optional()
}).refine((value) => Boolean(value.modId || value.modit), {
  message: "modId or modit is required"
});

export async function modRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mods/audit-log", async (request, reply) => {
    const payload = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional().default(100)
      })
      .default({})
      .parse(request.query);

    try {
      const entries = await readAuditLog(payload.limit);
      return { entries };
    } catch (error) {
      request.log.error(error, "Read audit log failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Read audit log failed"
      });
    }
  });

  app.post("/mods/list", async (request, reply) => {
    const payload = configPathSchema.parse(request.body);

    try {
      const mods = await listMods(payload.configPath);
      return { mods };
    } catch (error) {
      request.log.error(error, "List mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "List mods failed"
      });
    }
  });

  app.post("/mods/upsert", async (request, reply) => {
    const payload = upsertModsBodySchema.parse(request.body);

    try {
      const currentMods = await listMods(payload.configPath);
      const beforeMods = currentMods.map((mod) => ({ ...mod }));
      const modsToWrite = payload.autoAddDependencies
        ? await expandModsWithDependencies(
            payload.mods,
            currentMods.map((mod) => mod.modId)
          )
        : payload.mods;

      const mods = await addOrUpdateMods(payload.configPath, modsToWrite);
      const changes = buildAuditChanges(beforeMods as AuditModSnapshot[], mods as AuditModSnapshot[]);
      if (changes.length > 0) {
        await appendAuditLog({
          timestamp: new Date().toISOString(),
          event: "mods-upsert",
          scope: "api",
          configPath: payload.configPath,
          serverId: payload.serverId,
          restartAfterInstall: payload.restartAfterInstall,
          changes
        });
      }

      let restarted = false;
      if (payload.restartAfterInstall) {
        if (!payload.serverId) {
          return reply.code(400).send({
            message: "serverId is required when restartAfterInstall=true"
          });
        }

        const client = new PterodactylClient();
        await client.restartServer(payload.serverId);
        restarted = true;
      }

      return { mods, restarted };
    } catch (error) {
      request.log.error(error, "Upsert mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Upsert mods failed"
      });
    }
  });

  app.post("/mods/remove", async (request, reply) => {
    const payload = removeModsBodySchema.parse(request.body);

    try {
      const beforeMods = await listMods(payload.configPath);
      const mods = await removeMods(payload.configPath, payload.modIDs);
      const changes = buildAuditChanges(beforeMods as AuditModSnapshot[], mods as AuditModSnapshot[]);
      if (changes.length > 0) {
        await appendAuditLog({
          timestamp: new Date().toISOString(),
          event: "mods-remove",
          scope: "api",
          configPath: payload.configPath,
          serverId: payload.serverId,
          restartAfterInstall: payload.restartAfterInstall,
          changes
        });
      }

      let restarted = false;
      if (payload.restartAfterInstall) {
        if (!payload.serverId) {
          return reply.code(400).send({
            message: "serverId is required when restartAfterInstall=true"
          });
        }

        const client = new PterodactylClient();
        await client.restartServer(payload.serverId);
        restarted = true;
      }

      return { mods, restarted };
    } catch (error) {
      request.log.error(error, "Remove mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Remove mods failed"
      });
    }
  });

  app.post("/mods/dependencies/check", async (request, reply) => {
    const payload = dependencyCheckBodySchema.parse(request.body);

    try {
      const mods = await listMods(payload.configPath);
      const missing = detectMissingDependencies(mods, payload.dependencyMap);
      return {
        installed: mods.map((mod) => mod.modId),
        missing
      };
    } catch (error) {
      request.log.error(error, "Dependency check failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Dependency check failed"
      });
    }
  });

  app.post("/mods/pterodactyl/list", async (request, reply) => {
    const payload = pteroConfigSchema.parse(request.body);

    try {
      const client = new PterodactylClient();
      const rawConfig = await client.readServerFile(payload.serverId, payload.configPath);
      const parsed = parseServerConfig(rawConfig);
      return { mods: listModsFromConfig(parsed) };
    } catch (error) {
      request.log.error(error, "Pterodactyl list mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Pterodactyl list mods failed"
      });
    }
  });

  app.post("/mods/pterodactyl/upsert", async (request, reply) => {
    const payload = pteroUpsertSchema.parse(request.body);

    try {
      const client = new PterodactylClient();
      const rawConfig = await client.readServerFile(payload.serverId, payload.configPath);
      const parsed = parseServerConfig(rawConfig);
      const existingMods = listModsFromConfig(parsed);
      const beforeMods = existingMods.map((mod) => ({ ...mod }));
      const modsToWrite = payload.autoAddDependencies
        ? await expandModsWithDependencies(
            payload.mods,
            existingMods.map((mod) => mod.modId)
          )
        : payload.mods;
      const mods = upsertModsInConfig(parsed, modsToWrite);

      await client.writeServerFile(payload.serverId, payload.configPath, serializeServerConfig(parsed));
      const changes = buildAuditChanges(beforeMods as AuditModSnapshot[], mods as AuditModSnapshot[]);
      if (changes.length > 0) {
        await appendAuditLog({
          timestamp: new Date().toISOString(),
          event: "mods-upsert",
          scope: "pterodactyl",
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

      return { mods, restarted };
    } catch (error) {
      request.log.error(error, "Pterodactyl upsert mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Pterodactyl upsert mods failed"
      });
    }
  });

  app.post("/mods/pterodactyl/remove", async (request, reply) => {
    const payload = pteroRemoveSchema.parse(request.body);

    try {
      const client = new PterodactylClient();
      const rawConfig = await client.readServerFile(payload.serverId, payload.configPath);
      const parsed = parseServerConfig(rawConfig);
      const beforeMods = listModsFromConfig(parsed);
      const mods = removeModsFromConfig(parsed, payload.modIDs);

      await client.writeServerFile(payload.serverId, payload.configPath, serializeServerConfig(parsed));
      const changes = buildAuditChanges(beforeMods as AuditModSnapshot[], mods as AuditModSnapshot[]);
      if (changes.length > 0) {
        await appendAuditLog({
          timestamp: new Date().toISOString(),
          event: "mods-remove",
          scope: "pterodactyl",
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

      return { mods, restarted };
    } catch (error) {
      request.log.error(error, "Pterodactyl remove mods failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Pterodactyl remove mods failed"
      });
    }
  });

  app.post("/mods/pterodactyl/dependencies/check", async (request, reply) => {
    const payload = pteroDependencyCheckSchema.parse(request.body);

    try {
      const client = new PterodactylClient();
      const rawConfig = await client.readServerFile(payload.serverId, payload.configPath);
      const parsed = parseServerConfig(rawConfig);
      const mods = listModsFromConfig(parsed);
      const missing = detectMissingDependencies(mods, payload.dependencyMap);

      return {
        installed: mods.map((mod) => mod.modId),
        missing
      };
    } catch (error) {
      request.log.error(error, "Pterodactyl dependency check failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Pterodactyl dependency check failed"
      });
    }
  });

  app.post("/mods/name/resolve", async (request, reply) => {
    const payload = resolveNameSchema.parse(request.body);
    const modId = payload.modId ?? payload.modit!;

    try {
      const result = await resolveModName(modId);
      return result;
    } catch (error) {
      request.log.error(error, "Resolve mod name failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Resolve mod name failed"
      });
    }
  });

  app.post("/pterodactyl/servers/:serverId/restart", async (request, reply) => {
    const params = z
      .object({
        serverId: z.string().min(1)
      })
      .parse(request.params);

    try {
      const client = new PterodactylClient();
      await client.restartServer(params.serverId);
      return { success: true };
    } catch (error) {
      request.log.error(error, "Pterodactyl restart failed");
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Restart failed"
      });
    }
  });
}
