package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"buddyengine/internal/win32"
	"buddyengine/internal/workshop"
)

// App is the Wails-bound application object.
type App struct {
	ctx      context.Context
	overlay  *win32.Overlay
	shop     *workshop.Manager
	stop     chan struct{}
	lastBeat int64 // unix ms of last frontend heartbeat
}

func NewApp() *App {
	return &App{
		shop: workshop.NewManager(),
		stop: make(chan struct{}),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// The HWND may not exist for a few ms; retry.
	go func() {
		for i := 0; i < 100; i++ {
			ov, err := win32.NewOverlay(windowTitle)
			if err == nil {
				a.overlay = ov
				ov.Apply()
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()
}

func (a *App) domReady(ctx context.Context) {
	atomic.StoreInt64(&a.lastBeat, time.Now().UnixMilli())
	go a.cursorLoop()
	go a.desktopLoop()
	go a.watchdogLoop()
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

func (a *App) shutdown(ctx context.Context) {
	close(a.stop)
}

// cursorLoop pushes global cursor position + button state at ~120Hz.
// This is the only mouse input path the frontend uses, so the buddy stays
// interactive even while the overlay window is click-through / unfocused.
func (a *App) cursorLoop() {
	tick := time.NewTicker(8 * time.Millisecond)
	defer tick.Stop()
	var last win32.CursorState
	first := true
	for {
		select {
		case <-a.stop:
			return
		case <-tick.C:
			cs := win32.Cursor()
			if first || cs != last {
				runtime.EventsEmit(a.ctx, "cursor", cs)
				last = cs
				first = false
			}
		}
	}
}

// desktopLoop pushes window + desktop-icon rectangles at ~8Hz.
func (a *App) desktopLoop() {
	tick := time.NewTicker(125 * time.Millisecond)
	defer tick.Stop()
	iconTick := 0
	var icons []win32.IconRect
	for {
		select {
		case <-a.stop:
			return
		case <-tick.C:
			var self uintptr
			if a.overlay != nil {
				self = a.overlay.HWND()
			}
			wins := win32.ListColliderWindows(self)
			// Icons move rarely; refresh every ~2s. Occlusion changes with
			// every window move, so filter on every tick.
			if iconTick%16 == 0 {
				icons = win32.ListDesktopIcons()
			}
			iconTick++
			visibleIcons := win32.FilterVisibleIcons(icons, win32.ListOccluderRects(self))
			runtime.EventsEmit(a.ctx, "desktop", map[string]interface{}{
				"windows": wins,
				"icons":   visibleIcons,
			})
		}
	}
}

// ---------------------------------------------------------------------------
// Bindings callable from the frontend
// ---------------------------------------------------------------------------

// Bootstrap describes the environment the sim runs in (physical pixels).
type Bootstrap struct {
	ScreenW    int32                `json:"screenW"`
	ScreenH    int32                `json:"screenH"`
	WorkBottom int32                `json:"workBottom"`
	Packs      []workshop.PackInfo  `json:"packs"`
	Steam      bool                 `json:"steam"`
}

func (a *App) GetBootstrap() Bootstrap {
	w, h := win32.PrimaryScreenSize()
	_, _, _, wb := win32.PrimaryWorkArea()
	return Bootstrap{
		ScreenW:    w,
		ScreenH:    h,
		WorkBottom: wb,
		Packs:      a.shop.List(),
		Steam:      a.shop.SteamActive(),
	}
}

// SetClickThrough toggles whether mouse input passes through the overlay.
func (a *App) SetClickThrough(enabled bool) {
	if a.overlay != nil {
		a.overlay.SetClickThrough(enabled)
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

// LogError appends frontend/backend errors to %TEMP%\buddyengine.log.
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
