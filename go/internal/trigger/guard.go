package trigger

import (
	"context"
	"fmt"
)

// Guard checks whether an event for a given tenant should be allowed through.
type Guard interface {
	Check(ctx context.Context, tenantId string, payload TriggerPayload) error
}

// AllowlistGuard only allows tenants whose IDs appear in the TenantIds list.
type AllowlistGuard struct {
	TenantIds   []string
	DenyMessage string
}

// Check returns nil if the tenant is in the allowlist, or an error otherwise.
func (g *AllowlistGuard) Check(_ context.Context, tenantId string, _ TriggerPayload) error {
	for _, id := range g.TenantIds {
		if id == tenantId {
			return nil
		}
	}
	msg := g.DenyMessage
	if msg == "" {
		msg = fmt.Sprintf("tenant %q is not allowed", tenantId)
	}
	return fmt.Errorf("%s", msg)
}
