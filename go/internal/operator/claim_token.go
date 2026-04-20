package operator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	"github.com/zdavison/boilerhouse/go/internal/scope"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

const (
	// TokenTTL is the hard upper bound on a scoped token's lifetime, regardless
	// of Claim duration. Long-running Claims will need a separate refresh
	// mechanism (out of scope for v1).
	TokenTTL = 24 * time.Hour
)

// ClaimTokenSecretName returns the canonical Secret name for a given Claim.
func ClaimTokenSecretName(claimName string) string {
	return "claim-key-" + claimName
}

// ensureClaimToken idempotently provisions the Secret backing a scoped API
// token for the given Claim.
//
// Returns the Secret name (so the caller can inject it into the Pod spec) and
// a boolean indicating whether API access is disabled for this workload. When
// disabled is true, no Secret is created and the caller should not inject the
// BOILERHOUSE_API_KEY env var.
func (r *ClaimReconciler) ensureClaimToken(
	ctx context.Context,
	claim *v1alpha1.BoilerhouseClaim,
	wl *v1alpha1.BoilerhouseWorkload,
) (secretName string, disabled bool, err error) {
	scopes := resolveScopes(wl)
	if len(scopes) == 1 && scopes[0] == string(scope.Disabled) {
		return "", true, nil
	}

	secretName = ClaimTokenSecretName(claim.Name)

	var existing corev1.Secret
	getErr := r.Get(ctx, types.NamespacedName{Name: secretName, Namespace: claim.Namespace}, &existing)
	if getErr == nil {
		return secretName, false, nil
	}
	if !apierrors.IsNotFound(getErr) {
		return "", false, fmt.Errorf("getting existing token secret: %w", getErr)
	}

	token, err := generateToken()
	if err != nil {
		return "", false, fmt.Errorf("generating token: %w", err)
	}

	expiresAt := time.Now().UTC().Add(TokenTTL).Format(time.RFC3339)
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: claim.Namespace,
			Labels: map[string]string{
				claimtoken.LabelAPIToken: "true",
				claimtoken.LabelTenant:   claim.Spec.TenantId,
				claimtoken.LabelWorkload: claim.Spec.WorkloadRef,
				claimtoken.LabelClaim:    claim.Name,
			},
			Annotations: map[string]string{
				claimtoken.AnnotationScopes:    strings.Join(scopes, ","),
				claimtoken.AnnotationExpiresAt: expiresAt,
			},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(claim, v1alpha1.GroupVersion.WithKind("BoilerhouseClaim")),
			},
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{
			claimtoken.DataKey: []byte(token),
		},
	}
	if err := r.Create(ctx, secret); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return secretName, false, nil
		}
		return "", false, fmt.Errorf("creating token secret: %w", err)
	}
	return secretName, false, nil
}

// deleteClaimToken removes the token Secret for the Claim if it exists.
// Returns nil when the Secret was absent.
func (r *ClaimReconciler) deleteClaimToken(ctx context.Context, claim *v1alpha1.BoilerhouseClaim) error {
	secretName := ClaimTokenSecretName(claim.Name)
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: secretName, Namespace: claim.Namespace},
	}
	if err := r.Delete(ctx, secret); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("deleting token secret: %w", err)
	}
	return nil
}

func resolveScopes(wl *v1alpha1.BoilerhouseWorkload) []string {
	if wl != nil && wl.Spec.APIAccess != nil && len(wl.Spec.APIAccess.Scopes) > 0 {
		return wl.Spec.APIAccess.Scopes
	}
	return scope.DefaultAgentScopeStrings()
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
