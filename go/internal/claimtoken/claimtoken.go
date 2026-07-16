// Package claimtoken defines the on-the-wire shape of the K8s Secret that
// holds a scoped Boilerhouse API token. It is intentionally tiny and
// dependency-free so both the operator (which writes these Secrets) and the
// API server (which reads them) can agree on one source of truth.
package claimtoken

// Label keys attached to every token Secret. LabelAPIToken is the primary
// selector used by the API server's cache; the others are metadata for
// operators and debuggers.
const (
	LabelAPIToken = "boilerhouse.dev/api-token"
	LabelTenant   = "boilerhouse.dev/tenant"
	LabelWorkload = "boilerhouse.dev/workload"
	LabelClaim    = "boilerhouse.dev/claim"
)

// Annotation keys holding non-label metadata on token Secrets.
const (
	AnnotationScopes    = "boilerhouse.dev/token-scopes"
	AnnotationExpiresAt = "boilerhouse.dev/token-expires-at"
)

// DataKey is the Secret.Data entry holding the hex-encoded token bytes.
const DataKey = "token"

// AnnotationOriginatingTrigger is set on a Claim when the trigger gateway's
// ensureClaim creates (or reuses) the Claim in response to a trigger firing.
// It records the name of the BoilerhouseTrigger that started the session so
// the API can resolve the session's reply channel from it.
const AnnotationOriginatingTrigger = "boilerhouse.dev/originating-trigger"
