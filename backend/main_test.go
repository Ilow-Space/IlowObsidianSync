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
