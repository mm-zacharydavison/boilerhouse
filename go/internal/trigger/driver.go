package trigger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Driver sends a trigger payload to an instance endpoint and returns the response.
type Driver interface {
	Send(ctx context.Context, endpoint, tenantId string, payload TriggerPayload) (any, error)
}

// DefaultDriver sends the payload as an HTTP POST with JSON body to the instance endpoint.
type DefaultDriver struct {
	HTTPClient *http.Client
}

// NewDefaultDriver creates a DefaultDriver with the given HTTP client.
// If httpClient is nil, http.DefaultClient is used.
func NewDefaultDriver(httpClient *http.Client) *DefaultDriver {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &DefaultDriver{HTTPClient: httpClient}
}

// Send POSTs the payload as JSON to the endpoint and returns the parsed response body.
func (d *DefaultDriver) Send(ctx context.Context, endpoint, _ string, payload TriggerPayload) (any, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("driver: marshal payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("driver: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := d.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("driver: send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("driver: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("driver: endpoint returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result any
	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &result); err != nil {
			// Return raw string if not valid JSON.
			return string(respBody), nil
		}
	}

	return result, nil
}

// misconfiguredDriver denies every event with a fixed reason. Used when
// buildDriver cannot construct a usable driver (unknown name, unresolvable
// secret). Consistent with APIGuard's misconfigured state.
type misconfiguredDriver struct {
	reason string
}

func (d *misconfiguredDriver) Send(_ context.Context, _, _ string, _ TriggerPayload) (any, error) {
	return nil, fmt.Errorf("driver misconfigured: %s", d.reason)
}
