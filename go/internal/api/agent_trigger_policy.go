package api

import "time"

// AgentTriggerPolicy bounds what an agent (a scoped-token caller) may create
// via the /agent-triggers routes. The defaults below match the wake-up-tasks
// design doc; cmd/api/main.go may override individual fields from env.
type AgentTriggerPolicy struct {
	// AllowedTypes whitelists trigger types agents may create. Webhook,
	// telegram, slack, etc. are deliberately excluded — they carry secrets
	// and an agent must not be able to provision new inbound channels.
	AllowedTypes []string

	// MinCronInterval is the minimum interval between two consecutive
	// firings of an agent-created cron trigger. Acts as a rate-limit floor.
	MinCronInterval time.Duration

	// MaxTriggersPerTenant caps the total live agent-created triggers per
	// tenant. Counted via label selector before insert.
	MaxTriggersPerTenant int

	// MaxOneShotHorizon is the maximum future delta a one-shot runAt may
	// be from now. Prevents agents from scheduling far-future fires that
	// outlive any reasonable claim/Workload lifetime.
	MaxOneShotHorizon time.Duration

	// MinOneShotDelay is the minimum future delta a one-shot runAt must
	// be from now. Past or near-past times are rejected.
	MinOneShotDelay time.Duration
}

// DefaultAgentTriggerPolicy is the v1 policy: cron + one-shot only, 5m floor,
// 10 triggers per tenant, 30-day horizon, 1-minute floor on one-shot delay.
var DefaultAgentTriggerPolicy = AgentTriggerPolicy{
	AllowedTypes:         []string{"cron", "one-shot"},
	MinCronInterval:      5 * time.Minute,
	MaxTriggersPerTenant: 10,
	MaxOneShotHorizon:    30 * 24 * time.Hour,
	MinOneShotDelay:      1 * time.Minute,
}

// allowsType reports whether t is in the policy's AllowedTypes list.
func (p AgentTriggerPolicy) allowsType(t string) bool {
	for _, a := range p.AllowedTypes {
		if a == t {
			return true
		}
	}
	return false
}
