package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
