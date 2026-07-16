package main

import (
	"context"
	"sync/atomic"
	"time"

	"buddyengine/internal/workshop"
)

// App on Linux: no desktop overlay integration (that's Win32 territory) —
// the app runs as a normal window showing the stand-in XP desktop
// (web.html, served as the index by main_linux.go). Packs still load from
// the real workshop folder next to the binary; input and window platforms
// come from the DOM, exactly like the hosted web demo.
type App struct {
	ctx      context.Context
	shop     *workshop.Manager
	stop     chan struct{}
	lastBeat int64 // unix ms of last frontend heartbeat
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) domReady(ctx context.Context) {
	atomic.StoreInt64(&a.lastBeat, time.Now().UnixMilli())
	go a.watchdogLoop()
}

func (a *App) shutdown(ctx context.Context) {
	close(a.stop)
}

// GetBootstrap: geometry is nominal — the web host shim measures the real
// window itself and only takes the pack list (and flags) from here.
func (a *App) GetBootstrap() Bootstrap {
	return Bootstrap{
		ScreenW:    1920,
		ScreenH:    1080,
		WorkBottom: 1040,
		Packs:      a.shop.List(),
		Steam:      a.shop.SteamActive(),
	}
}

// SetClickThrough is a no-op in a normal window.
func (a *App) SetClickThrough(enabled bool) {}
