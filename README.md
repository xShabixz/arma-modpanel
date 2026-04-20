# Pterodactyl Arma Reforger Mod Manager

Small Fastify + TypeScript service for managing Arma Reforger `game.mods` through Pterodactyl. It includes a built-in panel, dependency expansion, and server-side file updates.

## Highlights

- Manage mods in `game.mods`
- Built-in web panel at `/panel`
- Add, edit, remove, and bulk import mods
- Pool workflow: stage mods, activate from pool, and deactivate back to pool
- Optional dependency auto-add during upsert
- Audit log for add/update/remove actions, stored as JSONL on disk
- Name/version lookup from Steam, Arma Reforger workshop metadata, or a custom resolver template
- Optional API bearer-token protection for non-panel routes
- Swagger docs at `/docs`

## Project Layout

- `src/index.ts` - app entrypoint
- `src/server.ts` - Fastify setup and route registration
- `src/routes/` - API routes
- `src/services/` - config, dependency, resolver, and Pterodactyl helpers
- `src/views/` - built-in panel HTML and CSS
- `docs/INSTALLATION.md` - setup and deployment guide

## Quick Start

1. Install Node.js 20 or newer.
2. Install dependencies.

```bash
npm install
```

3. Copy environment template.

```bash
cp .env.example .env
```

4. Fill required values in `.env`.
5. Start in development mode.

```bash
npm run dev
```

6. Open panel URL.

```text
http://127.0.0.1:3000/panel
```

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run check
```

## Prepare for GitHub

- Keep only source code, docs, examples, and reusable scripts.
- Do not commit `.env`.
- Do not commit machine-specific remote scripts with passwords, tokens, or fixed hostnames.
- Review `deploy.sh` and set your own `DEPLOY_REMOTE` and `DEPLOY_DIR` before use.

## Documentation

- [Installation and Usage Guide](docs/INSTALLATION.md)
- [`.env.example`](.env.example)

## Notes

- The panel uses server-side Pterodactyl credentials, so the browser does not need a token field.
- `contentType` is a manual label used by the panel to mark an entry as `mod` or `game`.
- Audit events are written to the path in `MOD_AUDIT_LOG_PATH` and can be viewed with `GET /mods/audit-log?limit=100`.
- If you do not want API protection, leave `API_AUTH_TOKEN` unset.
