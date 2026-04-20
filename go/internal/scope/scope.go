// Package scope defines the vocabulary of permissions granted to scoped
// Boilerhouse API tokens. It is a tiny, dependency-free package so both the
// operator (which provisions token Secrets) and the API server (which
// validates them) can share a single source of truth.
package scope

// Scope names a single permission. Stored on Secret annotations as a CSV and
// consulted by API route handlers via RequireScope.
type Scope string

const (
	AgentTriggersRead  Scope = "agent-triggers:read"
	AgentTriggersWrite Scope = "agent-triggers:write"
	SecretsRead        Scope = "secrets:read"
	SecretsWrite       Scope = "secrets:write"
	WorkloadsRead      Scope = "workloads:read"
	IssuesWrite        Scope = "issues:write"
	HealthRead         Scope = "health:read"

	// Disabled is the sentinel written by operators to opt a workload out of
	// API access entirely. When a workload's APIAccess.Scopes is exactly
	// []string{string(Disabled)}, no token Secret is provisioned.
	Disabled Scope = "none"
)

// DefaultAgentScopes is the scope set granted to Claims whose workload does
// not override APIAccess.Scopes.
var DefaultAgentScopes = []Scope{
	AgentTriggersRead,
	AgentTriggersWrite,
	SecretsRead,
	WorkloadsRead,
	HealthRead,
}

// DefaultAgentScopeStrings returns DefaultAgentScopes as raw strings, suitable
// for annotation/storage formats.
func DefaultAgentScopeStrings() []string {
	out := make([]string, len(DefaultAgentScopes))
	for i, s := range DefaultAgentScopes {
		out[i] = string(s)
	}
	return out
}

// Parse converts a CSV-free slice of strings into typed scopes, discarding
// empty entries. Unknown strings are kept verbatim so the API can still reason
// about forward-compat scope names written by newer operators.
func Parse(raw []string) []Scope {
	out := make([]Scope, 0, len(raw))
	for _, s := range raw {
		if s == "" {
			continue
		}
		out = append(out, Scope(s))
	}
	return out
}
