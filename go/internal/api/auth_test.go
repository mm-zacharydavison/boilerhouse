package api

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/zdavison/boilerhouse/go/internal/scope"
)

func TestRequireScope_AdminAlwaysPasses(t *testing.T) {
	ctx := ContextWithAuth(context.Background(), AuthContext{Kind: AuthAdmin})
	assert.NoError(t, RequireScope(ctx, scope.IssuesWrite))
	assert.NoError(t, RequireScope(ctx, scope.Scope("anything")))
}

func TestRequireScope_ScopedPassesWithMatchingScope(t *testing.T) {
	ctx := ContextWithAuth(context.Background(), AuthContext{
		Kind:   AuthScoped,
		Scopes: []scope.Scope{scope.AgentTriggersWrite, scope.HealthRead},
	})
	assert.NoError(t, RequireScope(ctx, scope.AgentTriggersWrite))
	err := RequireScope(ctx, scope.IssuesWrite)
	assert.ErrorContains(t, err, "missing scope: issues:write")
}

func TestRequireScope_NoAuthContext(t *testing.T) {
	err := RequireScope(context.Background(), scope.HealthRead)
	assert.ErrorContains(t, err, "unauthenticated")
}

func TestRequireOwnTenant_AdminOK(t *testing.T) {
	ctx := ContextWithAuth(context.Background(), AuthContext{Kind: AuthAdmin})
	assert.NoError(t, RequireOwnTenant(ctx, "alice"))
	assert.NoError(t, RequireOwnTenant(ctx, "bob"))
}

func TestRequireOwnTenant_ScopedEnforcesMatch(t *testing.T) {
	ctx := ContextWithAuth(context.Background(), AuthContext{
		Kind:     AuthScoped,
		TenantID: "alice",
	})
	assert.NoError(t, RequireOwnTenant(ctx, "alice"))
	err := RequireOwnTenant(ctx, "bob")
	assert.ErrorContains(t, err, "another tenant")
}

func TestRequireOwnTenant_NoAuthContext(t *testing.T) {
	err := RequireOwnTenant(context.Background(), "alice")
	assert.ErrorContains(t, err, "unauthenticated")
}
