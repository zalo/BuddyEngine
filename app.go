package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"buddyengine/internal/workshop"
)

// Platform-specific files provide the App struct (Windows adds the overlay
// and tray handles), startup/domReady/shutdown, GetBootstrap and
// SetClickThrough. Everything here is shared.

func NewApp() *App {
	return &App{
		shop: workshop.NewManager(),
		stop: make(chan struct{}),
	}
}

// Bootstrap describes the environment the sim runs in (physical pixels).
type Bootstrap struct {
	ScreenW    int32               `json:"screenW"`
	ScreenH    int32               `json:"screenH"`
	WorkBottom int32               `json:"workBottom"`
	Packs      []workshop.PackInfo `json:"packs"`
	Steam      bool                `json:"steam"`
}

// watchdogLoop reloads the frontend if its heartbeat stops (unhandled JS
// error, WASM OOM, lost WebGL context — all of which are invisible in a
// transparent overlay).
func (a *App) watchdogLoop() {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-a.stop:
			return
		case <-tick.C:
			last := atomic.LoadInt64(&a.lastBeat)
			if last == 0 {
				continue
			}
			stale := time.Now().UnixMilli() - last
			if stale > 12000 {
				a.LogError(fmt.Sprintf("watchdog: no heartbeat for %dms, reloading frontend", stale))
				atomic.StoreInt64(&a.lastBeat, time.Now().UnixMilli())
				runtime.WindowReloadApp(a.ctx)
			}
		}
	}
}

// ReadPackFile returns a file from a workshop pack as base64.
func (a *App) ReadPackFile(packID string, rel string) (string, error) {
	return a.shop.ReadFileBase64(packID, rel)
}

// RefreshPacks rescans local + Steam workshop content.
func (a *App) RefreshPacks() []workshop.PackInfo {
	a.shop.Rescan()
	return a.shop.List()
}

// Heartbeat is called by the frontend every second; feeds the watchdog.
func (a *App) Heartbeat() {
	atomic.StoreInt64(&a.lastBeat, time.Now().UnixMilli())
}

// LogError appends frontend/backend errors to <tmp>/buddyengine.log.
func (a *App) LogError(msg string) {
	path := filepath.Join(os.TempDir(), "buddyengine.log")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "[%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
}

// Quit exits the app (invoked from the buddy context menu).
func (a *App) Quit() {
	runtime.Quit(a.ctx)
}
