package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
)

//go:embed all:frontend/dist
var assets embed.FS

const windowTitle = "BuddyEngine Overlay"

// appOptions is provided per-platform: Windows builds the transparent
// always-on-top overlay; Linux builds a normal window running the stand-in
// XP desktop.
func main() {
	app := NewApp()
	if err := wails.Run(appOptions(app)); err != nil {
		println("Error:", err.Error())
	}
}
