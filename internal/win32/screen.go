//go:build windows

package win32

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	dwmapi   = windows.NewLazySystemDLL("dwmapi.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	procGetDpiForSystem        = user32.NewProc("GetDpiForSystem")
	procSystemParametersInfoW  = user32.NewProc("SystemParametersInfoW")
	procGetCursorPos           = user32.NewProc("GetCursorPos")
	procGetAsyncKeyState       = user32.NewProc("GetAsyncKeyState")
	procFindWindowW            = user32.NewProc("FindWindowW")
	procFindWindowExW          = user32.NewProc("FindWindowExW")
	procGetWindowLongPtrW      = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW      = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos           = user32.NewProc("SetWindowPos")
	procEnumWindows            = user32.NewProc("EnumWindows")
	procIsWindowVisible        = user32.NewProc("IsWindowVisible")
	procIsIconic               = user32.NewProc("IsIconic")
	procIsZoomed               = user32.NewProc("IsZoomed")
	procGetWindowTextW         = user32.NewProc("GetWindowTextW")
	procGetClassNameW          = user32.NewProc("GetClassNameW")
	procGetWindowRect          = user32.NewProc("GetWindowRect")
	procMonitorFromWindow      = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW        = user32.NewProc("GetMonitorInfoW")
	procSendMessageW           = user32.NewProc("SendMessageW")
	procClientToScreen         = user32.NewProc("ClientToScreen")
	procGetWindowThreadProcess = user32.NewProc("GetWindowThreadProcessId")
	procGetWindowLongW         = user32.NewProc("GetWindowLongW")

	procDwmGetWindowAttribute = dwmapi.NewProc("DwmGetWindowAttribute")
)

const (
	smCxScreen = 0
	smCyScreen = 1

	spiGetWorkArea = 0x0030
)

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }

// PrimaryScreenSize returns the primary monitor size in physical pixels.
func PrimaryScreenSize() (int32, int32) {
	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	return int32(w), int32(h)
}

// PrimaryWorkArea returns the primary monitor work area (excludes taskbar).
func PrimaryWorkArea() (int32, int32, int32, int32) {
	var r rect
	procSystemParametersInfoW.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&r)), 0)
	return r.Left, r.Top, r.Right, r.Bottom
}

// SystemDPIScale returns the system DPI scale factor (1.0 = 96 DPI).
func SystemDPIScale() float64 {
	dpi, _, _ := procGetDpiForSystem.Call()
	if dpi == 0 {
		return 1.0
	}
	return float64(dpi) / 96.0
}
