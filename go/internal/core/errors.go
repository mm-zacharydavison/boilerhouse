package core

import "fmt"

// InvalidTransitionError indicates an illegal state-machine transition.
type InvalidTransitionError struct {
	Entity string
	From   string
	Event  string
}

func (e *InvalidTransitionError) Error() string {
	return fmt.Sprintf("invalid %s transition: cannot apply event %q from state %q", e.Entity, e.Event, e.From)
}
