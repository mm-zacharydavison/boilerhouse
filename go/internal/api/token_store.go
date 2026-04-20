package api

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	"github.com/zdavison/boilerhouse/go/internal/scope"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	toolscache "k8s.io/client-go/tools/cache"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// TokenStore is an in-memory index of scoped API tokens, backed by a
// controller-runtime cache watching Secrets labelled
// boilerhouse.dev/api-token=true in the operator namespace.
//
// The hot path is Lookup, which does a sha256 hash of the presented bearer
// token and checks an in-memory map — no K8s API calls on request. The cache's
// informer keeps the map current; on cold-miss the store falls back to a
// scoped List scan.
type TokenStore struct {
	namespace string
	cache     cache.Cache
	client    client.Client

	mu      sync.RWMutex
	entries map[[sha256.Size]byte]tokenEntry
}

type tokenEntry struct {
	ac        AuthContext
	expiresAt time.Time // zero means no hard expiry
}

// NewTokenStore constructs a TokenStore bound to the given namespace. The
// returned store is not usable until Start is called with a live context.
func NewTokenStore(cfg *rest.Config, namespace string) (*TokenStore, error) {
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))

	sel := labels.SelectorFromSet(labels.Set{claimtoken.LabelAPIToken: "true"})
	c, err := cache.New(cfg, cache.Options{
		Scheme:            scheme,
		DefaultNamespaces: map[string]cache.Config{namespace: {}},
		ByObject: map[client.Object]cache.ByObject{
			&corev1.Secret{}: {Label: sel},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("creating cache: %w", err)
	}

	cachedClient, err := client.New(cfg, client.Options{
		Scheme: scheme,
		Cache:  &client.CacheOptions{Reader: c},
	})
	if err != nil {
		return nil, fmt.Errorf("creating cached client: %w", err)
	}

	return &TokenStore{
		namespace: namespace,
		cache:     c,
		client:    cachedClient,
		entries:   map[[sha256.Size]byte]tokenEntry{},
	}, nil
}

// Start registers event handlers, starts the informer cache in a goroutine,
// and blocks until the cache syncs. The caller is responsible for cancelling
// ctx when the process shuts down; doing so stops the goroutine cleanly.
func (s *TokenStore) Start(ctx context.Context) error {
	informer, err := s.cache.GetInformer(ctx, &corev1.Secret{})
	if err != nil {
		return fmt.Errorf("getting informer: %w", err)
	}
	if _, err := informer.AddEventHandler(toolscache.ResourceEventHandlerFuncs{
		AddFunc:    s.onAddOrUpdate,
		UpdateFunc: func(_, newObj interface{}) { s.onAddOrUpdate(newObj) },
		DeleteFunc: s.onDelete,
	}); err != nil {
		return fmt.Errorf("adding event handler: %w", err)
	}

	go func() {
		_ = s.cache.Start(ctx)
	}()

	if !s.cache.WaitForCacheSync(ctx) {
		return fmt.Errorf("token cache failed to sync")
	}
	return nil
}

// Lookup returns the AuthContext bound to the given bearer token, or false
// when the token is unknown or expired. Hot path: in-memory map + sha256.
func (s *TokenStore) Lookup(token string) (AuthContext, bool) {
	if token == "" {
		return AuthContext{}, false
	}
	hash := sha256.Sum256([]byte(token))

	s.mu.RLock()
	entry, ok := s.entries[hash]
	s.mu.RUnlock()
	if ok {
		if !entry.expiresAt.IsZero() && time.Now().After(entry.expiresAt) {
			return AuthContext{}, false
		}
		return entry.ac, true
	}

	// Cold miss: scan the label-filtered Secret set via the cached client.
	// Rare in steady state once the informer has synced; this path mostly
	// handles races during rollout or if a Secret was created out-of-band.
	return s.coldLookup(token)
}

func (s *TokenStore) coldLookup(token string) (AuthContext, bool) {
	var list corev1.SecretList
	if err := s.client.List(context.Background(), &list,
		client.InNamespace(s.namespace),
		client.MatchingLabels{claimtoken.LabelAPIToken: "true"},
	); err != nil {
		return AuthContext{}, false
	}
	for i := range list.Items {
		sec := &list.Items[i]
		raw, ok := sec.Data[claimtoken.DataKey]
		if !ok {
			continue
		}
		if string(raw) == token {
			ac, exp := secretToAuth(sec)
			if !exp.IsZero() && time.Now().After(exp) {
				return AuthContext{}, false
			}
			// Populate the cache for next time.
			hash := sha256.Sum256(raw)
			s.mu.Lock()
			s.entries[hash] = tokenEntry{ac: ac, expiresAt: exp}
			s.mu.Unlock()
			return ac, true
		}
	}
	return AuthContext{}, false
}

func (s *TokenStore) onAddOrUpdate(obj interface{}) {
	sec, ok := obj.(*corev1.Secret)
	if !ok {
		return
	}
	raw, ok := sec.Data[claimtoken.DataKey]
	if !ok {
		return
	}
	ac, exp := secretToAuth(sec)
	hash := sha256.Sum256(raw)

	s.mu.Lock()
	s.entries[hash] = tokenEntry{ac: ac, expiresAt: exp}
	s.mu.Unlock()
}

func (s *TokenStore) onDelete(obj interface{}) {
	sec, ok := obj.(*corev1.Secret)
	if !ok {
		// Informer may deliver a tombstone for objects missed between
		// syncs. Unwrap it; if still not a Secret, bail.
		if tomb, isTomb := obj.(toolscache.DeletedFinalStateUnknown); isTomb {
			sec, ok = tomb.Obj.(*corev1.Secret)
		}
		if !ok {
			return
		}
	}
	raw, ok := sec.Data[claimtoken.DataKey]
	if !ok {
		return
	}
	hash := sha256.Sum256(raw)

	s.mu.Lock()
	delete(s.entries, hash)
	s.mu.Unlock()
}

// secretToAuth decodes a token Secret's labels/annotations into an AuthContext
// and returns the hard-expiry time. A zero expiresAt indicates the Secret did
// not carry an expiry annotation.
func secretToAuth(sec *corev1.Secret) (AuthContext, time.Time) {
	ac := AuthContext{
		Kind:     AuthScoped,
		TenantID: sec.Labels[claimtoken.LabelTenant],
		Workload: sec.Labels[claimtoken.LabelWorkload],
		ClaimID:  sec.Labels[claimtoken.LabelClaim],
		Scopes:   parseScopeCSV(sec.Annotations[claimtoken.AnnotationScopes]),
	}
	var exp time.Time
	if s := sec.Annotations[claimtoken.AnnotationExpiresAt]; s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			exp = t
		}
	}
	return ac, exp
}

func parseScopeCSV(csv string) []scope.Scope {
	if csv == "" {
		return nil
	}
	parts := strings.Split(csv, ",")
	out := make([]scope.Scope, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, scope.Scope(p))
	}
	return out
}
