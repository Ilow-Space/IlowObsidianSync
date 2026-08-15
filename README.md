# Obsidian CRDT Sync

An end-to-end encrypted (E2EE), real-time synchronization plugin for Obsidian powered by Loro CRDT and a Go/PostgreSQL backend. It delivers multi-vault document convergence, structure-aware Virtual File System (VFS) reconciliation, offline change merging, and zero-knowledge snapshot storage.

---

## Architecture Overview

The codebase is structured according to Domain-Driven Design (DDD) principles across client layers and an autonomous backend:

* **Domain Layer (`src/1_Domain`)**: Contains entity definitions (`Note`, `CRDTSnapshot`, `CRDTUpdate`, `VFSNode`), domain contracts (`ICryptography`, `IRemoteStore`, `INoteRepository`), and value objects.


* **Application Layer (`src/2_Application`)**: Handles runtime coordination:


* `NetworkOrchestrator`: Coordinates polling, push queues, WebSocket listener events, and full vault hydration.


* `LoroVfsController`: Manages hierarchical tree operations, path tracking, and UUID-to-node mapping.


* `ObsidianDiskReconciler`: Translates CRDT graph changes into non-blocking vault file operations.


* `SyncEventBus`: Type-safe event emitter (`mitt` + `zod`) enforcing contract payloads across subsystems.


* `VaultEventWatcher`: Captures Obsidian native vault hooks (`create`, `modify`, `rename`, `delete`).




* **Infrastructure Layer (`src/3_Infrastructure`)**: Concrete persistence and wire implementations:


* `LoroSyncEngine`: Controls Loro document lifetimes, state vectors, diff generation (`fast-diff`), and Dexie cache persistence.


* `LoroSnapshotStore`: Offline IndexedDB snapshot store backed by Dexie.


* `WebCryptoService`: Browser Web Crypto API service implementing PBKDF2 key derivation and 256-bit AES-GCM encryption.


* `PostgresRemoteStore`: REST and WebSocket communication driver using Obsidian's `requestUrl` API.




* **Presentation Layer (`src/4_Presentation`)**: User interface and settings management:


* `Plugin.ts`: Plugin entrypoint managing secret storage, event hooks, and lifecycle bootstrap.


* `SettingsTab.ts`: Configuration view for server credentials, key derivation, and manual maintenance triggers.


* `SyncSidebarView.ts`: Live status view showing server health, throughput metrics, and active sync queues.


* `Modals`: QR code scanner and generator (`QrScannerModal`, `QrDisplayModal`) for quick multi-device onboarding.




* **Backend (`backend/`)**: High-throughput Go server providing PostgreSQL LISTEN/NOTIFY bridging, WebSocket streaming, and automatic maintenance tasks.



---

## Technical Specifications

| Feature | Implementation Detail |
| --- | --- |
| **CRDT Engine** | `loro-crdt` (Rope text CRDT & Moveable Tree CRDT)

 |
| **Encryption Standard** | Client-Side 256-bit AES-GCM with 12-byte IV

 |
| **Key Derivation** | PBKDF2 (SHA-256, 100,000 iterations, custom hex salt)

 |
| **Local Cache** | Dexie / IndexedDB (`loro-snapshot-store-db`)

 |
| **Concurrency Control** | `async-mutex` for disk locks, `p-limit` for concurrent pulls, `p-queue` for write queues

 |
| **Transport Protocol** | HTTP REST + PostgreSQL LISTEN/NOTIFY over WebSocket

 |

---

## Go Backend Protocol & Endpoints

The Go server exposes REST endpoints for synchronization and streams live database mutations via PostgreSQL channels.

### REST Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/` | Upgrades client connection to WebSocket for realtime notifications

 |
| `GET` | `/api/telemetry` | Returns server health, memory metrics, uptime, RPS, and DB connection stats

 |
| `GET` | `/api/vault/manifest` | Retrieves the list of document snapshots and encrypted path identifiers

 |
| `GET` | `/api/vault/latest_ids` | Bulk fetches the highest sequence update ID across all vault documents

 |
| `GET` | `/api/snapshots/{id}` | Reads snapshot metadata and state payload for a specific document ID

 |
| `GET` | `/api/snapshots/{id}/updates?since={N}` | Fetches incremental update deltas created after ID `N`<br> |
| `GET` | `/api/snapshots/{id}/latest_id` | Fetches the latest update sequence ID for a single document

 |
| `POST` | `/api/updates` | Pushes an encrypted incremental delta to `vault_updates`<br> |
| `POST` | `/api/snapshots/{id}/compact` | Overwrites base snapshot state and truncates merged update history

 |
| `DELETE` | `/api/snapshots/{id}` | Soft-deletes a snapshot record and purges associated updates

 |
| `POST` | `/api/admin/truncate` | Truncates snapshot and update tables (requires `Authorization: Bearer <ADMIN_API_KEY>`)

 |

### Server Self-Optimization

The Go server continuously monitors traffic. After **5 minutes (300 seconds) of API silence**, it automatically executes background maintenance:

1. Invokes `debug.FreeOSMemory()` to release unallocated RAM back to the operating system.


2. Runs non-blocking `VACUUM ANALYZE vault_snapshots, vault_updates;` on PostgreSQL to defragment storage and recalculate query planner indices.



---

## Database Schema & Migrations

The Go service automatically initializes the following PostgreSQL schema on startup:

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

An automatic trigger publishes payload JSON objects to the `vault_updates_channel` whenever new updates are inserted.

---

## Environment Configuration

### Backend Environment Variables (`backend/.env`)

| Variable | Default Value | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP & WebSocket server port

 |
| `DATABASE_URL` | `postgres://postgres:your_password@localhost:5432/your_db?sslmode=disable` | PostgreSQL connection string

 |
| `ADMIN_API_KEY` | `super-secret-admin-token` | Bearer token required for `/api/admin/truncate`<br> |

---

## Project Build & Development Commands

All client tasks are managed using `npm` scripts defined in `package.json`.

```bash
# Start development watcher (Vite CJS compilation)
npm run dev

# Production build (typecheck, bundle, copy manifest to dist/)
npm run build

# Type check TypeScript files without emitting code
npm run typecheck

# Run unit & integration tests (Vitest)
npm run test:unit

# Run full WebdriverIO multi-vault E2E test suite in real Obsidian instances
npm run test:e2e

# Execute code duplication checks (jscpd) and linter rules (ESLint)
npm run compliance

# Execute all validation steps (Typecheck, Lint, Dry, Unit, E2E)
npm run test:all

```