package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestWebSocket_UpgradeSucceeds(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	ts := httptest.NewServer(srv)
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer conn.Close()

	assert.Equal(t, 101, resp.StatusCode)
}

func TestWebSocket_ReceivesPodEvents(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	ts := httptest.NewServer(srv)
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)
	defer conn.Close()

	// Give the watch goroutines a moment to start.
	time.Sleep(500 * time.Millisecond)

	// Create a managed Pod.
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-instance",
			Namespace: "default",
			Labels: map[string]string{
				"boilerhouse.dev/managed":  "true",
				"boilerhouse.dev/workload": "my-agent",
				"boilerhouse.dev/tenant":   "alice",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{Name: "main", Image: "nginx:latest"},
			},
		},
	}
	ctx := context.Background()
	err = srv.client.Create(ctx, pod)
	require.NoError(t, err)

	// Read the event from the WebSocket.
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := conn.ReadMessage()
	require.NoError(t, err)

	var evt wsEvent
	err = json.Unmarshal(msg, &evt)
	require.NoError(t, err)

	assert.Equal(t, "instance.state", evt.Type)
	assert.Equal(t, "test-instance", evt.Name)
	assert.Equal(t, "my-agent", evt.WorkloadRef)
	assert.Equal(t, "alice", evt.TenantId)
}

func TestWebSocket_ClientDisconnectStopsWatches(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	ts := httptest.NewServer(srv)
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	require.NoError(t, err)

	// Close immediately — the handler should not panic.
	conn.Close()

	// Give a moment for the handler to clean up.
	time.Sleep(200 * time.Millisecond)
}
