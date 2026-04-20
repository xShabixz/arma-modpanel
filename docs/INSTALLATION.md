# Installation and Usage Guide

This service manages Arma Reforger `game.mods` via Pterodactyl and provides a built-in web panel.

## 1) Prerequisites

- Node.js 20+
- npm
- Pterodactyl panel URL and API key
- Target server config path (usually `/config.json`)

## 2) Install

1. Install dependencies.

```bash
npm install
```

2. Create environment file.

```bash
cp .env.example .env
```

3. Edit `.env`.

Required:
- `PTERODACTYL_BASE_URL`
- `PTERODACTYL_API_KEY`

Common optional values:
- `PTERODACTYL_API_KIND` (`client` by default)
- `API_AUTH_TOKEN` (protects non-panel API routes)
- `MOD_NAME_LOOKUP_URL_TEMPLATE`
- `REFORGER_MODS_API_BASE_URL`

## 3) Run Locally

```bash
npm run dev
```

Open:
- Panel: `http://127.0.0.1:3000/panel`
- Health: `http://127.0.0.1:3000/health`
- API docs: `http://127.0.0.1:3000/docs`

## 4) Build and Run (Production)

```bash
npm run build
npm run start
```

## 5) Panel Workflow

1. Open `/panel`
2. Set `serverId` and `configPath`
3. Click `Load Mods`
4. Use `Add To Pool` to stage mods
5. Use `Activate Selected` or `Activate All` to write pool mods into active config
6. Use `Deactivate Selected` or `Deactivate All` to move active mods out of config and back to pool
7. Use pool `Remove` only when you want to delete staged entries from pool list

## 6) API Overview

Core endpoints:
- `GET /health`
- `GET /panel`
- `GET /docs`
- `POST /panel/api/mods/list`
- `POST /panel/api/mods/resolve`
- `POST /panel/api/mods/upsert`
- `POST /panel/api/mods/remove`
- `POST /mods/pterodactyl/list`
- `POST /mods/pterodactyl/upsert`
- `POST /mods/pterodactyl/remove`
- `GET /mods/audit-log?limit=100`

If `API_AUTH_TOKEN` is set, send:

```text
Authorization: Bearer <API_AUTH_TOKEN>
```

## 7) Bulk Import CLI

Use the included script to upsert many mods from JSON.

```bash
npm run ptero:bulk -- ./my-mods.json
```

Input JSON format example:

```json
[
	{ "modId": "62F364B35E9B51B0", "name": "Wirecutters 2", "version": "" }
]
```

## 8) Deployment Script

`deploy.sh` is a reusable helper. Set these environment variables before running:
- `DEPLOY_REMOTE` (example: `user@your-server`)
- `DEPLOY_DIR` (example: `/home/user/ptero-mod-manager`)

Then run:

```bash
bash deploy.sh
```

## 9) GitHub Safety Checklist

- Never commit `.env`
- Never commit passwords/tokens in scripts
- Keep host/IP-specific operational scripts outside the repo
- Review staged files with `git status` before push
