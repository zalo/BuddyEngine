package main

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"buddyengine/internal/win32"
	"buddyengine/internal/workshop"
)

// App is the Wails-bound application object (Windows: transparent desktop
// overlay with a Win32 tray icon, global cursor tracking and window/icon
// collider streaming).
type App struct {
	ctx      context.Context
	overlay  *win32.Overlay
	tray     *win32.Tray
	shop     *workshop.Manager
	stop     chan struct{}
	lastBeat int64 // unix ms of last frontend heartbeat
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

	// The overlay has no taskbar button, so the tray icon is the way to
	// find and control BuddyEngine.
	a.tray = win32.NewTray("BuddyEngine", []win32.TrayItem{
		{ID: "reset", Label: "Reset buddy"},
		{ID: "debug", Label: "Toggle debug colliders"},
		{ID: "icons", Label: "Toggle icon colliders"},
		{ID: "", Label: ""},
		{ID: "quit", Label: "Quit BuddyEngine"},
	}, func(id string) {
		switch id {
		case "quit":
			runtime.Quit(a.ctx)
		default:
			runtime.EventsEmit(a.ctx, "tray", id)
		}
	})
}

func (a *App) domReady(ctx context.Context) {
	atomic.StoreInt64(&a.lastBeat, time.Now().UnixMilli())
	go a.cursorLoop()
	go a.desktopLoop()
	go a.watchdogLoop()
	// Drop the taskbar button once the window is actually visible.
	go func() {
		for _, delay := range []time.Duration{2 * time.Second, 6 * time.Second} {
			time.Sleep(delay)
			if a.overlay != nil {
				a.overlay.RefreshTaskbarState()
			}
		}
	}()
}

func (a *App) shutdown(ctx context.Context) {
	if a.tray != nil {
		a.tray.Dispose()
	}
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

// desktopLoop pushes window + desktop-icon rectangles at ~30Hz so window
// colliders track drags with low latency (the frontend derives collider
// velocities from these samples).
func (a *App) desktopLoop() {
	tick := time.NewTicker(win32.DesktopTickMs * time.Millisecond)
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
			if iconTick%60 == 0 {
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
