package api

import (
	"context"
	"fmt"

	"github.com/zdavison/boilerhouse/go/internal/scope"
)

// AuthKind distinguishes admin-grade and scoped tokens on the request context.
type AuthKind int

const (
	// AuthAdmin is the global BOILERHOUSE_API_KEY. Holds every scope.
	AuthAdmin AuthKind = iota
	// AuthScoped is a per-Claim token with an explicit scope set and tenant
	// binding.
	AuthScoped
)

// AuthContext carries the identity and permissions of the authenticated
// caller. It is attached to the request context by authMiddleware.
type AuthContext struct {
	Kind     AuthKind
	TenantID string
	Workload string
	ClaimID  string
	Scopes   []scope.Scope
}

// HasScope reports whether the caller is authorized for the given scope.
// Admin callers always pass.
func (a AuthContext) HasScope(s scope.Scope) bool {
	if a.Kind == AuthAdmin {
		return true
	}
	for _, have := range a.Scopes {
		if have == s {
			return true
		}
	}
	return false
}

type ctxKey int

const authCtxKey ctxKey = 0

// ContextWithAuth attaches an AuthContext to ctx.
func ContextWithAuth(ctx context.Context, ac AuthContext) context.Context {
	return context.WithValue(ctx, authCtxKey, ac)
}

// AuthFromContext retrieves the AuthContext from ctx, or returns zero + false
// when no authentication has been performed.
func AuthFromContext(ctx context.Context) (AuthContext, bool) {
	ac, ok := ctx.Value(authCtxKey).(AuthContext)
	return ac, ok
}

// RequireScope returns nil if the request is authorized for the given scope,
// or a descriptive error suitable for 403 responses.
func RequireScope(ctx context.Context, s scope.Scope) error {
	ac, ok := AuthFromContext(ctx)
	if !ok {
		return fmt.Errorf("unauthenticated")
	}
	if ac.HasScope(s) {
		return nil
	}
	return fmt.Errorf("missing scope: %s", s)
}

// RequireOwnTenant returns nil if the request is operating against its own
// tenant (or is an admin caller, which spans all tenants). It MUST be called
// by every scoped-token route handler that accepts a tenantId parameter.
func RequireOwnTenant(ctx context.Context, tenantID string) error {
	ac, ok := AuthFromContext(ctx)
	if !ok {
		return fmt.Errorf("unauthenticated")
	}
	if ac.Kind == AuthAdmin {
		return nil
	}
	if ac.TenantID != tenantID {
		return fmt.Errorf("cannot access another tenant's resources")
	}
	return nil
}
