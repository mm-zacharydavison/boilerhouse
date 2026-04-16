package trigger

import (
	"fmt"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
)

// ResolveTenantId extracts or returns the tenant ID from a trigger config and event.
// If tenant.Static is set, it returns that directly.
// If tenant.From is set, it extracts the value from the payload's Raw field
// (which must be a map) using From as a top-level key.
// The Prefix is prepended if configured.
func ResolveTenantId(tenant *v1alpha1.TriggerTenant, payload TriggerPayload) (string, error) {
	if tenant == nil {
		return "", fmt.Errorf("tenant configuration is required")
	}

	// Static tenant: return directly (prefix is still applied).
	if tenant.Static != "" {
		return tenant.Prefix + tenant.Static, nil
	}

	// Dynamic: extract from payload.
	if tenant.From == "" {
		return "", fmt.Errorf("tenant.static or tenant.from must be set")
	}

	rawMap, ok := payload.Raw.(map[string]any)
	if !ok {
		return "", fmt.Errorf("cannot extract tenant from payload: raw is not an object")
	}

	val, ok := rawMap[tenant.From]
	if !ok {
		return "", fmt.Errorf("field %q not found in payload", tenant.From)
	}

	str, ok := val.(string)
	if !ok {
		return "", fmt.Errorf("field %q is not a string", tenant.From)
	}

	return tenant.Prefix + str, nil
}
