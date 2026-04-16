package api

import (
	"bytes"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

const snapshotHelperPod = "boilerhouse-snapshot-helper"

type snapshotEntry struct {
	TenantId    string `json:"tenantId"`
	WorkloadRef string `json:"workloadRef"`
	Path        string `json:"path"`
}

// listSnapshots returns all snapshots across all workloads.
func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	entries, err := s.discoverSnapshots()
	if err != nil {
		writeJSON(w, http.StatusOK, []snapshotEntry{})
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// listWorkloadSnapshots returns snapshots for a specific workload.
func (s *Server) listWorkloadSnapshots(w http.ResponseWriter, r *http.Request) {
	workloadName := chi.URLParam(r, "name")

	entries, err := s.discoverSnapshots()
	if err != nil {
		writeJSON(w, http.StatusOK, []snapshotEntry{})
		return
	}

	var filtered []snapshotEntry
	for _, e := range entries {
		if e.WorkloadRef == workloadName {
			filtered = append(filtered, e)
		}
	}
	if filtered == nil {
		filtered = []snapshotEntry{}
	}
	writeJSON(w, http.StatusOK, filtered)
}

// discoverSnapshots lists all snapshot files in the snapshots PVC via the helper pod.
// Returns entries parsed from paths like /snapshots/<tenantId>/<workload>.tar.gz
func (s *Server) discoverSnapshots() ([]snapshotEntry, error) {
	cmd := exec.Command("kubectl", "exec", snapshotHelperPod, "-n", s.namespace,
		"--", "find", "/snapshots", "-name", "*.tar.gz", "-type", "f")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, err
	}

	var entries []snapshotEntry
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Path format: /snapshots/<tenantId>/<workload>.tar.gz
		rel := strings.TrimPrefix(line, "/snapshots/")
		parts := strings.SplitN(rel, "/", 2)
		if len(parts) != 2 {
			continue
		}
		tenantId := parts[0]
		workloadRef := strings.TrimSuffix(filepath.Base(parts[1]), ".tar.gz")
		entries = append(entries, snapshotEntry{
			TenantId:    tenantId,
			WorkloadRef: workloadRef,
			Path:        line,
		})
	}
	return entries, nil
}
