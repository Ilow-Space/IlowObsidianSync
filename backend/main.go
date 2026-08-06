package main

import (
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"github.com/lib/pq"
)

// Config variables
var (
	port        string
	dbConnStr   string
	adminAPIKey string
	channel     = "vault_updates_channel"
	db          *sql.DB
)

// Upgrader allows cross-origin connections (Obsidian acts as a local origin)
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Client represents a single connected Obsidian app
type Client struct {
	conn          *websocket.Conn
	subscriptions map[string]bool
	mu            sync.RWMutex
}

// Global Hub to track all connected clients safely
type Hub struct {
	clients map[*Client]bool
	mu      sync.RWMutex
}

var globalHub = Hub{
	clients: make(map[*Client]bool),
}

// Incoming plugin message format: {"action": "subscribe", "filter": "document_id=eq.XYZ"}
type SubscribeMessage struct {
	Action string `json:"action"`
	Filter string `json:"filter"`
}

// Postgres NOTIFY payload format
type PgPayload struct {
	Type   string `json:"type"`
	Table  string `json:"table"`
	Record struct {
		DocumentID string `json:"document_id"`
		ID         int    `json:"id"`
	} `json:"record"`
}

// Structs for payload mappings
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

func main() {
	// 1. Load .env file
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, relying on system environment variables")
	}

	port = getEnv("PORT", "3001")
	dbConnStr = getEnv("DATABASE_URL", "postgres://postgres:your_password@localhost:5432/your_db?sslmode=disable")
	adminAPIKey = getEnv("ADMIN_API_KEY", "super-secret-admin-token")

	// 2. Setup Database Connection
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

	// 3. Auto-Migrations
	runMigrations()

	// 4. Setup Postgres Listener for Realtime updates
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

	// 5. Start WebSocket event broadcaster
	go handleDatabaseNotifications(listener)

	// 6. Setup Unified REST & WebSocket ServeMux
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", handleWebSocket)
	mux.HandleFunc("GET /api/snapshots/{id}", handleGetSnapshot)
	mux.HandleFunc("GET /api/snapshots/{id}/updates", handleGetUpdates)
	mux.HandleFunc("GET /api/snapshots/{id}/latest_id", handleGetLatestUpdateID)
	mux.HandleFunc("POST /api/updates", handlePostUpdate)
	mux.HandleFunc("POST /api/snapshots/{id}/compact", handlePostCompact)
	mux.HandleFunc("GET /api/vault/manifest", handleGetManifest)
	mux.HandleFunc("DELETE /api/snapshots/{id}", handleDeleteSnapshot)
	mux.HandleFunc("POST /api/admin/truncate", handlePostTruncate)

	log.Printf("Realtime WebSocket & REST server running on http://localhost:%s\n", port)
	if err := http.ListenAndServe(":"+port, corsMiddleware(mux)); err != nil {
		log.Fatal("ListenAndServe:", err)
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func runMigrations() {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS vault_snapshots (
			document_id TEXT PRIMARY KEY,
			encrypted_state BYTEA,
			encrypted_path BYTEA,
			is_deleted BOOLEAN DEFAULT false,
			updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS vault_updates (
			id SERIAL PRIMARY KEY,
			document_id TEXT NOT NULL REFERENCES vault_snapshots(document_id) ON DELETE CASCADE,
			encrypted_update BYTEA,
			created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE INDEX IF NOT EXISTS idx_vault_updates_doc_id ON vault_updates(document_id);`,
		`CREATE OR REPLACE FUNCTION notify_vault_update()
		RETURNS trigger AS $$
		BEGIN
		  PERFORM pg_notify('vault_updates_channel', json_build_object(
			'type', 'INSERT',
			'table', 'vault_updates',
			'record', json_build_object('document_id', NEW.document_id, 'id', NEW.id)
		  )::text);
		  RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;`,
		`DROP TRIGGER IF EXISTS vault_update_trigger ON vault_updates;`,
		`CREATE TRIGGER vault_update_trigger
		AFTER INSERT ON vault_updates
		FOR EACH ROW EXECUTE FUNCTION notify_vault_update();`,
	}

	for idx, query := range migrations {
		log.Printf("Executing migration step %d...", idx+1)
		_, err := db.Exec(query)
		if err != nil {
			log.Fatalf("Failed to execute migration step %d: %v", idx+1, err)
		}
	}
	log.Println("All database migrations executed successfully.")
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

func handleGetSnapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	var encState []byte
	var encPath []byte
	var isDeleted bool
	var updatedAt time.Time

	err := db.QueryRow("SELECT encrypted_state, encrypted_path, is_deleted, updated_at FROM vault_snapshots WHERE document_id = $1", id).
		Scan(&encState, &encPath, &isDeleted, &updatedAt)

	if err == sql.ErrNoRows {
		http.Error(w, "Snapshot not found", http.StatusNotFound)
		return
	} else if err != nil {
		log.Printf("Error fetching snapshot %s: %v", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	type SnapshotRow struct {
		DocumentID     string `json:"document_id"`
		EncryptedState string `json:"encrypted_state,omitempty"`
		EncryptedPath  string `json:"encrypted_path,omitempty"`
		IsDeleted      bool   `json:"is_deleted"`
		UpdatedAt      string `json:"updated_at"`
	}

	row := SnapshotRow{
		DocumentID:     id,
		EncryptedState: byteaToHex(encState),
		EncryptedPath:  byteaToHex(encPath),
		IsDeleted:      isDeleted,
		UpdatedAt:      updatedAt.Format(time.RFC3339),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode([]SnapshotRow{row})
}

func handleGetUpdates(w http.ResponseWriter, r *http.Request) {
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

	rows, err := db.Query("SELECT id, document_id, encrypted_update, created_at FROM vault_updates WHERE document_id = $1 AND id > $2 ORDER BY id ASC", id, since)
	if err != nil {
		log.Printf("Error fetching updates for %s: %v", id, err)
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
			log.Printf("Error scanning update row: %v", err)
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
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	var lastID int
	err := db.QueryRow("SELECT id FROM vault_updates WHERE document_id = $1 ORDER BY id DESC LIMIT 1", id).Scan(&lastID)
	if err == sql.ErrNoRows {
		lastID = 0
	} else if err != nil {
		log.Printf("Error getting latest update ID for %s: %v", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"id": lastID})
}

func handlePostUpdate(w http.ResponseWriter, r *http.Request) {
	var payload UpdatePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if payload.DocumentID == "" {
		http.Error(w, "Missing document_id", http.StatusBadRequest)
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

	// 1. Ensure vault_snapshots row exists, update path if provided
	if len(pathBytes) > 0 {
		_, err = db.Exec(`
			INSERT INTO vault_snapshots (document_id, encrypted_state, encrypted_path, is_deleted, updated_at)
			VALUES ($1, NULL, $2, false, NOW())
			ON CONFLICT (document_id) DO UPDATE
			SET encrypted_path = EXCLUDED.encrypted_path, is_deleted = false, updated_at = NOW();
		`, payload.DocumentID, pathBytes)
	} else {
		_, err = db.Exec(`
			INSERT INTO vault_snapshots (document_id, encrypted_state, is_deleted, updated_at)
			VALUES ($1, NULL, false, NOW())
			ON CONFLICT (document_id) DO UPDATE
			SET is_deleted = false, updated_at = NOW();
		`, payload.DocumentID)
	}

	if err != nil {
		log.Printf("Error ensuring snapshot for %s: %v", payload.DocumentID, err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	// 2. Insert into vault_updates
	_, err = db.Exec(`
		INSERT INTO vault_updates (document_id, encrypted_update, created_at)
		VALUES ($1, $2, NOW());
	`, payload.DocumentID, updateBytes)

	if err != nil {
		log.Printf("Error pushing update for %s: %v", payload.DocumentID, err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "created"})
}

func handlePostCompact(w http.ResponseWriter, r *http.Request) {
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
		log.Printf("Error starting transaction: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	// 1. Update snapshot
	if len(pathBytes) > 0 {
		_, err = tx.Exec(`
			INSERT INTO vault_snapshots (document_id, encrypted_state, encrypted_path, is_deleted, updated_at)
			VALUES ($1, $2, $3, $4, NOW())
			ON CONFLICT (document_id) DO UPDATE
			SET encrypted_state = EXCLUDED.encrypted_state,
				encrypted_path = EXCLUDED.encrypted_path,
				is_deleted = EXCLUDED.is_deleted,
				updated_at = NOW();
		`, id, stateBytes, pathBytes, payload.PIsDeleted)
	} else {
		_, err = tx.Exec(`
			INSERT INTO vault_snapshots (document_id, encrypted_state, is_deleted, updated_at)
			VALUES ($1, $2, $3, NOW())
			ON CONFLICT (document_id) DO UPDATE
			SET encrypted_state = EXCLUDED.encrypted_state,
				is_deleted = EXCLUDED.is_deleted,
				updated_at = NOW();
		`, id, stateBytes, payload.PIsDeleted)
	}

	if err != nil {
		log.Printf("Error updating snapshot in transaction: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	// 2. Delete updates with id <= max_id
	_, err = tx.Exec("DELETE FROM vault_updates WHERE document_id = $1 AND id <= $2", id, payload.PMaxID)
	if err != nil {
		log.Printf("Error deleting updates in transaction: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(); err != nil {
		log.Printf("Error committing transaction: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "compacted"})
}

func handleGetManifest(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query("SELECT document_id, encrypted_path, is_deleted, updated_at FROM vault_snapshots")
	if err != nil {
		log.Printf("Error fetching manifest: %v", err)
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
			log.Printf("Error scanning manifest row: %v", err)
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
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Missing document ID", http.StatusBadRequest)
		return
	}

	tx, err := db.Begin()
	if err != nil {
		log.Printf("Error starting transaction: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	// Update vault_snapshots
	_, err = tx.Exec("UPDATE vault_snapshots SET is_deleted = true, updated_at = NOW() WHERE document_id = $1", id)
	if err != nil {
		log.Printf("Error marking snapshot as deleted: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	// Delete updates
	_, err = tx.Exec("DELETE FROM vault_updates WHERE document_id = $1", id)
	if err != nil {
		log.Printf("Error deleting updates for %s: %v", id, err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	// Notify clients of the deletion via pg_notify
	_, err = tx.Exec(`
		SELECT pg_notify('vault_updates_channel', json_build_object(
			'type', 'DELETE',
			'table', 'vault_snapshots',
			'record', json_build_object('document_id', $1, 'id', 0)
		)::text);
	`, id)
	if err != nil {
		log.Printf("Error notifying deletion for %s: %v", id, err)
	}

	if err := tx.Commit(); err != nil {
		log.Printf("Error committing delete transaction: %v", err)
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

	_, err := db.Exec("TRUNCATE TABLE vault_updates, vault_snapshots CASCADE;")
	if err != nil {
		log.Printf("Error truncating tables: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "truncated"})
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}

	client := &Client{
		conn:          conn,
		subscriptions: make(map[string]bool),
	}

	// Register client
	globalHub.mu.Lock()
	globalHub.clients[client] = true
	globalHub.mu.Unlock()

	defer func() {
		globalHub.mu.Lock()
		delete(globalHub.clients, client)
		globalHub.mu.Unlock()
		conn.Close()
	}()

	filterRegex := regexp.MustCompile(`document_id=eq\.(.+)`)

	// Listen for incoming messages from the plugin
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var subMsg SubscribeMessage
		if err := json.Unmarshal(msg, &subMsg); err == nil {
			if subMsg.Action == "subscribe" && subMsg.Filter != "" {
				matches := filterRegex.FindStringSubmatch(subMsg.Filter)
				if len(matches) > 1 {
					docID := matches[1]
					client.mu.Lock()
					client.subscriptions[docID] = true
					client.mu.Unlock()
				}
			}
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
				log.Println("Error parsing PG notification:", err)
				continue
			}

			docID := payload.Record.DocumentID
			if docID == "" {
				continue
			}

			// Broadcast to interested clients
			globalHub.mu.RLock()
			for client := range globalHub.clients {
				client.mu.RLock()
				isSubscribed := client.subscriptions[docID] || client.subscriptions["manifest"]
				client.mu.RUnlock()

				if isSubscribed {
					// Send raw JSON string directly to client
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
