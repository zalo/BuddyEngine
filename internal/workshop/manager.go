// Package workshop loads buddy/tool content packs.
//
// A pack is a folder containing a manifest.json:
//
//	{
//	  "name": "Sword & Shield Buddy",
//	  "author": "you",
//	  "version": 1,
//	  "llc": "llc_sword_shield.onnx",       // low-level controller (required)
//	  "hlc_strike": "hlc_strike.onnx",      // strike task controller (optional)
//	  "pixelsPerMeter": 140,                // display scale (optional)
//	  "tools": [{ "name": "Sword", "body": "sword" }]
//	}
//
// Packs come from two providers: a local "workshop" folder next to the
// executable (for development and non-Steam sharing) and Steam Workshop
// subscribed items when the Steam client + steam_api64.dll are available.
package workshop

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// PackInfo is the manifest plus provenance, sent to the frontend.
type PackInfo struct {
	ID       string          `json:"id"`
	Source   string          `json:"source"` // "builtin" | "local" | "steam"
	Path     string          `json:"-"`
	Manifest json.RawMessage `json:"manifest"`
	Name     string          `json:"name"`
}

type Manager struct {
	mu    sync.Mutex
	packs map[string]*PackInfo
	steam *steamProvider
}

func NewManager() *Manager {
	m := &Manager{packs: map[string]*PackInfo{}}
	m.steam = newSteamProvider()
	m.Rescan()
	return m
}

func (m *Manager) SteamActive() bool { return m.steam != nil && m.steam.active }

func (m *Manager) List() []PackInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]PackInfo, 0, len(m.packs))
	for _, p := range m.packs {
		out = append(out, *p)
	}
	return out
}

// Rescan reloads packs from the local folder and Steam subscriptions.
func (m *Manager) Rescan() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.packs = map[string]*PackInfo{}

	if exe, err := os.Executable(); err == nil {
		m.scanDir(filepath.Join(filepath.Dir(exe), "workshop"), "local")
	}
	// Also support a workshop folder in the working directory (wails dev).
	if wd, err := os.Getwd(); err == nil {
		m.scanDir(filepath.Join(wd, "workshop"), "local")
	}

	if m.steam != nil && m.steam.active {
		for _, dir := range m.steam.subscribedItemDirs() {
			m.scanDir(dir, "steam")
		}
	}
}

func (m *Manager) scanDir(dir, source string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		packDir := filepath.Join(dir, e.Name())
		if !e.IsDir() {
			continue
		}
		m.loadPack(packDir, source)
	}
	// A workshop item dir may itself be the pack (Steam item folders).
	m.loadPack(dir, source)
}

func (m *Manager) loadPack(dir, source string) {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return
	}
	var meta struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &meta) != nil || meta.Name == "" {
		return
	}
	id := source + ":" + filepath.Base(dir)
	m.packs[id] = &PackInfo{
		ID:       id,
		Source:   source,
		Path:     dir,
		Manifest: raw,
		Name:     meta.Name,
	}
}

// ReadFileBase64 returns a pack-relative file, refusing path traversal.
func (m *Manager) ReadFileBase64(packID, rel string) (string, error) {
	m.mu.Lock()
	p, ok := m.packs[packID]
	m.mu.Unlock()
	if !ok {
		return "", errors.New("unknown pack: " + packID)
	}
	clean := filepath.Clean(rel)
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		return "", errors.New("invalid path")
	}
	full := filepath.Join(p.Path, clean)
	data, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}
