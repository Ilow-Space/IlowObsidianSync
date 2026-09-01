# Ilow Sync

End-to-end encrypted, real-time sync for your Obsidian vault, backed by a self-hosted Go/PostgreSQL server you control. Notes, plugin settings, themes and binaries stay in sync across devices using a CRDT engine (Loro) for conflict-free merging, while a client-side AES-256-GCM key keeps the server unable to read your content.

> **This is not a hosted service.** Ilow Sync has no managed backend run by the developer. You must deploy your own server (a single script sets up PostgreSQL + the Go binary + systemd on a Linux host) before the plugin can sync anything. See [Self-hosting the backend](#2-self-host-the-backend) below.

## Contents

- [Features](#features)
- [Privacy & data disclosures](#privacy--data-disclosures)
- [Installation](#installation)
- [Configuration](#configuration)
- [Multi-device setup](#multi-device-setup)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

## Features

- **End-to-end encryption** — your Master Password never leaves the device. A 256-bit AES-GCM key is derived locally (PBKDF2, SHA-256, 100,000 iterations) and used to encrypt every note, path and settings blob before it is sent to your server. The server only ever stores ciphertext.
- **Real-time, offline-first sync** — a Loro CRDT engine merges concurrent edits (including offline changes) without last-write-wins data loss, using WebSocket push notifications for near-instant propagation between devices.
- **Structure-aware sync** — file/folder renames and moves are reconciled against the vault's virtual file tree instead of being treated as delete+create.
- **Optional sync of plugin settings, plugin binaries, themes and appearance/hotkeys**, in addition to notes.
- **Multi-device onboarding via QR code** — scan a code to copy your server URL, API key and encryption salt to a new device instead of typing them in.
- **Self-hosted by design** — you own the server, the database and the data. No third party, including the plugin's author, has access to your vault content.

## Privacy & data disclosures

In line with Obsidian's developer policies, here is exactly what this plugin does and doesn't do:

- **Network use:** Yes. The plugin talks to one remote service: **your own backend server** (the Go application in `backend/`, which you deploy yourself — see below). It is used to store encrypted snapshots/updates and to relay real-time change notifications over WebSocket. No other network endpoint is contacted, and no data is ever sent to the plugin author or any third-party service.
- **Account required:** No. Access to your own server is controlled by an API key you generate yourself during setup — there is no developer-run account system.
- **Payment:** None. The plugin and backend are free and open source.
- **Ads:** None.
- **Telemetry:** The backend exposes a `/api/telemetry` endpoint (uptime, memory, request rate) that the plugin's sidebar reads to show you your **own server's** health. This data never leaves your infrastructure and is not collected by the developer.
- **File access outside the vault:** No. All synced files (notes, and optionally `.obsidian/` plugin/theme/config files) live inside your vault.
- **Source:** Fully open source, client and backend, under AGPL-3.0 (see [License](#license)).

## Installation

### 1. Install the plugin

Ilow Sync is not yet in the Community Plugins directory. Until then, install it manually or via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Ilow-Space/IlowObsidianSync/releases/latest).
2. Create a folder named `ilow-sync` inside your vault's `.obsidian/plugins/` directory and place the three files there.
3. Reload Obsidian and enable **Ilow Sync** under Settings → Community plugins.

### 2. Self-host the backend

The plugin needs a running instance of the Go/PostgreSQL backend to sync against. On a fresh Debian/Ubuntu server (or VM):

```bash
curl -fsSL https://raw.githubusercontent.com/Ilow-Space/IlowObsidianSync/main/setup_back.sh -o setup_back.sh
sudo bash setup_back.sh
```

This installs PostgreSQL, provisions a database, downloads (or compiles) the `ilow-backend` binary, generates your **Access API Key** and **Admin API Key**, and registers a `systemd` service so the server survives reboots. If Nginx is already running on the box, the script can also wire up TLS termination and API-key checks at the proxy level.

Prefer to run it manually? The backend only needs:

| Variable | Example | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP & WebSocket port |
| `DATABASE_URL` | `postgres://user:pass@localhost:5432/ilow_db?sslmode=disable` | PostgreSQL connection string |
| `API_KEY` | (random) | Required by clients for REST/WebSocket auth |
| `ADMIN_API_KEY` | (random) | Required for `/api/admin/truncate` maintenance calls |

Then run `go build ./backend` and start the resulting binary with those variables in its environment (or a `.env` file next to it). The schema (`vault_snapshots`, `vault_updates`) is created automatically on first start.

## Configuration

Open **Settings → Ilow Sync** in Obsidian:

| Setting | Description |
| --- | --- |
| **Base URL** | Your backend's HTTPS endpoint, e.g. `https://sync.example.com` |
| **API Key** | The access key generated by `setup_back.sh` (or your own `API_KEY`) |
| **Admin API Token** | Optional — only needed to use the "Purge Server Data" maintenance action |
| **Cryptography Salt** | Auto-generated on first run, or imported via QR code from another device |
| **Master Password** | Used locally to derive your AES-256 key. Never transmitted or written to disk. |

Click **Derive Key** after entering your Master Password to activate sync. Use **Test Connection** to confirm the plugin can reach your server before relying on it.

## Multi-device setup

Instead of copying the Base URL, API Key and Salt by hand:

1. On your first (already configured) device: **Settings → Ilow Sync → Generate Network QR Code**.
2. On the new device: **Settings → Ilow Sync → Scan Network QR Code**.
3. Enter the same Master Password on the new device and click **Derive Key**.

## Troubleshooting

- **Disable Obsidian's built-in Sync core plugin** before using Ilow Sync on the same vault — running both at once on the same files can corrupt state. The settings tab shows a warning if it detects the core plugin is active.
- **"Connection failed"** — check that Base URL is reachable from the device (no trailing slash, correct scheme) and that the API Key matches the server's `API_KEY`.
- **Lost your Master Password or regenerated the Salt?** You will not be able to decrypt previously synced data — this is expected under a true E2EE design. There is no recovery path other than re-encrypting from a device that still has the working key.
- **Hard Reset Local State** (Settings → Danger Zone) wipes the local IndexedDB cache and re-downloads everything from the server — useful if the local cache seems out of sync.

## Architecture

The codebase follows Domain-Driven Design across the client and an independent backend:

- **`src/1_Domain`** — entities (`Note`, `CRDTSnapshot`, `CRDTUpdate`, `VFSNode`) and contracts (`ICryptography`, `IRemoteStore`, `INoteRepository`).
- **`src/2_Application`** — `NetworkOrchestrator` (polling, push queues, WebSocket events, full-vault hydration), `LoroVfsController` (tree operations, UUID↔path mapping), `ObsidianDiskReconciler` (CRDT graph → vault file operations), `SyncEventBus` (typed events via `mitt` + `zod`), `VaultEventWatcher` (native vault lifecycle hooks).
- **`src/3_Infrastructure`** — `LoroSyncEngine` (Loro document lifetimes, state vectors, diffing), `LoroSnapshotStore` (Dexie/IndexedDB offline cache), `WebCryptoService` (PBKDF2 + AES-GCM), `PostgresRemoteStore` (REST/WebSocket transport over Obsidian's `requestUrl`).
- **`src/4_Presentation`** — `Plugin.ts` (entrypoint, secret storage, lifecycle), `SettingsTab.ts`, `SyncSidebarView.ts` (live status, throughput, queue depth), QR modals for onboarding.
- **`backend/`** — Go server providing the REST API, PostgreSQL `LISTEN`/`NOTIFY` → WebSocket bridge, and idle-time maintenance (`VACUUM ANALYZE`, memory release).

### REST API reference

| Method | Endpoint | Function |
| --- | --- | --- |
| `GET` | `/` | Upgrade to WebSocket for realtime notifications |
| `GET` | `/api/telemetry` | Server health, memory, uptime, RPS, DB connection stats |
| `GET` | `/api/vault/manifest` | List of document snapshots and encrypted path identifiers |
| `GET` | `/api/vault/latest_ids` | Bulk fetch of the highest update ID per document |
| `GET` | `/api/snapshots/{id}` | Snapshot metadata and state payload for one document |
| `GET` | `/api/snapshots/{id}/updates?since={N}` | Incremental update deltas after update ID `N` |
| `GET` | `/api/snapshots/{id}/latest_id` | Latest update sequence ID for one document |
| `POST` | `/api/updates` | Push an encrypted incremental delta |
| `POST` | `/api/snapshots/{id}/compact` | Overwrite base snapshot, truncate merged history |
| `DELETE` | `/api/snapshots/{id}` | Soft-delete a snapshot and its updates |
| `POST` | `/api/admin/truncate` | Truncate all tables (requires `Authorization: Bearer <ADMIN_API_KEY>`) |

### Database schema

```sql
CREATE TABLE IF NOT EXISTS vault_snapshots (
    document_id TEXT PRIMARY KEY,
    encrypted_state BYTEA,
    encrypted_path BYTEA,
    is_deleted BOOLEAN DEFAULT false,
    max_compacted_id INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vault_updates (
    id SERIAL PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES vault_snapshots(document_id) ON DELETE CASCADE,
    encrypted_update BYTEA,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vault_updates_doc_id ON vault_updates(document_id);
```

A database trigger publishes a JSON payload on the `vault_updates_channel` whenever a row is inserted into `vault_updates`, which the Go server relays to connected WebSocket clients.

## Development

```bash
# Start development watcher (Vite CJS compilation)
npm run dev

# Production build (typecheck, bundle, copy manifest to dist/)
npm run build

# Typecheck TypeScript without emitting JS
npm run typecheck

# Run unit & integration tests via Vitest
npm run test:unit

# Run full WebdriverIO multi-vault E2E tests in real Obsidian instances
npm run test:e2e

# Code duplication checks (jscpd) and lint rules (ESLint)
npm run compliance

# Everything: typecheck, lint, dry, unit, e2e
npm run test:all
```

The backend is a standard Go module:

```bash
cd backend
go build -o ilow-backend
go test ./...
```

## License

Ilow Sync (both the Obsidian plugin and the `backend/` server) is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see [LICENSE](./LICENSE) for the full text.

The AGPL was chosen deliberately because this project ships a server component: if you modify the backend and make it available to others over a network (e.g. run a hosted version of it), you are required to also make your modified source available to those users under the same license.
