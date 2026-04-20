import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  API_AUTH_TOKEN: z.string().optional(),
  MOD_AUDIT_LOG_PATH: z.string().default("logs/mod-audit.log"),
  PANEL_POOL_STORE_PATH: z.string().default("logs/panel-pool.json"),
  PTERODACTYL_BASE_URL: z.string().url().optional(),
  PTERODACTYL_API_KEY: z.string().optional(),
  PTERODACTYL_API_KIND: z.enum(["client", "application"]).default("client"),
  MOD_NAME_LOOKUP_URL_TEMPLATE: z.string().url().optional(),
  REFORGER_MODS_API_BASE_URL: z.string().url().default("https://api.reforgermods.net"),
  MODRINTH_API_BASE_URL: z.string().url().default("https://api.modrinth.com/v2")
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);
