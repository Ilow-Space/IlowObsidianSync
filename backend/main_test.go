package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGzipCompressionMiddleware(t *testing.T) {
	req, _ := http.NewRequest("GET", "/api/telemetry", nil)
	req.Header.Set("Accept-Encoding", "gzip")

	rr := httptest.NewRecorder()

	// Assuming corsMiddleware wraps the multiplexer
	handler := corsMiddleware(http.HandlerFunc(handleGetTelemetry))
	handler.ServeHTTP(rr, req)

	if rr.Header().Get("Content-Encoding") != "gzip" {
		t.Errorf("Expected Content-Encoding to be gzip, got %v", rr.Header().Get("Content-Encoding"))
	}
}

func TestXVaultAliasIDHeaderRequired(t *testing.T) {
	endpoints := []struct {
		method  string
		path    string
		handler http.HandlerFunc
	}{
		{"GET", "/api/vault/manifest", handleGetManifest},
		{"GET", "/api/vault/latest_ids", handleGetBulkLatestUpdateIDs},
		{"GET", "/api/snapshots/test-doc", handleGetSnapshot},
		{"GET", "/api/snapshots/test-doc/updates", handleGetUpdates},
		{"GET", "/api/snapshots/test-doc/latest_id", handleGetLatestUpdateID},
		{"POST", "/api/updates", handlePostUpdate},
		{"POST", "/api/snapshots/test-doc/compact", handlePostCompact},
		{"DELETE", "/api/snapshots/test-doc", handleDeleteSnapshot},
		{"POST", "/api/blobs/manifest", handlePostBlobManifest},
	}

	for _, ep := range endpoints {
		req, _ := http.NewRequest(ep.method, ep.path, nil)
		rr := httptest.NewRecorder()

		ep.handler(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Errorf("Endpoint %s %s: expected status 400 Bad Request when X-Vault-Alias-ID header is missing, got %d", ep.method, ep.path, rr.Code)
		}
	}
}

// --- Path traversal ---------------------------------------------------------

func TestIsSafeStorageSegment(t *testing.T) {
	safe := []string{
		"a1b2c3",
		strings.Repeat("f", 64),
		"vault-alias_01",
	}
	for _, s := range safe {
		if !isSafeStorageSegment(s) {
			t.Errorf("expected %q to be accepted as a storage segment", s)
		}
	}

	unsafe := []string{
		"",
		"..",
		"../etc",
		"..\\windows",
		"a/b",
		"a\\b",
		"C:",
		"with space",
		"dot.segment",
		strings.Repeat("f", 129),
	}
	for _, s := range unsafe {
		if isSafeStorageSegment(s) {
			t.Errorf("expected %q to be rejected as a storage segment", s)
		}
	}
}

func TestPutBlobRejectsTraversalInVaultAlias(t *testing.T) {
	root := t.TempDir()
	withBlobRoot(t, root)

	// The alias is an attacker-controlled header that becomes a path segment.
	// filepath.Join collapses the dot segments, so without validation this lands
	// outside the blob root entirely.
	req := httptest.NewRequest("PUT", "/api/blobs/deadbeef", strings.NewReader("pwned"))
	req.Header.Set("X-Vault-Alias-ID", "../../escaped")
	req.SetPathValue("hash", "deadbeef")

	rr := httptest.NewRecorder()
	handlePutBlob(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for a traversing vault alias, got %d", rr.Code)
	}
	assertNothingOutside(t, root)
}

func TestPutBlobRejectsTraversalInHash(t *testing.T) {
	root := t.TempDir()
	withBlobRoot(t, root)

	req := httptest.NewRequest("PUT", "/api/blobs/x", strings.NewReader("pwned"))
	req.Header.Set("X-Vault-Alias-ID", "abc123")
	req.SetPathValue("hash", "..")

	rr := httptest.NewRecorder()
	handlePutBlob(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for a traversing blob hash, got %d", rr.Code)
	}
	assertNothingOutside(t, root)
}

func TestGetBlobRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	withBlobRoot(t, root)

	secret := filepath.Join(filepath.Dir(root), "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0600); err != nil {
		t.Fatalf("seeding the target file failed: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/blobs/secret.txt", nil)
	req.Header.Set("X-Vault-Alias-ID", "..")
	req.SetPathValue("hash", "secret.txt")

	rr := httptest.NewRecorder()
	handleGetBlob(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for a traversing read, got %d", rr.Code)
	}
	if strings.Contains(rr.Body.String(), "top secret") {
		t.Error("handleGetBlob served a file from outside the blob root")
	}
}

// --- Authentication ---------------------------------------------------------

func TestRequestsWithoutAPIKeyAreRejected(t *testing.T) {
	withAccessKey(t, "s3cret-access-key")

	reached := false
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest("GET", "/api/vault/manifest", nil))

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without an API key, got %d", rr.Code)
	}
	if reached {
		t.Error("an unauthenticated request reached the handler")
	}
}

func TestRequestsWithAPIKeyAreAccepted(t *testing.T) {
	withAccessKey(t, "s3cret-access-key")

	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	header := httptest.NewRequest("GET", "/api/vault/manifest", nil)
	header.Header.Set("X-API-Key", "s3cret-access-key")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, header)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with the header key, got %d", rr.Code)
	}

	// The WebSocket handshake cannot set headers, so the query form must work too.
	query := httptest.NewRequest("GET", "/api/vault/manifest?api_key=s3cret-access-key", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, query)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with the query key, got %d", rr.Code)
	}
}

func TestWebSocketAuthenticatesBeforeUpgrading(t *testing.T) {
	withAccessKey(t, "s3cret-access-key")

	req := httptest.NewRequest("GET", "/?vault_alias_id=abc123", nil)
	rr := httptest.NewRecorder()
	handleWebSocket(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 before any upgrade, got %d", rr.Code)
	}
}

func TestWebSocketRequiresAVaultAlias(t *testing.T) {
	withAccessKey(t, "")

	req := httptest.NewRequest("GET", "/", nil)
	rr := httptest.NewRecorder()
	handleWebSocket(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when no vault alias is supplied, got %d", rr.Code)
	}
}

func TestApplySubscribeMessageIgnoresClientSuppliedAlias(t *testing.T) {
	client := &Client{subscriptions: map[string]bool{}, vaultAliasID: "tenant-a"}

	applySubscribeMessage(client, SubscribeMessage{
		Action:       "subscribe",
		Filter:       "document_id=eq.doc-1",
		VaultAliasID: "tenant-b",
	})

	if client.vaultAliasID != "tenant-a" {
		t.Errorf("a message reassigned the client's tenant to %q", client.vaultAliasID)
	}
	if !client.subscriptions["doc-1"] {
		t.Error("the subscription was not recorded")
	}

	applySubscribeMessage(client, SubscribeMessage{
		Action:  "subscribe_bulk",
		Filters: []string{"document_id=eq.doc-2", "document_id=eq.doc-3"},
	})
	if !client.subscriptions["doc-2"] || !client.subscriptions["doc-3"] {
		t.Error("bulk subscriptions were not recorded")
	}
}

// --- CORS -------------------------------------------------------------------

func TestResolveAllowedOrigin(t *testing.T) {
	previous := allowedOrigins
	t.Cleanup(func() { allowedOrigins = previous })

	allowedOrigins = nil
	if got := resolveAllowedOrigin("https://evil.example"); got != "" {
		t.Errorf("expected no origin to be allowed by default, got %q", got)
	}

	allowedOrigins = []string{"https://app.example"}
	if got := resolveAllowedOrigin("https://app.example"); got != "https://app.example" {
		t.Errorf("expected the allowlisted origin to be echoed, got %q", got)
	}
	if got := resolveAllowedOrigin("https://evil.example"); got != "" {
		t.Errorf("expected a non-allowlisted origin to be refused, got %q", got)
	}
}

func TestCORSHeadersAreNotSentByDefault(t *testing.T) {
	withAccessKey(t, "")
	previous := allowedOrigins
	t.Cleanup(func() { allowedOrigins = previous })
	allowedOrigins = nil

	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/api/telemetry", nil)
	req.Header.Set("Origin", "https://evil.example")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("expected no Access-Control-Allow-Origin by default, got %q", got)
	}
}

// --- Destructive operation guards -------------------------------------------

func TestIsCompactionSafe(t *testing.T) {
	cases := []struct {
		name     string
		existing int
		incoming int
		want     bool
	}{
		{"first compaction of a fresh document", 0, 0, true},
		{"moving forwards", 10, 42, true},
		{"repeating the same point", 42, 42, true},
		{"a client whose own pull failed reports zero", 120, 0, false},
		{"moving backwards", 120, 119, false},
		{"negative id", 0, -1, false},
	}

	for _, tc := range cases {
		if got := isCompactionSafe(tc.existing, tc.incoming); got != tc.want {
			t.Errorf("%s: isCompactionSafe(%d, %d) = %v, want %v", tc.name, tc.existing, tc.incoming, got, tc.want)
		}
	}
}

func TestTruncateRefusesTheDefaultAdminKey(t *testing.T) {
	previous := adminAPIKey
	t.Cleanup(func() { adminAPIKey = previous })
	adminAPIKey = defaultAdminAPIKey

	req := httptest.NewRequest("POST", "/api/admin/truncate", nil)
	req.Header.Set("Authorization", "Bearer "+defaultAdminAPIKey)
	rr := httptest.NewRecorder()
	handlePostTruncate(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403 while the admin key is the shipped default, got %d", rr.Code)
	}
}

func TestTruncateRejectsAWrongAdminKey(t *testing.T) {
	previous := adminAPIKey
	t.Cleanup(func() { adminAPIKey = previous })
	adminAPIKey = "a-real-admin-key"

	req := httptest.NewRequest("POST", "/api/admin/truncate", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rr := httptest.NewRecorder()
	handlePostTruncate(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for a wrong admin key, got %d", rr.Code)
	}
}

// --- Blob garbage collection ------------------------------------------------

func TestCollectGarbageBlobsUnionsManifestsAcrossDevices(t *testing.T) {
	root := t.TempDir()
	vault := "vault1"
	writeAgedBlob(t, root, vault, "hash-alpha", 48*time.Hour)
	writeAgedBlob(t, root, vault, "hash-beta", 48*time.Hour)
	writeAgedBlob(t, root, vault, "hash-orphan", 48*time.Hour)

	// One device sees only alpha (its index was truncated); another still claims
	// beta. The union is what GC must honour.
	union := map[string]map[string]bool{
		vault: {"hash-alpha": true, "hash-beta": true},
	}

	reclaimed, err := collectGarbageBlobs(root, union, time.Now(), 24*time.Hour)
	if err != nil {
		t.Fatalf("collectGarbageBlobs failed: %v", err)
	}

	assertBlobExists(t, root, vault, "hash-alpha")
	assertBlobExists(t, root, vault, "hash-beta")
	assertBlobMissing(t, root, vault, "hash-orphan")

	if reclaimed == 0 {
		t.Error("expected the orphaned blob's bytes to be reported as reclaimed")
	}
}

func TestCollectGarbageBlobsKeepsBlobsInsideTheGracePeriod(t *testing.T) {
	root := t.TempDir()
	vault := "vault1"
	writeAgedBlob(t, root, vault, "hash-fresh", 0)

	// A blob uploaded moments ago cannot be in anyone's manifest yet.
	union := map[string]map[string]bool{vault: {"hash-other": true}}

	if _, err := collectGarbageBlobs(root, union, time.Now(), 24*time.Hour); err != nil {
		t.Fatalf("collectGarbageBlobs failed: %v", err)
	}

	assertBlobExists(t, root, vault, "hash-fresh")
}

func TestCollectGarbageBlobsSkipsVaultsWithoutAManifest(t *testing.T) {
	root := t.TempDir()
	vault := "quiet-vault"
	writeAgedBlob(t, root, vault, "hash-alpha", 90*24*time.Hour)

	if _, err := collectGarbageBlobs(root, map[string]map[string]bool{}, time.Now(), 24*time.Hour); err != nil {
		t.Fatalf("collectGarbageBlobs failed: %v", err)
	}

	assertBlobExists(t, root, vault, "hash-alpha")
}

func TestCollectGarbageBlobsIgnoresAnEmptyManifest(t *testing.T) {
	root := t.TempDir()
	vault := "vault1"
	writeAgedBlob(t, root, vault, "hash-alpha", 90*24*time.Hour)

	// An empty manifest is what a device with no resolved index publishes. Acting
	// on it would delete the whole vault's attachments.
	union := map[string]map[string]bool{vault: {}}

	if _, err := collectGarbageBlobs(root, union, time.Now(), 24*time.Hour); err != nil {
		t.Fatalf("collectGarbageBlobs failed: %v", err)
	}

	assertBlobExists(t, root, vault, "hash-alpha")
}

func TestCollectGarbageBlobsToleratesAMissingRoot(t *testing.T) {
	reclaimed, err := collectGarbageBlobs(filepath.Join(t.TempDir(), "absent"), nil, time.Now(), time.Hour)
	if err != nil {
		t.Fatalf("expected a missing blob root to be harmless, got %v", err)
	}
	if reclaimed != 0 {
		t.Errorf("expected nothing reclaimed, got %d", reclaimed)
	}
}

// --- Config -----------------------------------------------------------------

func TestParseAllowedOrigins(t *testing.T) {
	got := parseAllowedOrigins(" https://a.example , https://b.example ,, ")
	want := []string{"https://a.example", "https://b.example"}

	if len(got) != len(want) {
		t.Fatalf("expected %d origins, got %d (%v)", len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("origin %d: got %q, want %q", i, got[i], want[i])
		}
	}

	if origins := parseAllowedOrigins(""); len(origins) != 0 {
		t.Errorf("expected an empty value to allow nothing, got %v", origins)
	}
}

func TestParsePositiveInt64(t *testing.T) {
	cases := []struct {
		raw      string
		fallback int64
		want     int64
	}{
		{"1024", 10, 1024},
		{"", 10, 10},
		{"nonsense", 10, 10},
		{"0", 10, 10},
		{"-5", 10, 10},
		{"  2048  ", 10, 2048},
	}

	for _, tc := range cases {
		if got := parsePositiveInt64(tc.raw, tc.fallback); got != tc.want {
			t.Errorf("parsePositiveInt64(%q, %d) = %d, want %d", tc.raw, tc.fallback, got, tc.want)
		}
	}
}

// --- helpers ----------------------------------------------------------------

func withBlobRoot(t *testing.T, root string) {
	t.Helper()
	previousRoot, previousMax := blobsRoot, maxBodyBytes
	t.Cleanup(func() {
		blobsRoot = previousRoot
		maxBodyBytes = previousMax
	})
	blobsRoot = root
	maxBodyBytes = 1 << 20
}

func withAccessKey(t *testing.T, key string) {
	t.Helper()
	previous := accessAPIKey
	t.Cleanup(func() { accessAPIKey = previous })
	accessAPIKey = key
}

func writeAgedBlob(t *testing.T, root, vault, hash string, age time.Duration) {
	t.Helper()
	dir := filepath.Join(root, vault)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("creating the vault dir failed: %v", err)
	}
	path := filepath.Join(dir, hash)
	if err := os.WriteFile(path, []byte("blob-"+hash), 0644); err != nil {
		t.Fatalf("writing the blob failed: %v", err)
	}
	stamp := time.Now().Add(-age)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatalf("ageing the blob failed: %v", err)
	}
}

func assertBlobExists(t *testing.T, root, vault, hash string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(root, vault, hash)); err != nil {
		t.Errorf("expected blob %q to survive collection: %v", hash, err)
	}
}

func assertBlobMissing(t *testing.T, root, vault, hash string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(root, vault, hash)); !os.IsNotExist(err) {
		t.Errorf("expected blob %q to be collected", hash)
	}
}

// assertNothingOutside fails if anything was written next to the blob root, which
// is where a traversing request would land.
func assertNothingOutside(t *testing.T, root string) {
	t.Helper()
	parent := filepath.Dir(root)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if filepath.Join(parent, entry.Name()) != root {
			t.Errorf("a request wrote outside the blob root: %s", entry.Name())
		}
	}
}
