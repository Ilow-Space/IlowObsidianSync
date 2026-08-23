package main

import (
	"bufio"
	"compress/gzip"
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
	port        string
	dbConnStr   string
	adminAPIKey string
	channel     = "vault_updates_channel"
	db          *sql.DB
)

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
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Client struct {
	conn          *websocket.Conn
	subscriptions map[string]bool
	vaultAliasID  string
	mu            sync.RWMutex
}

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

func startTelemetryTracker() {
	secTicker := time.NewTicker(1 * time.Second)
	hourTicker := time.NewTicker(1 * time.Hour)

	idleSeconds := 0
	isOptimizing := false

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

			if idleSeconds == 300 && !isOptimizing {
				isOptimizing = true
				go func() {
					runIdleOptimizations()
					isOptimizing = false
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

func runBlobGarbageCollection() {
	if db == nil {
		return
	}
	log.Println("[Blob-GC] Starting background disk blob garbage collection cycle...")
	start := time.Now()

	// 1. Fetch all manifests from the database
	rows, err := db.Query("SELECT vault_alias_id, active_hashes FROM vault_blob_manifests")
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
		if err := json.Unmarshal(hashesJSON, &hashList); err == nil {
			hashSet := make(map[string]bool)
			for _, h := range hashList {
				hashSet[h] = true
			}
			activeManifests[vaultID] = hashSet
		}
	}

	// 2. Scan the local physical data directory
	blobsDir := "./data/blobs"
	vaultDirs, err := os.ReadDir(blobsDir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[Blob-GC] Error reading blobs directory: %v\n", err)
		}
		return
	}

	var totalReclaimed uint64

	for _, vDir := range vaultDirs {
		if !vDir.IsDir() {
			continue
		}
		vaultID := vDir.Name()
		activeHashes, hasManifest := activeManifests[vaultID]

		// Only clean up vaults that have reported a manifest at least once
		if !hasManifest {
			continue
		}

		vaultPath := filepath.Join(blobsDir, vaultID)
		files, err := os.ReadDir(vaultPath)
		if err != nil {
			continue
		}

		for _, file := range files {
			if file.IsDir() {
				continue
			}
			hash := file.Name()
			
			// If the physical file's hash isn't in the active manifest, delete it
			if !activeHashes[hash] {
				filePath := filepath.Join(vaultPath, hash)
				info, err := file.Info()
				if err == nil {
					size := uint64(info.Size())
					if err := os.Remove(filePath); err == nil {
						totalReclaimed += size
					}
				}
			}
		}
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
	adminAPIKey = getEnv("ADMIN_API_KEY", "super-secret-admin-token")

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

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddUint64(&reqsLastSecond, 1)
		atomic.AddUint64(&reqsLastHour, 1)
		if r.ContentLength > 0 {
			atomic.AddUint64(&dataTransferred, uint64(r.ContentLength))
		}

		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Vault-Alias-ID, X-API-Key")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
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

	dir := filepath.Join("./data/blobs", vaultAliasID)
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

	filePath := filepath.Join("./data/blobs", vaultAliasID, hash)

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
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
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
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
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

	if len(pathBytes) > 0 {
		_, err = db.Exec(`
			INSERT INTO vault_snapshots (vault_alias_id, document_id, encrypted_state, encrypted_path, is_deleted, updated_at)
			VALUES ($1, $2, NULL, $3, false, NOW())
			ON CONFLICT (vault_alias_id, document_id) DO UPDATE
			SET encrypted_path = EXCLUDED.encrypted_path, is_deleted = false, updated_at = NOW();
		`, vaultAliasID, payload.DocumentID, pathBytes)
	} else {
		_, err = db.Exec(`
			INSERT INTO vault_snapshots (vault_alias_id, document_id, encrypted_state, is_deleted, updated_at)
			VALUES ($1, $2, NULL, false, NOW())
			ON CONFLICT (vault_alias_id, document_id) DO UPDATE
			SET is_deleted = false, updated_at = NOW();
		`, vaultAliasID, payload.DocumentID)
	}

	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
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
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
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

	_, err = tx.Exec("UPDATE vault_snapshots SET is_deleted = true, updated_at = NOW() WHERE vault_alias_id = $1 AND document_id = $2", vaultAliasID, id)
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

	if authHeader != expectedToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// 1. Truncate database tables
	_, err := db.Exec("TRUNCATE TABLE vault_updates, vault_snapshots, vault_blob_manifests CASCADE;")
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	// 2. Clear physical disk storage
	if err := os.RemoveAll("./data/blobs"); err != nil {
		log.Printf("Failed to clear disk blobs: %v", err)
	}
	os.MkdirAll("./data/blobs", 0755)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "truncated"})
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WebSocket Error] Upgrade failed: %v\n", err)
		return
	}

	vaultAliasID := r.URL.Query().Get("vault_alias_id")
	if vaultAliasID == "" {
		vaultAliasID = r.Header.Get("X-Vault-Alias-ID")
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

	defer func() {
		globalHub.mu.Lock()
		delete(globalHub.clients, client)
		globalHub.mu.Unlock()

		atomic.AddInt64(&activeWebSockets, -1)
		conn.Close()
	}()

	filterRegex := regexp.MustCompile(`document_id=eq\.(.+)`)

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var subMsg SubscribeMessage
		if err := json.Unmarshal(msg, &subMsg); err == nil {
			client.mu.Lock()
			if subMsg.VaultAliasID != "" {
				client.vaultAliasID = subMsg.VaultAliasID
			}

			if subMsg.Action == "subscribe" && subMsg.Filter != "" {
				matches := filterRegex.FindStringSubmatch(subMsg.Filter)
				if len(matches) > 1 {
					docID := matches[1]
					client.subscriptions[docID] = true
				}
			} else if subMsg.Action == "subscribe_bulk" && len(subMsg.Filters) > 0 {
				for _, filterStr := range subMsg.Filters {
					matches := filterRegex.FindStringSubmatch(filterStr)
					if len(matches) > 1 {
						docID := matches[1]
						client.subscriptions[docID] = true
					}
				}
			}
			client.mu.Unlock()
		}
	}
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
					client.conn.WriteMessage(websocket.TextMessage, []byte(notification.Extra))
				}
			}
			globalHub.mu.RUnlock()

		case <-time.After(90 * time.Second):
			go l.Ping()
		}
	}
}

func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}