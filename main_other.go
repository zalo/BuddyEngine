//go:build !windows

package main

import (
	"net/http"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// Non-Windows platforms run as a normal window with the stand-in XP desktop: serve
// web.html (the web-host entry) as the index. The web host shim detects
// the real Wails bindings and loads packs from the workshop folder on disk
// while taking input and window platforms from the DOM.
func webIndexMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			r.URL.Path = "/web.html"
		}
		next.ServeHTTP(w, r)
	})
}

func appOptions(app *App) *options.App {
	return &options.App{
		Title:  "BuddyEngine",
		Width:  1280,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: webIndexMiddleware,
		},
		OnStartup:  app.startup,
		OnDomReady: app.domReady,
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	}
}
