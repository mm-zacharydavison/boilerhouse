package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ClaimEndpoint describes the network endpoint for a claimed instance.
type ClaimEndpoint struct {
	// Host is the hostname or IP address.
	// +optional
	Host string `json:"host,omitempty"`
	// Port is the port number.
	// +optional
	Port int `json:"port,omitempty"`
}

// BoilerhouseClaimSpec defines the desired state of a BoilerhouseClaim.
type BoilerhouseClaimSpec struct {
	// TenantId is the unique identifier for the tenant. Restricted to
	// DNS-safe characters: it is embedded in pod labels, claim/instance
	// names, and snapshot paths passed to shell commands.
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`
	TenantId string `json:"tenantId"`
	// WorkloadRef is the name of the BoilerhouseWorkload to claim.
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`
	WorkloadRef string `json:"workloadRef"`
	// Resume controls whether to resume an existing instance.
	// +optional
	Resume *bool `json:"resume,omitempty"`
	// Env is an optional set of environment variables injected into the
	// claimed instance's container. They override workload-level entrypoint
	// env on a key clash, but the reserved BOILERHOUSE_* bootstrap vars always
	// win. This lets a caller pass per-claim configuration or a scoped
	// callback token without baking it into the shared workload definition.
	// +optional
	Env map[string]string `json:"env,omitempty"`
}

// BoilerhouseClaimStatus defines the observed state of a BoilerhouseClaim.
type BoilerhouseClaimStatus struct {
	// Phase is the current phase of the claim.
	// +optional
	// +kubebuilder:validation:Enum=Pending;Active;Releasing;Released;ReleaseFailed;Error
	Phase string `json:"phase,omitempty"`
	// InstanceId is the unique identifier of the claimed instance.
	// +optional
	InstanceId string `json:"instanceId,omitempty"`
	// Endpoint is the network endpoint for the claimed instance.
	// +optional
	Endpoint *ClaimEndpoint `json:"endpoint,omitempty"`
	// Source indicates how the instance was obtained.
	// +optional
	// +kubebuilder:validation:Enum=existing;cold;"cold+data";pool;"pool+data"
	Source string `json:"source,omitempty"`
	// ClaimedAt is the timestamp when the claim was fulfilled.
	// +optional
	ClaimedAt *metav1.Time `json:"claimedAt,omitempty"`
	// Detail provides additional information about the current phase.
	// +optional
	Detail string `json:"detail,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=bhc
// +kubebuilder:printcolumn:name="Tenant",type=string,JSONPath=`.spec.tenantId`
// +kubebuilder:printcolumn:name="Workload",type=string,JSONPath=`.spec.workloadRef`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Endpoint",type=string,JSONPath=`.status.endpoint.host`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// BoilerhouseClaim is the Schema for the boilerhouseclaims API.
type BoilerhouseClaim struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BoilerhouseClaimSpec   `json:"spec,omitempty"`
	Status BoilerhouseClaimStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// BoilerhouseClaimList contains a list of BoilerhouseClaim.
type BoilerhouseClaimList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []BoilerhouseClaim `json:"items"`
}

func init() {
	SchemeBuilder.Register(&BoilerhouseClaim{}, &BoilerhouseClaimList{})
}
