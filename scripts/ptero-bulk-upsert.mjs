#!/usr/bin/env node
/**
 * Bulk POST /mods/pterodactyl/upsert then optional list — for verifying remote config
 * without long curl one-liners. Copy examples/bulk-mods.sample.json, replace modIds, run:
 *
 *   node scripts/ptero-bulk-upsert.mjs ./my-mods.json
 *
 * Env: API_AUTH_TOKEN (optional), defaults base URL http://127.0.0.1:3000
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const out = {
    file: null,
    baseUrl: process.env.MOD_MANAGER_BASE_URL || "http://127.0.0.1:3000",
    serverId: null,
    configPath: null,
    listOnly: false,
    autoDeps: false
  };
  for (const a of argv) {
    if (a.startsWith("--base-url=")) out.baseUrl = a.slice("--base-url=".length).replace(/\/$/, "");
    else if (a.startsWith("--server-id=")) out.serverId = a.slice("--server-id=".length);
    else if (a.startsWith("--config-path=")) out.configPath = a.slice("--config-path=".length);
    else if (a === "--list-only") out.listOnly = true;
    else if (a === "--auto-deps") out.autoDeps = true;
    else if (!a.startsWith("-") && !out.file) out.file = a;
  }
  return out;
}

async function requestJson(url, options) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.body = body;
    throw err;
  }
  return body;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file && !args.listOnly) {
    console.error(
      "Usage: node scripts/ptero-bulk-upsert.mjs <mods.json> [--base-url=URL] [--server-id=ID] [--config-path=/config.json] [--auto-deps] [--list-only]\n" +
        "       node scripts/ptero-bulk-upsert.mjs --list-only [--server-id=ID] [--config-path=...]   # list only, default server 873122ac /config.json"
    );
    process.exit(1);
  }

  const token = process.env.API_AUTH_TOKEN?.trim();
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  let payload = { mods: [], serverId: "873122ac", configPath: "/config.json" };
  if (args.file) {
    const raw = readFileSync(resolve(process.cwd(), args.file), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      payload.mods = parsed;
    } else if (parsed && Array.isArray(parsed.mods)) {
      payload = { ...parsed, mods: parsed.mods };
    } else {
      console.error("JSON must be an array of mods or { mods: [...], serverId?, configPath? }");
      process.exit(1);
    }
  }

  if (args.serverId) payload.serverId = args.serverId;
  if (args.configPath) payload.configPath = args.configPath;

  const base = args.baseUrl.replace(/\/$/, "");
  const listBody = {
    serverId: payload.serverId,
    configPath: payload.configPath
  };

  if (!args.listOnly) {
    if (!payload.mods.length) {
      console.error("No mods in file; nothing to upsert.");
      process.exit(1);
    }
    const up = {
      serverId: payload.serverId,
      configPath: payload.configPath,
      mods: payload.mods,
      autoAddDependencies: args.autoDeps,
      restartAfterInstall: false
    };
    const add = await requestJson(`${base}/mods/pterodactyl/upsert`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(up)
    });
    console.log("UPSERT_OK", JSON.stringify(add, null, 2));
  }

  const list = await requestJson(`${base}/mods/pterodactyl/list`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(listBody)
  });
  console.log("LIST", JSON.stringify(list, null, 2));
}

run().catch((e) => {
  console.error(e.message, e.body ?? "");
  process.exit(1);
});
