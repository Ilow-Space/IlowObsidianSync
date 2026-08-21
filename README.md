# Ilow Sync
An end-to-end encrypted (E2EE), real-time synchronization plugin for Obsidian powered by the Loro CRDT engine and a Go/PostgreSQL backend. It delivers multi-vault document convergence, structure-aware Virtual File System (VFS) reconciliation, offline change merging, and zero-knowledge snapshot storage.
---
## Architecture
The codebase strictly follows Domain-Driven Design (DDD) principles across client layers and an autonomous backend:
* **Domain Layer (`src/1_Domain`)**: Contains entity definitions (`Note`, `CRDTSnapshot`, `CRDTUpdate`, `VFSNode`), domain contracts (`ICryptography`, `IRemoteStore`, `INoteRepository`), and value objects.

* **Application Layer (`src/2_Application`)**: Manages runtime subsystem coordination:

* `NetworkOrchestrator`: Coordinates polling, push queues, WebSocket listener events, and full vault hydration.

* `LoroVfsController`: Handles hierarchical tree operations, path tracking, and UUID-to-node mapping.

* `ObsidianDiskReconciler`: Translates CRDT graph changes into non-blocking vault file operations.

* `SyncEventBus`: Provides a type-safe event emitter (`mitt` + `zod`) enforcing contract payloads.

* `VaultEventWatcher`: Listens to native Obsidian vault lifecycle hooks (`create`, `modify`, `rename`, `delete`).


* **Infrastructure Layer (`src/3_Infrastructure`)**: Concrete persistence and network transport drivers:

* `LoroSyncEngine`: Controls Loro document lifetimes, state vectors, diff generation (`fast-diff`), and Dexie cache persistence.
* `LoroSnapshotStore`: Offline IndexedDB snapshot store backed by Dexie.

* `WebCryptoService`: Browser Web Crypto API service implementing PBKDF2 key derivation and 256-bit AES-GCM encryption.

* `PostgresRemoteStore`: REST and WebSocket communication driver utilizing Obsidian's `requestUrl` API.


* **Presentation Layer (`src/4_Presentation`)**: User interfaces and configuration management:

* `Plugin.ts`: Entrypoint managing secret storage, event hooks, and lifecycle bootstrap.

* `SettingsTab.ts`: View for server credentials, key derivation, and manual maintenance triggers.

* `SyncSidebarView.ts`: Live status view displaying server health, throughput metrics, and active sync queues.

* `Modals`: QR code scanner and generator (`QrScannerModal`, `QrDisplayModal`) for multi-device onboarding.


* **Backend (`backend/`)**: High-throughput Go server providing PostgreSQL LISTEN/NOTIFY bridging, WebSocket streaming, and background maintenance tasks.

---
## Technical Specifications
| Feature | Specification Details |
| --- | --- |
| **CRDT Engine** | `loro-crdt` (Rope text CRDT & Moveable Tree CRDT) |
| **Encryption Standard** | Client-Side 256-bit AES-GCM with 12-byte IV |
| **Key Derivation** | PBKDF2 (SHA-256, 100,000 iterations, custom hex salt) |
| **Local Storage** | Dexie / IndexedDB (`ilow-snapshot-store-db`) |
| **Concurrency Control** | `async-mutex` (disk locks), `p-limit` (concurrent pulls), `p-queue` (write queues)|
| **Transport Protocol** | HTTP REST + PostgreSQL LISTEN/NOTIFY over WebSocket|
---
## Go Backend Protocol & Endpoints
The Go server exposes REST endpoints for synchronization and streams live database mutations via PostgreSQL channels.
### REST API Reference
| Method | Endpoint | Function |
| --- | --- | --- |
| `GET` | `/` | Upgrades client connection to WebSocket for realtime notifications|
| `GET` | `/api/telemetry` | Returns server health, memory metrics, uptime, RPS, and DB connection stats|
| `GET` | `/api/vault/manifest` | Retrieves the list of document snapshots and encrypted path identifiers|
| `GET` | `/api/vault/latest_ids` | Bulk fetches the highest sequence update ID across all vault documents|
| `GET` | `/api/snapshots/{id}` | Reads snapshot metadata and state payload for a specific document ID|
| `GET` | `/api/snapshots/{id}/updates?since={N}` | Fetches incremental update deltas created after update ID `N`<br> |
| `GET` | `/api/snapshots/{id}/latest_id` | Fetches the latest update sequence ID for a single document|
| `POST` | `/api/updates` | Pushes an encrypted incremental delta to `vault_updates`<br> |
| `POST` | `/api/snapshots/{id}/compact` | Overwrites base snapshot state and truncates merged update history|
| `DELETE` | `/api/snapshots/{id}` | Soft-deletes a snapshot record and purges associated updates|
| `POST` | `/api/admin/truncate` | Truncates snapshot and update tables (requires `Authorization: Bearer <ADMIN_API_KEY>`)|
### Server Self-Optimization
After **5 minutes (300 seconds) of API inactivity**, the Go server automatically executes background maintenance routines:
1. Calls `debug.FreeOSMemory()` to release unallocated memory back to the host system.

2. Runs non-blocking `VACUUM ANALYZE vault_snapshots, vault_updates;` on PostgreSQL to defragment storage and recalculate query planner indices.

---
## Database Schema
The Go service provisions the PostgreSQL schema on startup:
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
An automated database trigger publishes payload JSON objects to the `vault_updates_channel` whenever new updates are inserted.
---
## Environment Configuration
### Backend Setup (`backend/.env`)
| Variable | Default Value | Description |
| --- | --- | --- |
| `PORT` | `3001` | Server port for HTTP & WebSocket connections|
| `DATABASE_URL` | `postgres://postgres:your_password@localhost:5432/your_db?sslmode=disable` | PostgreSQL connection string|
| `ADMIN_API_KEY` | `super-secret-admin-token` | Bearer token required for `/api/admin/truncate`<br> |
---
## Development & Build Commands
Client scripts are managed using `npm` commands:
```bash
# Start development watcher (Vite CJS compilation)
npm run dev
# Production build (typecheck, bundle, copy manifest to dist/)
npm run build
# Typecheck TypeScript without emitting JS code
npm run typecheck
# Run unit & integration tests via Vitest
npm run test:unit
# Run full WebdriverIO multi-vault E2E tests in real Obsidian instances
npm run test:e2e
# Execute code duplication checks (jscpd) and linter rules (ESLint)
npm run compliance
# Execute all validation steps (Typecheck, Lint, Dry, Unit, E2E)
npm run test:all
```