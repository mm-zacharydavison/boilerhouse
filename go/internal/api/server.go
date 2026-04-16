package api

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Server is the Boilerhouse REST API server. It translates HTTP requests
// into Kubernetes resource operations using the controller-runtime client.
type Server struct {
	client     client.Client
	restConfig *rest.Config
	namespace  string
	apiKey     string
	router     chi.Router
}

// NewServer creates a new API server backed by the given Kubernetes client.
// The namespace determines where CRDs and Pods are managed.
// If BOILERHOUSE_API_KEY is set, Bearer-token auth is required on all
// routes except /health and /ws.
// The restConfig is optional; when provided it enables the /ws WebSocket
// endpoint for live dashboard event streaming.
func NewServer(k8sClient client.Client, restConfig *rest.Config, namespace string) *Server {
	s := &Server{
		client:     k8sClient,
		restConfig: restConfig,
		namespace:  namespace,
		apiKey:     os.Getenv("BOILERHOUSE_API_KEY"),
	}
	s.router = s.buildRouter()
	return s
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}

func (s *Server) buildRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(s.securityHeaders)

	// WebSocket endpoint — outside auth middleware so the dashboard can
	// connect without an API key (the TS proxy doesn't forward it).
	r.Get("/ws", s.handleWebSocket)

	r.Route("/api/v1", func(r chi.Router) {
		// Health is always accessible (no auth required).
		r.Get("/health", s.getHealth)
		r.Get("/stats", s.getStats)

		// Auth middleware for everything else.
		r.Group(func(r chi.Router) {
			r.Use(s.authMiddleware)

			// Workloads
			r.Post("/workloads", s.createWorkload)
			r.Get("/workloads", s.listWorkloads)
			r.Get("/workloads/{name}", s.getWorkload)
			r.Put("/workloads/{name}", s.updateWorkload)
			r.Delete("/workloads/{name}", s.deleteWorkload)

			// Tenants
			r.Post("/tenants/{id}/claim", s.claimInstance)
			r.Post("/tenants/{id}/release", s.releaseInstance)
			r.Get("/tenants/{id}", s.getTenant)
			r.Get("/tenants", s.listTenants)

			// Instances
			r.Get("/instances", s.listInstances)
			r.Get("/instances/{id}", s.getInstance)
			r.Get("/instances/{id}/logs", s.getInstanceLogs)
			r.Post("/instances/{id}/exec", s.execInInstance)
			r.Post("/instances/{id}/destroy", s.destroyInstance)

			// Secrets
			r.Put("/tenants/{id}/secrets/{name}", s.setSecret)
			r.Get("/tenants/{id}/secrets", s.listSecrets)
			r.Delete("/tenants/{id}/secrets/{name}", s.deleteSecret)

			// Triggers
			r.Post("/triggers", s.createTrigger)
			r.Get("/triggers", s.listTriggers)
			r.Get("/triggers/{id}", s.getTrigger)
			r.Delete("/triggers/{id}", s.deleteTrigger)
		})
	})

	return r
}

// securityHeaders adds standard security headers to every response.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// authMiddleware enforces Bearer-token authentication when BOILERHOUSE_API_KEY
// is configured. If no key is set, all requests are allowed through.
func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.apiKey == "" {
			next.ServeHTTP(w, r)
			return
		}

		auth := r.Header.Get("Authorization")
		if auth == "" {
			writeError(w, http.StatusUnauthorized, "missing Authorization header")
			return
		}

		token := strings.TrimPrefix(auth, "Bearer ")
		if token == auth || token != s.apiKey {
			writeError(w, http.StatusUnauthorized, "invalid API key")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// writeJSON writes v as JSON with the given HTTP status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeError writes a JSON error response.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
