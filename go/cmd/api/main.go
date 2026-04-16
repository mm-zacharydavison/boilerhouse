package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/api"
)

func main() {
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

	server := api.NewServer(k8sClient, cfg, namespace)

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	host := os.Getenv("LISTEN_HOST")
	if host == "" {
		host = "127.0.0.1"
	}

	addr := fmt.Sprintf("%s:%s", host, port)
	slog.Info("starting API server", "addr", addr)
	if err := http.ListenAndServe(addr, server); err != nil {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
}
