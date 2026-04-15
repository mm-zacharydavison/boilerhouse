package trigger

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
)

// WebhookAdapter starts an HTTP server that receives POST requests and converts
// them into TriggerPayload events.
type WebhookAdapter struct {
	path       string
	listenAddr string
	server     *http.Server
	// boundAddr is set after Start and contains the actual listen address
	// (useful when port 0 is used for ephemeral allocation).
	boundAddr string
}

// NewWebhookAdapter creates a new WebhookAdapter that listens on the given
// address and path.
func NewWebhookAdapter(path string, listenAddr string) *WebhookAdapter {
	return &WebhookAdapter{
		path:       path,
		listenAddr: listenAddr,
	}
}

// Start begins listening for webhook events. It blocks until ctx is cancelled
// or the server is stopped.
func (w *WebhookAdapter) Start(ctx context.Context, handler EventHandler) error {
	mux := http.NewServeMux()
	mux.HandleFunc(w.path, func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(rw, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(rw, "failed to read body", http.StatusBadRequest)
			return
		}
		defer r.Body.Close()

		var raw any
		if len(body) > 0 {
			if err := json.Unmarshal(body, &raw); err != nil {
				// If not valid JSON, use the raw string.
				raw = string(body)
			}
		}

		payload := TriggerPayload{
			Source: "webhook",
			Raw:    raw,
		}

		result, err := handler(r.Context(), payload)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}

		rw.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(rw).Encode(result); err != nil {
			http.Error(rw, "failed to encode response", http.StatusInternalServerError)
		}
	})

	w.server = &http.Server{
		Handler: mux,
	}

	ln, err := net.Listen("tcp", w.listenAddr)
	if err != nil {
		return fmt.Errorf("webhook adapter listen: %w", err)
	}
	w.boundAddr = ln.Addr().String()

	go func() {
		<-ctx.Done()
		w.Stop()
	}()

	if err := w.server.Serve(ln); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("webhook adapter serve: %w", err)
	}
	return nil
}

// Stop gracefully shuts down the webhook HTTP server.
func (w *WebhookAdapter) Stop() error {
	if w.server == nil {
		return nil
	}
	return w.server.Shutdown(context.Background())
}

// BoundAddr returns the actual address the server is listening on.
// Only valid after Start has been called.
func (w *WebhookAdapter) BoundAddr() string {
	return w.boundAddr
}
