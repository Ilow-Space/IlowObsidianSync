package main

import (
	"bufio"
	"compress/gzip"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"github.com/lib/pq"
)

var (
	port           string
	dbConnStr      string
	adminAPIKey    string
	accessAPIKey   string
	allowedOrigins []string
	maxBodyBytes   int64
	blobGCGrace    time.Duration
	channel        = "vault_updates_channel"
	db             *sql.DB
)

// blobsRoot is the on-disk root for content-addressed blobs. It is a variable so
// tests can point it at a temporary directory.
var blobsRoot = "./data/blobs"

// safeSegment matches the only shapes allowed to become a path segment on disk.
// Vault alias ids are SHA-256 hex and blob hashes are SHA-256 hex, so restricting
// to hex-ish identifiers costs nothing and makes traversal impossible.
var safeSegment = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// isSafeStorageSegment reports whether s can be used as a single path segment.
// It rejects anything containing a separator, a drive letter, or a dot segment,
// which is what keeps `X-Vault-Alias-ID: ../../etc` from escaping blobsRoot.
func isSafeStorageSegment(s string) bool {
	return safeSegment.MatchString(s)
}

var (
	startTime        = time.Now()
	dataTransferred  uint64
	activeWebSockets int64
	reqsLastSecond   uint64
	reqsLastHour     uint64
	gcReclaimedBytes uint64
	currentRPS       float64
	currentRPM       float64
	telemetryMux     sync.Mutex
)

type ServerTelemetry struct {
	RPS                  float64 `json:"rps"`
	RPMAvgHour           float64 `json:"rpmAvgHour"`
	DataTransferredBytes uint64  `json:"dataTransferredBytes"`
	ActiveWebSockets     int64   `json:"activeWebSockets"`
	UptimeSeconds        int64   `json:"uptimeSeconds"`
	MemoryAllocMB        float64 `json:"memoryAllocMb"`
	DBConnections        int     `json:"dbConnections"`
	SystemHealth         string  `json:"systemHealth"`
	GCReclaimedBytes     uint64  `json:"gcReclaimedBytes"`
}

var upgrader = websocket.Upgrader{
	// Non-browser clients (the plugin's requestUrl, curl) send no Origin at all.
	// Browser origins are only accepted when explicitly allowlisted, so a random
	// web page cannot open a socket against a server whose URL it has learned.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		return resolveAllowedOrigin(origin) != ""
	},
}

type Client struct {
	conn          *websocket.Conn
	subscriptions map[string]bool
	vaultAliasID  string
	mu            sync.RWMutex
	writeMu       sync.Mutex
}

// applySubscribeMessage records the documents a client asked for. The client's
// vault alias is fixed at handshake time and deliberately NOT taken from the
// message: letting a peer name its own alias per message turns the socket into a
// cross-tenant subscription for anyone who learns an alias id.
func applySubscribeMessage(c *Client, msg SubscribeMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()

	filters := msg.Filters
	if msg.Action == "subscribe" && msg.Filter != "" {
		filters = []string{msg.Filter}
	} else if msg.Action != "subscribe_bulk" {
		return
	}

	for _, filterStr := range filters {
		matches := subscribeFilterRegex.FindStringSubmatch(filterStr)
		if len(matches) > 1 {
			c.subscriptions[matches[1]] = true
		}
	}
}

var subscribeFilterRegex = regexp.MustCompile(`document_id=eq\.(.+)`)

type Hub struct {
	clients map[*Client]bool
	mu      sync.RWMutex
}

var globalHub = Hub{
	clients: make(map[*Client]bool),
}

type SubscribeMessage struct {
	Action       string   `json:"action"`
	Filter       string   `json:"filter"`
	Filters      []string `json:"filters"`
	VaultAliasID string   `json:"vault_alias_id"`
}

type PgPayload struct {
	Type   string `json:"type"`
	Table  string `json:"table"`
	Record struct {
		VaultAliasID string `json:"vault_alias_id"`
		DocumentID   string `json:"document_id"`
		ID           int    `json:"id"`
	} `json:"record"`
}

type UpdatePayload struct {
	DocumentID      string  `json:"document_id"`
	EncryptedUpdate string  `json:"encrypted_update"`
	EncryptedPath   *string `json:"encrypted_path,omitempty"`
}

type CompactPayload struct {
	PState         string  `json:"p_state"`
	PMaxID         int     `json:"p_max_id"`
	PIsDeleted     bool    `json:"p_is_deleted"`
	PEncryptedPath *string `json:"p_encrypted_path,omitempty"`
}

type BlobManifestPayload struct {
	ActiveHashes []string `json:"active_hashes"`
}

func startTelemetryTracker() {
	secTicker := time.NewTicker(1 * time.Second)
	hourTicker := time.NewTicker(1 * time.Hour)

	idleSeconds := 0
	var isOptimizing atomic.Bool

	for {
		select {
		case <-secTicker.C:
			rps := atomic.SwapUint64(&reqsLastSecond, 0)

			telemetryMux.Lock()
			currentRPS = float64(rps)
			telemetryMux.Unlock()

			if rps == 0 {
				idleSeconds++
			} else {
				idleSeconds = 0
			}

			if idleSeconds == 300 && isOptimizing.CompareAndSwap(false, true) {
				go func() {
					defer isOptimizing.Store(false)
					runIdleOptimizations()
				}()
			}

		case <-hourTicker.C:
			rpm := atomic.SwapUint64(&reqsLastHour, 0)
			telemetryMux.Lock()
			currentRPM = float64(rpm) / 60.0
			telemetryMux.Unlock()
		}
	}
}

func runIdleOptimizations() {
	log.Println("[Self-Optimization] Server has been completely idle for 5 minutes. Initiating maintenance tasks...")

	var memBefore runtime.MemStats
	runtime.ReadMemStats(&memBefore)

	debug.FreeOSMemory()

	var memAfter runtime.MemStats
	runtime.ReadMemStats(&memAfter)

	reclaimedMB := float64(memBefore.Alloc-memAfter.Alloc) / 1024.0 / 1024.0
	if reclaimedMB > 0 {
		log.Printf("[Self-Optimization] Go Garbage Collector reclaimed %.2f MB of RAM.\n", reclaimedMB)
	}

	if db != nil {
		start := time.Now()
		_, err := db.Exec("VACUUM ANALYZE vault_snapshots, vault_updates;")
		if err != nil {
			log.Printf("[Self-Optimization] Postgres VACUUM failed: %v\n", err)
		} else {
			log.Printf("[Self-Optimization] Postgres defragmented successfully in %v.\n", time.Since(start))
		}
	}

	go runBlobGarbageCollection()

	log.Println("[Self-Optimization] Maintenance complete. Server is operating at peak efficiency.")
}

// collectGarbageBlobs removes blobs that no recent manifest claims, returning the
// bytes reclaimed. A vault with no manifest in the window is skipped entirely, and
// blobs newer than `grace` are always kept: a freshly uploaded attachment has not
// had time to appear in any device's manifest yet.
func collectGarbageBlobs(root string, activeByVault map[string]map[string]bool, now time.Time, grace time.Duration) (uint64, error) {
	vaultDirs, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	var totalReclaimed uint64

	for _, vDir := range vaultDirs {
		if !vDir.IsDir() {
			continue
		}
		vaultID := vDir.Name()
		activeHashes, hasManifest := activeByVault[vaultID]

		// Only clean up vaults that have reported a manifest inside the window.
		if !hasManifest || len(activeHashes) == 0 {
			continue
		}

		vaultPath := filepath.Join(root, vaultID)
		files, err := os.ReadDir(vaultPath)
		if err != nil {
			continue
		}

		for _, file := range files {
			if file.IsDir() || activeHashes[file.Name()] {
				continue
			}

			info, err := file.Info()
			if err != nil {
				continue
			}
			if now.Sub(info.ModTime()) < grace {
				continue
			}

			size := uint64(info.Size())
			if err := os.Remove(filepath.Join(vaultPath, file.Name())); err == nil {
				totalReclaimed += size
			}
		}
	}

	return totalReclaimed, nil
}

func runBlobGarbageCollection() {
	if db == nil {
		return
	}
	log.Println("[Blob-GC] Starting background disk blob garbage collection cycle...")
	start := time.Now()

	// 1. Union every manifest reported inside the retention window.
	//
	// A manifest describes one device's view of the vault. A device whose index is
	// incomplete -- a truncated shard-index, or a sweep that aborted partway --
	// reports a short list, and treating that single list as authoritative deletes
	// every other device's attachments. Unioning the recent history means a blob
	// survives as long as ANY device still claims it.
	rows, err := db.Query(`
		SELECT vault_alias_id, active_hashes
		FROM vault_blob_manifest_history
		WHERE created_at > NOW() - $1::interval
	`, fmt.Sprintf("%d seconds", int(blobGCGrace.Seconds())))
	if err != nil {
		log.Printf("[Blob-GC] Error fetching manifests: %v\n", err)
		return
	}
	defer rows.Close()

	activeManifests := make(map[string]map[string]bool)
	for rows.Next() {
		var vaultID string
		var hashesJSON []byte
		if err := rows.Scan(&vaultID, &hashesJSON); err != nil {
			continue
		}

		var hashList []string
		if err := json.Unmarshal(hashesJSON, &hashList); err != nil {
			continue
		}
		if activeManifests[vaultID] == nil {
			activeManifests[vaultID] = make(map[string]bool)
		}
		for _, h := range hashList {
			activeManifests[vaultID][h] = true
		}
	}

	// 2. Sweep the physical data directory against that union.
	totalReclaimed, err := collectGarbageBlobs(blobsRoot, activeManifests, time.Now(), blobGCGrace)
	if err != nil {
		log.Printf("[Blob-GC] Error reading blobs directory: %v\n", err)
		return
	}

	if totalReclaimed > 0 {
		atomic.AddUint64(&gcReclaimedBytes, totalReclaimed)
		log.Printf("[Blob-GC] Cleaned up unreferenced blobs on disk, reclaimed %d bytes in %v.\n", totalReclaimed, time.Since(start))
	} else {
		log.Printf("[Blob-GC] Garbage collection finished in %v. No unreferenced blobs to purge.\n", time.Since(start))
	}
}

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, relying on system environment variables")
	}

	port = getEnv("PORT", "3001")
	dbConnStr = getEnv("DATABASE_URL", "postgres://postgres:your_password@localhost:5432/your_db?sslmode=disable")
	adminAPIKey = getEnv("ADMIN_API_KEY", defaultAdminAPIKey)
	accessAPIKey = strings.TrimSpace(getEnv("ACCESS_API_KEY", ""))
	allowedOrigins = parseAllowedOrigins(getEnv("ALLOWED_ORIGINS", ""))
	maxBodyBytes = parsePositiveInt64(getEnv("MAX_BODY_BYTES", ""), 64*1024*1024)
	blobGCGrace = time.Duration(parsePositiveInt64(getEnv("BLOB_GC_GRACE_HOURS", ""), 72)) * time.Hour
	if root := strings.TrimSpace(getEnv("BLOB_STORAGE_DIR", "")); root != "" {
		blobsRoot = root
	}

	if accessAPIKey == "" {
		if getEnv("ALLOW_UNAUTHENTICATED", "") != "true" {
			log.Fatal("ACCESS_API_KEY is not set. Every REST route and the WebSocket would accept " +
				"unauthenticated requests, letting anyone who learns a vault alias push, compact or " +
				"delete. Set ACCESS_API_KEY (the Access API Key from setup_back.sh), or set " +
				"ALLOW_UNAUTHENTICATED=true if something in front of this process already authenticates.")
		}
		log.Println("WARNING: running without ACCESS_API_KEY. Application-layer authentication is disabled.")
	}
	if adminAPIKey == defaultAdminAPIKey {
		log.Println("WARNING: ADMIN_API_KEY is still the shipped default. /api/admin/truncate is disabled until it is changed.")
	}

	var err error
	db, err = sql.Open("postgres", dbConnStr)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		log.Fatalf("Failed to ping database: %v", err)
	}
	log.Println("Database connection established successfully.")

	runMigrations()

	listener := pq.NewListener(dbConnStr, 10*time.Second, time.Minute, func(ev pq.ListenerEventType, err error) {
		if err != nil {
			log.Println("Postgres listener error:", err)
		}
	})

	err = listener.Listen(channel)
	if err != nil {
		log.Fatalf("Could not listen to channel %s: %v", channel, err)
	}
	log.Printf("Connected to PostgreSQL. Listening on channel: %s\n", channel)

	go handleDatabaseNotifications(listener)
	go startTelemetryTracker()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", handleWebSocket)
	mux.HandleFunc("GET /api/telemetry", handleGetTelemetry)
	mux.HandleFunc("GET /api/vault/manifest", handleGetManifest)
	mux.HandleFunc("POST /api/blobs/manifest", handlePostBlobManifest)

	// NEW: Direct-to-Disk Binary Endpoints
	mux.HandleFunc("PUT /api/blobs/{hash}", handlePutBlob)
	mux.HandleFunc("GET /api/blobs/{hash}", handleGetBlob)

	mux.HandleFunc("GET /api/vault/latest_ids", handleGetBulkLatestUpdateIDs)
	mux.HandleFunc("GET /api/snapshots/{id}", handleGetSnapshot)
	mux.HandleFunc("GET /api/snapshots/{id}/updates", handleGetUpdates)
	mux.HandleFunc("GET /api/snapshots/{id}/latest_id", handleGetLatestUpdateID)
	mux.HandleFunc("POST /api/updates", handlePostUpdate)
	mux.HandleFunc("POST /api/snapshots/{id}/compact", handlePostCompact)
	mux.HandleFunc("DELETE /api/snapshots/{id}", handleDeleteSnapshot)
	mux.HandleFunc("POST /api/admin/truncate", handlePostTruncate)

	log.Printf("Realtime WebSocket & REST server running on http://localhost:%s\n", port)
	if err := http.ListenAndServe(":"+port, corsMiddleware(mux)); err != nil {
		log.Fatal("ListenAndServe:", err)
	}
}

type gzipResponseWriter struct {
	io.Writer
	http.ResponseWriter
}

func (g gzipResponseWriter) Write(b []byte) (int, error) {
	return g.Writer.Write(b)
}

func (g gzipResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := g.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("underlying ResponseWriter does not implement http.Hijacker")
}

// presentedAPIKey pulls the access key from the header REST clients use, falling
// back to the query parameter the WebSocket handshake has to use because browsers
// cannot set headers on an upgrade request.
func presentedAPIKey(r *http.Request) string {
	if key := r.Header.Get("X-API-Key"); key != "" {
		return key
	}
	return r.URL.Query().Get("api_key")
}

// isAuthorized reports whether the request carries the access key. When no key is
// configured the server is open, which is why main() refuses to start that way
// unless it is explicitly acknowledged.
func isAuthorized(r *http.Request) bool {
	if accessAPIKey == "" {
		return true
	}
	presented := presentedAPIKey(r)
	return subtle.ConstantTimeCompare([]byte(presented), []byte(accessAPIKey)) == 1
}

// resolveAllowedOrigin returns the value to echo in Access-Control-Allow-Origin,
// or "" when the origin must not be granted cross-origin access. The plugin talks
// through Obsidian's requestUrl, which is not subject to CORS at all, so the
// default of allowing no browser origin costs the client nothing.
func resolveAllowedOrigin(origin string) string {
	if origin == "" {
		return ""
	}
	for _, allowed := range allowedOrigins {
		if allowed == "*" {
			return origin
		}
		if strings.EqualFold(allowed, origin) {
			return origin
		}
	}
	return ""
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddUint64(&reqsLastSecond, 1)
		atomic.AddUint64(&reqsLastHour, 1)
		if r.ContentLength > 0 {
			atomic.AddUint64(&dataTransferred, uint64(r.ContentLength))
		}

		if allowed := resolveAllowedOrigin(r.Header.Get("Origin")); allowed != "" {
			w.Header().Set("Access-Control-Allow-Origin", allowed)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Vault-Alias-ID, X-API-Key")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		if !isAuthorized(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		isWebSocket := strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
			strings.EqualFold(r.Header.Get("Connection"), "upgrade")

		if !isWebSocket && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			gz := gzip.NewWriter(w)
			defer gz.Close()
			gzw := gzipResponseWriter{Writer: gz, ResponseWriter: w}
			next.ServeHTTP(gzw, r)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func runMigrations() {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS vault_snapshots (
			vault_alias_id TEXT NOT NULL DEFAULT '',
			document_id TEXT NOT NULL,
			encrypted_state BYTEA,
			encrypted_path BYTEA,
			is_deleted BOOLEAN DEFAULT false,
			max_compacted_id INT DEFAULT 0,
			updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (vault_alias_id, document_id)
		);`,
		`ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS vault_alias_id TEXT NOT NULL DEFAULT '';`,
		`ALTER TABLE vault_snapshots ADD COLUMN IF NOT EXISTS max_compacted_id INT DEFAULT 0;`,
		`CREATE TABLE IF NOT EXISTS vault_updates (
			id SERIAL PRIMARY KEY,
			vault_alias_id TEXT NOT NULL DEFAULT '',
			document_id TEXT NOT NULL,
			encrypted_update BYTEA,
			created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
		);`,
		`ALTER TABLE vault_updates ADD COLUMN IF NOT EXISTS vault_alias_id TEXT NOT NULL DEFAULT '';`,
		`DO $$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM pg_constraint WHERE conname = 'vault_updates_document_id_fkey'
			) THEN
				ALTER TABLE vault_updates DROP CONSTRAINT vault_updates_document_id_fkey;
			END IF;
		END $$;`,
		`DO $$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM pg_constraint WHERE conname = 'vault_snapshots_pkey' AND array_length(conkey, 1) = 1
			) THEN
				ALTER TABLE vault_snapshots DROP CONSTRAINT vault_snapshots_pkey;
				ALTER TABLE vault_snapshots ADD PRIMARY KEY (vault_alias_id, document_id);
			END IF;
		END $$;`,
		`DO $$
		BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint WHERE conname = 'vault_updates_vault_alias_id_document_id_fkey'
			) THEN
				ALTER TABLE vault_updates ADD CONSTRAINT vault_updates_vault_alias_id_document_id_fkey
					FOREIGN KEY (vault_alias_id, document_id) REFERENCES vault_snapshots(vault_alias_id, document_id) ON DELETE CASCADE;
			END IF;
		EXCEPTION WHEN OTHERS THEN NULL;
		END $$;`,
		`CREATE INDEX IF NOT EXISTS idx_vault_updates_doc_id ON vault_updates(vault_alias_id, document_id);`,
		`CREATE OR REPLACE FUNCTION notify_vault_update()
		RETURNS trigger AS $$
		BEGIN
		  PERFORM pg_notify('vault_updates_channel', json_build_object(
			'type', 'INSERT',
			'table', 'vault_updates',
			'record', json_build_object('vault_alias_id', NEW.vault_alias_id, 'document_id', NEW.document_id, 'id', NEW.id)
		  )::text);
		  RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;`,
		`DROP TRIGGER IF EXISTS vault_update_trigger ON vault_updates;`,
		`CREATE TRIGGER vault_update_trigger
		AFTER INSERT ON vault_updates
		FOR EACH ROW EXECUTE FUNCTION notify_vault_update();`,
		`CREATE TABLE IF NOT EXISTS vault_blob_manifests (
			vault_alias_id TEXT PRIMARY KEY,
			active_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
			updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
		);`,
		// Manifest history: blob GC unions every manifest inside the retention
		// window so one device's partial view cannot delete another device's files.
		`CREATE TABLE IF NOT EXISTS vault_blob_manifest_history (
			id SERIAL PRIMARY KEY,
			vault_alias_id TEXT NOT NULL,
			active_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
			created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE INDEX IF NOT EXISTS idx_blob_manifest_history_vault_created
			ON vault_blob_manifest_history(vault_alias_id, created_at DESC);`,
		// Seed the history from the latest-manifest table so an upgrading server
		// does not start with an empty window and collect everything.
		`INSERT INTO vault_blob_manifest_history (vault_alias_id, active_hashes, created_at)
			SELECT vault_alias_id, active_hashes, updated_at FROM vault_blob_manifests
			WHERE NOT EXISTS (SELECT 1 FROM vault_blob_manifest_history);`,
	}

	for idx, query := range migrations {
		_, err := db.Exec(query)
		if err != nil {
			log.Fatalf("Failed to execute migration step %d: %v", idx+1, err)
		}
	}
}

func hexToBytea(hexStr string) ([]byte, error) {
	if len(hexStr) >= 2 && hexStr[:2] == "\\x" {
		hexStr = hexStr[2:]
	}
	return hex.DecodeString(hexStr)
}

func byteaToHex(b []byte) string {
	if b == nil {
		return ""
	}
	return "\\x" + hex.EncodeToString(b)
}

func getVaultAliasIDHeader(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Vault-Alias-ID"))
}

func handlePutBlob(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	hash := r.PathValue("hash")

	if vaultAliasID == "" || hash == "" {
		http.Error(w, "Missing headers or path param", http.StatusBadRequest)
		return
	}

	// Both values become path segments below. Without this check a header of
	// `../../..` writes anywhere the process can reach.
	if !isSafeStorageSegment(vaultAliasID) || !isSafeStorageSegment(hash) {
		http.Error(w, "Invalid vault alias or blob hash", http.StatusBadRequest)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	dir := filepath.Join(blobsRoot, vaultAliasID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("Disk mkdir error: %v", err)
		http.Error(w, "Disk error", http.StatusInternalServerError)
		return
	}

	filePath := filepath.Join(dir, hash)
	out, err := os.Create(filePath)
	if err != nil {
		log.Printf("Disk create error: %v", err)
		http.Error(w, "Disk error", http.StatusInternalServerError)
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, r.Body); err != nil {
		log.Printf("Disk write error: %v", err)
		http.Error(w, "Write error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func handleGetBlob(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	hash := r.PathValue("hash")

	if vaultAliasID == "" || hash == "" {
		http.Error(w, "Missing headers or path param", http.StatusBadRequest)
		return
	}

	if !isSafeStorageSegment(vaultAliasID) || !isSafeStorageSegment(hash) {
		http.Error(w, "Invalid vault alias or blob hash", http.StatusBadRequest)
		return
	}

	filePath := filepath.Join(blobsRoot, vaultAliasID, hash)

	file, err := os.Open(filePath)
	if os.IsNotExist(err) {
		http.Error(w, "Blob not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "Disk error", http.StatusInternalServerError)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	io.Copy(w, file)
}

func handleGetTelemetry(w http.ResponseWriter, r *http.Request) {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	telemetryMux.Lock()
	rps := currentRPS
	rpm := currentRPM
	telemetryMux.Unlock()

	openConns := 0
	if db != nil {
		openConns = db.Stats().OpenConnections
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ServerTelemetry{
		RPS:                  rps,
		RPMAvgHour:           rpm,
		DataTransferredBytes: atomic.LoadUint64(&dataTransferred),
		ActiveWebSockets:     atomic.LoadInt64(&activeWebSockets),
		UptimeSeconds:        int64(time.Since(startTime).Seconds()),
		MemoryAllocMB:        float64(memStats.Alloc) / 1024 / 1024,
		DBConnections:        openConns,
		SystemHealth:         "healthy",
		GCReclaimedBytes:     atomic.LoadUint64(&gcReclaimedBytes),
	})
}

func handlePostBlobManifest(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	var payload BlobManifestPayload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&payload); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if payload.ActiveHashes == nil {
		payload.ActiveHashes = []string{}
	}

	hashesJSON, err := json.Marshal(payload.ActiveHashes)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	query := `
		INSERT INTO vault_blob_manifests (vault_alias_id, active_hashes, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (vault_alias_id) DO UPDATE
		SET active_hashes = EXCLUDED.active_hashes, updated_at = NOW();
	`

	_, err = db.Exec(query, vaultAliasID, hashesJSON)
	if err != nil {
		log.Printf("Error upserting blob manifest: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	// Append to the history GC unions over, and trim anything past the window.
	if _, err := db.Exec(
		"INSERT INTO vault_blob_manifest_history (vault_alias_id, active_hashes, created_at) VALUES ($1, $2, NOW())",
		vaultAliasID, hashesJSON,
	); err != nil {
		log.Printf("Error appending blob manifest history: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	if _, err := db.Exec(
		"DELETE FROM vault_blob_manifest_history WHERE vault_alias_id = $1 AND created_at < NOW() - $2::interval",
		vaultAliasID, fmt.Sprintf("%d seconds", int((blobGCGrace*2).Seconds())),
	); err != nil {
		log.Printf("Error trimming blob manifest history: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "manifest_received"})
}

func handleGetBulkLatestUpdateIDs(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	query := `
	    SELECT 
	        s.document_id, 
	        GREATEST(COALESCE(s.max_compacted_id, 0), COALESCE(MAX(u.id), 0)) as max_id
	    FROM vault_snapshots s
	    LEFT JOIN vault_updates u ON s.document_id = u.document_id AND s.vault_alias_id = u.vault_alias_id
	    WHERE s.vault_alias_id = $1
	    GROUP BY s.document_id, s.max_compacted_id
	`
	rows, err := db.Query(query, vaultAliasID)
	if err != nil {
		log.Printf("Error fetching bulk latest IDs: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	result := make(map[string]int)
	for rows.Next() {
		var docID string
		var maxID int
		if err := rows.Scan(&docID, &maxID); err != nil {
			continue
		}
		result[docID] = maxID
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func handleGetSnapshot(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	var encState []byte
	var encPath []byte
	var isDeleted bool
	var maxCompactedID int
	var updatedAt time.Time

	err := db.QueryRow("SELECT encrypted_state, encrypted_path, is_deleted, max_compacted_id, updated_at FROM vault_snapshots WHERE vault_alias_id = $1 AND document_id = $2", vaultAliasID, id).
		Scan(&encState, &encPath, &isDeleted, &maxCompactedID, &updatedAt)

	if err == sql.ErrNoRows {
		http.Error(w, "Snapshot not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	type SnapshotRow struct {
		DocumentID     string `json:"document_id"`
		EncryptedState string `json:"encrypted_state,omitempty"`
		EncryptedPath  string `json:"encrypted_path,omitempty"`
		IsDeleted      bool   `json:"is_deleted"`
		MaxCompactedID int    `json:"max_compacted_id"`
		UpdatedAt      string `json:"updated_at"`
	}

	row := SnapshotRow{
		DocumentID:     id,
		EncryptedState: byteaToHex(encState),
		EncryptedPath:  byteaToHex(encPath),
		IsDeleted:      isDeleted,
		MaxCompactedID: maxCompactedID,
		UpdatedAt:      updatedAt.Format(time.RFC3339),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode([]SnapshotRow{row})
}

func handleGetUpdates(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	sinceStr := r.URL.Query().Get("since")
	since := 0
	if sinceStr != "" {
		var err error
		since, err = strconv.Atoi(sinceStr)
		if err != nil {
			http.Error(w, "Invalid since parameter", http.StatusBadRequest)
			return
		}
	}

	rows, err := db.Query("SELECT id, document_id, encrypted_update, created_at FROM vault_updates WHERE vault_alias_id = $1 AND document_id = $2 AND id > $3 ORDER BY id ASC", vaultAliasID, id, since)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type UpdateRow struct {
		ID              int    `json:"id"`
		DocumentID      string `json:"document_id"`
		EncryptedUpdate string `json:"encrypted_update"`
		CreatedAt       string `json:"created_at"`
	}

	var updates []UpdateRow
	for rows.Next() {
		var uID int
		var docID string
		var encUpdate []byte
		var createdAt time.Time

		if err := rows.Scan(&uID, &docID, &encUpdate, &createdAt); err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		updates = append(updates, UpdateRow{
			ID:              uID,
			DocumentID:      docID,
			EncryptedUpdate: byteaToHex(encUpdate),
			CreatedAt:       createdAt.Format(time.RFC3339),
		})
	}

	if updates == nil {
		updates = []UpdateRow{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(updates)
}

func handleGetLatestUpdateID(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	var lastID int
	query := `
	    SELECT GREATEST(
	        COALESCE((SELECT id FROM vault_updates WHERE vault_alias_id = $1 AND document_id = $2 ORDER BY id DESC LIMIT 1), 0),
	        COALESCE((SELECT max_compacted_id FROM vault_snapshots WHERE vault_alias_id = $1 AND document_id = $2), 0)
	    )
	`
	err := db.QueryRow(query, vaultAliasID, id).Scan(&lastID)
	if err == sql.ErrNoRows {
		lastID = 0
	} else if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"id": lastID})
}

func handlePostUpdate(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	var payload UpdatePayload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&payload); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	updateBytes, err := hexToBytea(payload.EncryptedUpdate)
	if err != nil {
		http.Error(w, "Invalid encrypted_update hex format", http.StatusBadRequest)
		return
	}

	var pathBytes []byte
	if payload.EncryptedPath != nil {
		pathBytes, err = hexToBytea(*payload.EncryptedPath)
		if err != nil {
			http.Error(w, "Invalid encrypted_path hex format", http.StatusBadRequest)
			return
		}
	}

	// A straggler push from a device that was offline during a delete must not
	// undelete the document. `is_deleted` is left alone on conflict, and a push
	// aimed at an already-deleted row is refused outright so the client can drop
	// it instead of resurrecting a note the user removed elsewhere.
	if len(pathBytes) > 0 {
		_, err = db.Exec(`
			INSERT INTO vault_snapshots (vault_alias_id, document_id, encrypted_state, encrypted_path, is_deleted, updated_at)
			VALUES ($1, $2, NULL, $3, false, NOW())
			ON CONFLICT (vault_alias_id, document_id) DO UPDATE
			SET encrypted_path = EXCLUDED.encrypted_path, updated_at = NOW()
			WHERE vault_snapshots.is_deleted = false;
		`, vaultAliasID, payload.DocumentID, pathBytes)
	} else {
		_, err = db.Exec(`
			INSERT INTO vault_snapshots (vault_alias_id, document_id, encrypted_state, is_deleted, updated_at)
			VALUES ($1, $2, NULL, false, NOW())
			ON CONFLICT (vault_alias_id, document_id) DO UPDATE
			SET updated_at = NOW()
			WHERE vault_snapshots.is_deleted = false;
		`, vaultAliasID, payload.DocumentID)
	}

	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	var isDeleted bool
	err = db.QueryRow(
		"SELECT is_deleted FROM vault_snapshots WHERE vault_alias_id = $1 AND document_id = $2",
		vaultAliasID, payload.DocumentID,
	).Scan(&isDeleted)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	if isDeleted {
		http.Error(w, "Document is deleted", http.StatusConflict)
		return
	}

	_, err = db.Exec(`
		INSERT INTO vault_updates (vault_alias_id, document_id, encrypted_update, created_at)
		VALUES ($1, $2, $3, NOW());
	`, vaultAliasID, payload.DocumentID, updateBytes)

	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "created"})
}

// isCompactionSafe reports whether a compaction claiming to have merged updates up
// to incomingMaxID may replace a row whose base state already covers existingMaxID.
// Compaction is destructive in both directions -- it overwrites encrypted_state and
// deletes merged update rows -- so it is only ever allowed to move forwards.
func isCompactionSafe(existingMaxID, incomingMaxID int) bool {
	if incomingMaxID < 0 {
		return false
	}
	return incomingMaxID >= existingMaxID
}

func handlePostCompact(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	var payload CompactPayload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&payload); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	stateBytes, err := hexToBytea(payload.PState)
	if err != nil {
		http.Error(w, "Invalid p_state hex format", http.StatusBadRequest)
		return
	}

	var pathBytes []byte
	if payload.PEncryptedPath != nil {
		pathBytes, err = hexToBytea(*payload.PEncryptedPath)
		if err != nil {
			http.Error(w, "Invalid p_encrypted_path hex format", http.StatusBadRequest)
			return
		}
	}

	tx, err := db.Begin()
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	// Compaction replaces the base state and deletes the update rows it claims to
	// have merged, so a client that compacts from a stale document destroys work it
	// never saw. Refuse any compaction that would move max_compacted_id backwards:
	// a client whose own refresh failed reports a lower id than the row already has.
	var existingMaxID int
	err = tx.QueryRow(
		"SELECT max_compacted_id FROM vault_snapshots WHERE vault_alias_id = $1 AND document_id = $2",
		vaultAliasID, id,
	).Scan(&existingMaxID)
	if err != nil && err != sql.ErrNoRows {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	if err == nil && !isCompactionSafe(existingMaxID, payload.PMaxID) {
		http.Error(w, "Stale compaction refused", http.StatusConflict)
		return
	}

	if len(pathBytes) > 0 {
		_, err = tx.Exec(`
			INSERT INTO vault_snapshots (vault_alias_id, document_id, encrypted_state, encrypted_path, is_deleted, max_compacted_id, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
			ON CONFLICT (vault_alias_id, document_id) DO UPDATE
			SET encrypted_state = EXCLUDED.encrypted_state,
				encrypted_path = EXCLUDED.encrypted_path,
				is_deleted = EXCLUDED.is_deleted,
				max_compacted_id = EXCLUDED.max_compacted_id,
				updated_at = NOW();
		`, vaultAliasID, id, stateBytes, pathBytes, payload.PIsDeleted, payload.PMaxID)
	} else {
		_, err = tx.Exec(`
			INSERT INTO vault_snapshots (vault_alias_id, document_id, encrypted_state, is_deleted, max_compacted_id, updated_at)
			VALUES ($1, $2, $3, $4, $5, NOW())
			ON CONFLICT (vault_alias_id, document_id) DO UPDATE
			SET encrypted_state = EXCLUDED.encrypted_state,
				is_deleted = EXCLUDED.is_deleted,
				max_compacted_id = EXCLUDED.max_compacted_id,
				updated_at = NOW();
		`, vaultAliasID, id, stateBytes, payload.PIsDeleted, payload.PMaxID)
	}

	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	_, err = tx.Exec("DELETE FROM vault_updates WHERE vault_alias_id = $1 AND document_id = $2 AND id <= $3", vaultAliasID, id, payload.PMaxID)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(); err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "compacted"})
}

func handleGetManifest(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	rows, err := db.Query("SELECT document_id, encrypted_path, is_deleted, updated_at FROM vault_snapshots WHERE vault_alias_id = $1", vaultAliasID)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type ManifestRow struct {
		DocumentID    string `json:"document_id"`
		EncryptedPath string `json:"encrypted_path,omitempty"`
		IsDeleted     bool   `json:"is_deleted"`
		UpdatedAt     string `json:"updated_at"`
	}

	var manifest []ManifestRow
	for rows.Next() {
		var docID string
		var encPath []byte
		var isDeleted bool
		var updatedAt time.Time

		if err := rows.Scan(&docID, &encPath, &isDeleted, &updatedAt); err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		manifest = append(manifest, ManifestRow{
			DocumentID:    docID,
			EncryptedPath: byteaToHex(encPath),
			IsDeleted:     isDeleted,
			UpdatedAt:     updatedAt.Format(time.RFC3339),
		})
	}

	if manifest == nil {
		manifest = []ManifestRow{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(manifest)
}

func handleDeleteSnapshot(w http.ResponseWriter, r *http.Request) {
	vaultAliasID := getVaultAliasIDHeader(r)
	if vaultAliasID == "" {
		http.Error(w, "X-Vault-Alias-ID header is required", http.StatusBadRequest)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	tx, err := db.Begin()
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	// Clear the base state as well as flagging the row. Leaving `encrypted_state`
	// and `max_compacted_id` behind let a later pull merge the tombstone's content
	// straight back into a client's CRDT, which is how deleted notes came back.
	_, err = tx.Exec(`
		UPDATE vault_snapshots
		SET is_deleted = true, encrypted_state = NULL, max_compacted_id = 0, updated_at = NOW()
		WHERE vault_alias_id = $1 AND document_id = $2
	`, vaultAliasID, id)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	_, err = tx.Exec("DELETE FROM vault_updates WHERE vault_alias_id = $1 AND document_id = $2", vaultAliasID, id)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	_, err = tx.Exec(`
		SELECT pg_notify('vault_updates_channel', json_build_object(
			'type', 'DELETE',
			'table', 'vault_snapshots',
			'record', json_build_object('vault_alias_id', $1::text, 'document_id', $2::text, 'id', 0)
		)::text);
	`, vaultAliasID, id)

	if err := tx.Commit(); err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func handlePostTruncate(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	expectedToken := "Bearer " + adminAPIKey

	// Constant-time compare: this endpoint truncates every table and wipes the
	// blob directory, so a byte-at-a-time timing oracle on it is worth closing.
	if subtle.ConstantTimeCompare([]byte(authHeader), []byte(expectedToken)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if adminAPIKey == defaultAdminAPIKey {
		http.Error(w, "Refusing to truncate while ADMIN_API_KEY is the shipped default", http.StatusForbidden)
		return
	}

	// 1. Truncate database tables
	_, err := db.Exec("TRUNCATE TABLE vault_updates, vault_snapshots, vault_blob_manifests, vault_blob_manifest_history CASCADE;")
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	// 2. Clear physical disk storage
	if err := os.RemoveAll(blobsRoot); err != nil {
		log.Printf("Failed to clear disk blobs: %v", err)
	}
	os.MkdirAll(blobsRoot, 0755)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "truncated"})
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Authenticate and resolve the tenant BEFORE upgrading. The previous order
	// upgraded first and then read whatever alias the peer supplied, so an
	// unauthenticated client could hold an open socket and name its own tenant.
	if !isAuthorized(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	vaultAliasID := r.URL.Query().Get("vault_alias_id")
	if vaultAliasID == "" {
		vaultAliasID = r.Header.Get("X-Vault-Alias-ID")
	}
	if vaultAliasID == "" {
		http.Error(w, "vault_alias_id is required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WebSocket Error] Upgrade failed: %v\n", err)
		return
	}

	client := &Client{
		conn:          conn,
		subscriptions: make(map[string]bool),
		vaultAliasID:  vaultAliasID,
	}

	globalHub.mu.Lock()
	globalHub.clients[client] = true
	globalHub.mu.Unlock()

	atomic.AddInt64(&activeWebSockets, 1)

	// Tell the client the server's current version the moment it connects. A
	// client that missed a NOTIFY while disconnected has no other way to learn
	// it is behind: there is no periodic re-sync, only this one-shot signal on
	// every (re)connect, which the client treats as "diff me against this and
	// catch up whatever's stale" rather than trusting the live stream alone.
	var latestID int
	if err := db.QueryRow(
		"SELECT COALESCE(MAX(id), 0) FROM vault_updates WHERE vault_alias_id = $1",
		vaultAliasID,
	).Scan(&latestID); err == nil {
		versionMsg, _ := json.Marshal(map[string]any{
			"type":      "server_version",
			"latest_id": latestID,
		})
		if err := client.notify(versionMsg); err != nil {
			log.Printf("[WebSocket] Failed to send server_version to new client: %v\n", err)
		}
	} else {
		log.Printf("[WebSocket] Failed to fetch latest_id for server_version: %v\n", err)
	}

	defer func() {
		globalHub.mu.Lock()
		delete(globalHub.clients, client)
		globalHub.mu.Unlock()

		atomic.AddInt64(&activeWebSockets, -1)
		conn.Close()
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var subMsg SubscribeMessage
		if err := json.Unmarshal(msg, &subMsg); err == nil {
			applySubscribeMessage(client, subMsg)
		}
	}
}

// notify writes one payload to a client under a deadline. Without the deadline a
// single stalled peer blocks the notification loop for every other client.
func (c *Client) notify(payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if err := c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

func handleDatabaseNotifications(l *pq.Listener) {
	for {
		select {
		case notification := <-l.Notify:
			if notification == nil {
				continue
			}

			var payload PgPayload
			if err := json.Unmarshal([]byte(notification.Extra), &payload); err != nil {
				continue
			}

			docID := payload.Record.DocumentID
			payloadVaultAliasID := payload.Record.VaultAliasID
			if docID == "" {
				continue
			}

			globalHub.mu.RLock()
			for client := range globalHub.clients {
				client.mu.RLock()
				isSubscribed := client.subscriptions[docID] || client.subscriptions["manifest"]
				clientVaultAliasID := client.vaultAliasID
				client.mu.RUnlock()

				if isSubscribed && payloadVaultAliasID != "" && clientVaultAliasID != "" && payloadVaultAliasID == clientVaultAliasID {
					if err := client.notify([]byte(notification.Extra)); err != nil {
						log.Printf("[WebSocket] Dropping notification for a stalled client: %v\n", err)
					}
				}
			}
			globalHub.mu.RUnlock()

		case <-time.After(90 * time.Second):
			go l.Ping()
		}
	}
}

const defaultAdminAPIKey = "super-secret-admin-token"

// parseAllowedOrigins turns a comma-separated ALLOWED_ORIGINS value into a list.
// An empty value means no browser origin is granted cross-origin access, which is
// the right default: the plugin uses Obsidian's requestUrl and is not a browser.
func parseAllowedOrigins(raw string) []string {
	var origins []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	return origins
}

func parsePositiveInt64(raw string, fallback int64) int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}
