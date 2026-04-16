package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/trigger"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	namespace := os.Getenv("K8S_NAMESPACE")
	if namespace == "" {
		namespace = "boilerhouse"
	}

	// Build scheme with core types and Boilerhouse CRDs.
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		log.Error("failed to add client-go scheme", "error", err)
		os.Exit(1)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		log.Error("failed to add v1alpha1 scheme", "error", err)
		os.Exit(1)
	}

	// Create K8s client.
	cfg, err := ctrl.GetConfig()
	if err != nil {
		log.Error("failed to get kubeconfig", "error", err)
		os.Exit(1)
	}

	k8sClient, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		log.Error("failed to create k8s client", "error", err)
		os.Exit(1)
	}

	// Create and run gateway.
	gw := trigger.NewGateway(k8sClient, namespace, log)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	log.Info("starting trigger gateway", "namespace", namespace)
	if err := gw.Sync(ctx); err != nil && err != context.Canceled {
		log.Error("trigger gateway exited with error", "error", err)
		os.Exit(1)
	}

	log.Info("trigger gateway stopped")
}
