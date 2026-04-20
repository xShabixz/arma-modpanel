import { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

export async function requireApiToken(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Allow health checks, docs, and the built-in panel page without auth.
  // Panel API endpoints (/panel/api/*) still skip bearer-token auth because
  // they rely on server-side Pterodactyl credentials, but we keep them
  // accessible only when Pterodactyl is configured (enforced in panelRoutes).
  const url = request.url.split("?")[0];
  if (url === "/health" || url === "/panel" || url.startsWith("/docs")) {
    return;
  }
  // Panel API uses server-side credentials — allow without bearer token
  if (url.startsWith("/panel/api/")) {
    return;
  }

  const expectedToken = config.API_AUTH_TOKEN;
  if (!expectedToken) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.code(401).send({ message: "Missing bearer token" });
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (token !== expectedToken) {
    reply.code(401).send({ message: "Invalid bearer token" });
  }
}
