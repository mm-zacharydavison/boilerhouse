package trigger

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMisconfiguredDriver_AlwaysFails(t *testing.T) {
	drv := &misconfiguredDriver{reason: "no url"}

	_, err := drv.Send(context.Background(), "http://anything", "tg-alice", TriggerPayload{Text: "hi"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "driver misconfigured")
	assert.Contains(t, err.Error(), "no url")
}
