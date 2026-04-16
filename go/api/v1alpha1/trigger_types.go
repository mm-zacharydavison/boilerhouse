package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// TriggerTenant defines how the tenant is determined for a trigger.
type TriggerTenant struct {
	// Static sets a fixed tenant identifier for all events.
	// +optional
	Static string `json:"static,omitempty"`
	// From specifies the source field for the tenant identifier.
	// +optional
	From string `json:"from,omitempty"`
	// Prefix is a prefix applied to the tenant identifier.
	// +optional
	Prefix string `json:"prefix,omitempty"`
}

// TriggerGuard defines a guard condition for a trigger.
type TriggerGuard struct {
	// Type is the type of guard.
	// +optional
	Type string `json:"type,omitempty"`
	// Config is the guard configuration.
	// +optional
	// +kubebuilder:pruning:PreserveUnknownFields
	Config *runtime.RawExtension `json:"config,omitempty"`
}

// BoilerhouseTriggerSpec defines the desired state of a BoilerhouseTrigger.
type BoilerhouseTriggerSpec struct {
	// Type is the trigger type.
	// +kubebuilder:validation:Enum=webhook;slack;telegram;cron
	Type string `json:"type"`
	// WorkloadRef is the name of the BoilerhouseWorkload this trigger targets.
	WorkloadRef string `json:"workloadRef"`
	// Tenant defines how the tenant is determined.
	// +optional
	Tenant *TriggerTenant `json:"tenant,omitempty"`
	// Driver is the driver to use for the trigger.
	// +optional
	Driver string `json:"driver,omitempty"`
	// DriverOptions is a free-form map of driver options.
	// +optional
	// +kubebuilder:pruning:PreserveUnknownFields
	DriverOptions *runtime.RawExtension `json:"driverOptions,omitempty"`
	// Guards is a list of guard conditions.
	// +optional
	Guards []TriggerGuard `json:"guards,omitempty"`
	// Config is a free-form map of trigger configuration.
	// +optional
	// +kubebuilder:pruning:PreserveUnknownFields
	Config *runtime.RawExtension `json:"config,omitempty"`
}

// BoilerhouseTriggerStatus defines the observed state of a BoilerhouseTrigger.
type BoilerhouseTriggerStatus struct {
	// Phase is the current phase of the trigger.
	// +optional
	// +kubebuilder:validation:Enum=Active;Error
	Phase string `json:"phase,omitempty"`
	// Detail provides additional information about the current phase.
	// +optional
	Detail string `json:"detail,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=bht
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=`.spec.type`
// +kubebuilder:printcolumn:name="Workload",type=string,JSONPath=`.spec.workloadRef`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`

// BoilerhouseTrigger is the Schema for the boilerhousetriggers API.
type BoilerhouseTrigger struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BoilerhouseTriggerSpec   `json:"spec,omitempty"`
	Status BoilerhouseTriggerStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// BoilerhouseTriggerList contains a list of BoilerhouseTrigger.
type BoilerhouseTriggerList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []BoilerhouseTrigger `json:"items"`
}

func init() {
	SchemeBuilder.Register(&BoilerhouseTrigger{}, &BoilerhouseTriggerList{})
}
