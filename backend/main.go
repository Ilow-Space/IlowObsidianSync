package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"github.com/lib/pq"
)

// Config variables (declared here, assigned in main)
var (
	port      string
	dbConnStr string
	channel   = "vault_updates_channel"
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

func main() {
	// 1. Load .env file
	// We don't fatal crash if it's missing, allowing production to use native env vars
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, relying on system environment variables")
	}

	// Now that the .env is loaded, we can safely pull the variables
	port = getEnv("PORT", "3001")
	dbConnStr = getEnv("DATABASE_URL", "postgres://postgres:your_password@localhost:5432/your_db?sslmode=disable")

	// 2. Setup Postgres Listener
	listener := pq.NewListener(dbConnStr, 10*time.Second, time.Minute, func(ev pq.ListenerEventType, err error) {
		if err != nil {
			log.Println("Postgres listener error:", err)
		}
	})

	err := listener.Listen(channel)
	if err != nil {
		log.Fatalf("Could not listen to channel %s: %v", channel, err)
	}
	log.Printf("Connected to PostgreSQL. Listening on channel: %s\n", channel)

	// 3. Start goroutine to broadcast Postgres events to WebSockets
	go handleDatabaseNotifications(listener)

	// 4. Start WebSocket Server
	http.HandleFunc("/", handleWebSocket)
	log.Printf("Realtime WebSocket Bridge running on ws://localhost:%s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal("ListenAndServe:", err)
	}
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
				isSubscribed := client.subscriptions[docID]
				client.mu.RUnlock()

				if isSubscribed {
					// Send raw JSON string directly to client
					client.conn.WriteMessage(websocket.TextMessage, []byte(notification.Extra))
				}
			}
			globalHub.mu.RUnlock()

		case <-time.After(90 * time.Second):
			// Ping connection to keep it alive
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