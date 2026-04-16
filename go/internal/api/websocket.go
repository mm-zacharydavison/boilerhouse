package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// wsEvent is the JSON event sent to WebSocket clients.
type wsEvent struct {
	Type        string `json:"type"`
	Name        string `json:"name"`
	Phase       string `json:"phase,omitempty"`
	WorkloadRef string `json:"workloadRef,omitempty"`
	TenantId    string `json:"tenantId,omitempty"`
	Source      string `json:"source,omitempty"`
}

// handleWebSocket upgrades the HTTP connection to a WebSocket and streams
// Kubernetes resource change events to the connected dashboard client.
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if s.restConfig == nil {
		writeError(w, http.StatusInternalServerError, "WebSocket not available: no REST config")
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("websocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Read goroutine to detect client disconnect.
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	events := make(chan wsEvent, 100)

	go s.watchPods(ctx, events)
	go s.watchClaims(ctx, events)

	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-events:
			data, err := json.Marshal(evt)
			if err != nil {
				slog.Error("failed to marshal ws event", "error", err)
				continue
			}
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		}
	}
}

// watchPods watches Pods with the boilerhouse.dev/managed=true label and
// sends instance.state and pool.instance.ready events.
func (s *Server) watchPods(ctx context.Context, events chan<- wsEvent) {
	clientset, err := kubernetes.NewForConfig(s.restConfig)
	if err != nil {
		slog.Error("failed to create clientset for pod watch", "error", err)
		return
	}

	watcher, err := clientset.CoreV1().Pods(s.namespace).Watch(ctx, metav1.ListOptions{
		LabelSelector: "boilerhouse.dev/managed=true",
	})
	if err != nil {
		slog.Error("failed to start pod watch", "error", err)
		return
	}
	defer watcher.Stop()

	// Track previous pool-status per pod to detect transitions to "ready".
	poolStatus := make(map[string]string)

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-watcher.ResultChan():
			if !ok {
				return
			}

			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}

			workload := pod.Labels["boilerhouse.dev/workload"]
			tenant := pod.Labels["boilerhouse.dev/tenant"]

			switch event.Type {
			case watch.Added, watch.Modified:
				events <- wsEvent{
					Type:        "instance.state",
					Name:        pod.Name,
					Phase:       string(pod.Status.Phase),
					WorkloadRef: workload,
					TenantId:    tenant,
				}

				// Check for pool.instance.ready transition.
				currentStatus := pod.Labels["boilerhouse.dev/pool-status"]
				prevStatus := poolStatus[pod.Name]
				if currentStatus == "ready" && prevStatus != "ready" {
					events <- wsEvent{
						Type:        "pool.instance.ready",
						Name:        pod.Name,
						WorkloadRef: workload,
					}
				}
				poolStatus[pod.Name] = currentStatus

			case watch.Deleted:
				events <- wsEvent{
					Type:        "instance.state",
					Name:        pod.Name,
					Phase:       "Deleted",
					WorkloadRef: workload,
					TenantId:    tenant,
				}
				delete(poolStatus, pod.Name)
			}
		}
	}
}

// claimGVR is the GroupVersionResource for BoilerhouseClaim.
var claimGVR = schema.GroupVersionResource{
	Group:    v1alpha1.GroupVersion.Group,
	Version:  v1alpha1.GroupVersion.Version,
	Resource: "boilerhouseclaims",
}

// watchClaims watches BoilerhouseClaim resources using the dynamic client
// and sends tenant.claimed and tenant.released events based on status phase changes.
func (s *Server) watchClaims(ctx context.Context, events chan<- wsEvent) {
	dynClient, err := dynamic.NewForConfig(s.restConfig)
	if err != nil {
		slog.Error("failed to create dynamic client for claim watch", "error", err)
		return
	}

	watcher, err := dynClient.Resource(claimGVR).Namespace(s.namespace).Watch(ctx, metav1.ListOptions{})
	if err != nil {
		slog.Error("failed to start claim watch", "error", err)
		return
	}
	defer watcher.Stop()

	// Track previous phase per claim to detect transitions.
	claimPhase := make(map[string]string)

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-watcher.ResultChan():
			if !ok {
				return
			}

			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}

			claim := &v1alpha1.BoilerhouseClaim{}
			if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, claim); err != nil {
				slog.Error("failed to convert claim", "error", err)
				continue
			}

			switch event.Type {
			case watch.Added, watch.Modified:
				prev := claimPhase[claim.Name]
				current := claim.Status.Phase

				if current == "Active" && prev != "Active" {
					events <- wsEvent{
						Type:        "tenant.claimed",
						Name:        claim.Name,
						TenantId:    claim.Spec.TenantId,
						WorkloadRef: claim.Spec.WorkloadRef,
						Source:      claim.Status.Source,
					}
				}

				if current == "Released" && prev != "Released" {
					events <- wsEvent{
						Type:     "tenant.released",
						Name:     claim.Name,
						TenantId: claim.Spec.TenantId,
					}
				}

				claimPhase[claim.Name] = current

			case watch.Deleted:
				events <- wsEvent{
					Type:     "tenant.released",
					Name:     claim.Name,
					TenantId: claim.Spec.TenantId,
				}
				delete(claimPhase, claim.Name)
			}
		}
	}
}
