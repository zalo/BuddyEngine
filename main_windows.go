package main

import (
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"buddyengine/internal/win32"
)

func appOptions(app *App) *options.App {
	// Size the window in Wails' scaled units; the overlay styler snaps it to
	// the full physical screen after startup regardless.
	screenW, screenH := win32.PrimaryScreenSize()
	scale := win32.SystemDPIScale()

	return &options.App{
		Title:            windowTitle,
		Width:            int(float64(screenW) / scale),
		Height:           int(float64(screenH) / scale),
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 0, G: 0, B: 0, A: 0},
		Frameless:        true,
		DisableResize:    true,
		AlwaysOnTop:      true,
		OnStartup:        app.startup,
		OnDomReady:       app.domReady,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		Windows: &windows.Options{
			WebviewIsTransparent:              true,
			WindowIsTranslucent:               true,
			DisableWindowIcon:                 true,
			DisableFramelessWindowDecorations: true,
		},
	}
}
