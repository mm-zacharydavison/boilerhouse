package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/api"
)

// shutdownGrace bounds how long Server.Shutdown waits for in-flight
// requests to drain on SIGTERM before the process exits anyway.
const shutdownGrace = 15 * time.Second

func main() {
	// Configure controller-runtime's logger so client-go informers stop
	// emitting "log.SetLogger was never called" stack traces.
	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

	// Build scheme: core K8s types + Boilerhouse CRDs.
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = networkingv1.AddToScheme(scheme)
	_ = v1alpha1.AddToScheme(scheme)

	// Create controller-runtime client from kubeconfig (or in-cluster config).
	cfg, err := ctrl.GetConfig()
	if err != nil {
		slog.Error("failed to get kubeconfig", "error", err)
		os.Exit(1)
	}

	k8sClient, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		slog.Error("failed to create k8s client", "error", err)
		os.Exit(1)
	}

	namespace := os.Getenv("K8S_NAMESPACE")
	if namespace == "" {
		namespace = "boilerhouse"
	}

	// Root context cancelled on SIGINT/SIGTERM; used to shut down the token
	// store's informer when the process exits.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	tokens, err := api.NewTokenStore(cfg, namespace)
	if err != nil {
		slog.Error("failed to create token store", "error", err)
		os.Exit(1)
	}
	if err := tokens.Start(ctx); err != nil {
		slog.Error("failed to start token store", "error", err)
		os.Exit(1)
	}

	server := api.NewServer(k8sClient, cfg, namespace, tokens)

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	host := os.Getenv("LISTEN_HOST")
	if host == "" {
		host = "127.0.0.1"
	}

	addr := fmt.Sprintf("%s:%s", host, port)
	srv := &http.Server{Addr: addr, Handler: server}

	// On SIGINT/SIGTERM (ctx.Done), stop accepting new connections and drain
	// in-flight requests for up to shutdownGrace. Prevents claim mutations
	// from being killed mid-flight during a deploy.
	go func() {
		<-ctx.Done()
		slog.Info("shutting down API server", "timeout", shutdownGrace)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("server shutdown failed", "error", err)
		}
	}()

	slog.Info("starting API server", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
	slog.Info("server stopped")
}
