import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "./config.js";
import { requireApiToken } from "./services/auth.js";
import { healthRoutes } from "./routes/health.js";
import { modRoutes } from "./routes/mods.js";
import { panelRoutes } from "./routes/panel.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL
    }
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Pterodactyl Mod Manager API",
        version: "0.1.0"
      }
    }
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs"
  });

  app.addHook("onRequest", requireApiToken);

  await app.register(healthRoutes);
  await app.register(panelRoutes);
  await app.register(modRoutes);

  return app;
}
