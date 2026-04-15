package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// BoilerhousePoolSpec defines the desired state of a BoilerhousePool.
type BoilerhousePoolSpec struct {
	// WorkloadRef is the name of the BoilerhouseWorkload to pool.
	WorkloadRef string `json:"workloadRef"`
	// Size is the desired number of warm instances in the pool.
	// +kubebuilder:validation:Minimum=0
	Size int `json:"size"`
	// MaxFillConcurrency limits how many instances can be warming simultaneously.
	// +optional
	// +kubebuilder:validation:Minimum=1
	MaxFillConcurrency *int `json:"maxFillConcurrency,omitempty"`
}

// BoilerhousePoolStatus defines the observed state of a BoilerhousePool.
type BoilerhousePoolStatus struct {
	// Ready is the number of instances ready to serve.
	// +optional
	Ready int `json:"ready,omitempty"`
	// Warming is the number of instances currently warming up.
	// +optional
	Warming int `json:"warming,omitempty"`
	// Phase is the current phase of the pool.
	// +optional
	// +kubebuilder:validation:Enum=Healthy;Degraded;Error
	Phase string `json:"phase,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=bhp
// +kubebuilder:printcolumn:name="Workload",type=string,JSONPath=`.spec.workloadRef`
// +kubebuilder:printcolumn:name="Size",type=integer,JSONPath=`.spec.size`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.ready`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`

// BoilerhousePool is the Schema for the boilerhousepools API.
type BoilerhousePool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BoilerhousePoolSpec   `json:"spec,omitempty"`
	Status BoilerhousePoolStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// BoilerhousePoolList contains a list of BoilerhousePool.
type BoilerhousePoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []BoilerhousePool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&BoilerhousePool{}, &BoilerhousePoolList{})
}
