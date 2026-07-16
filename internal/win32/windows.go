//go:build windows

package win32

import (
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	dwmwaCloaked             = 14
	dwmwaExtendedFrameBounds = 9

	monitorDefaultToNearest = 2

	gwlStyle  uintptr = 0xFFFFFFF0 // GWL_STYLE == -16
	wsCaption         = 0x00C00000
	wsPopup           = 0x80000000
)

// WindowRect is a top-level window the buddy can collide with.
// Coordinates are physical screen pixels.
type WindowRect struct {
	HWND  uintptr `json:"hwnd"`
	X     int32   `json:"x"`
	Y     int32   `json:"y"`
	W     int32   `json:"w"`
	H     int32   `json:"h"`
	Title string  `json:"title"`
}

type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

var ignoredClasses = map[string]bool{
	"Progman":                      true,
	"WorkerW":                      true,
	"Shell_TrayWnd":                true,
	"Shell_SecondaryTrayWnd":       true,
	"NotifyIconOverflowWindow":     true,
	"Windows.UI.Core.CoreWindow":   true,
	"XamlExplorerHostIslandWindow": true,
}

func windowText(hwnd uintptr) string {
	var buf [256]uint16
	n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), 256)
	return syscall.UTF16ToString(buf[:n])
}

func className(hwnd uintptr) string {
	var buf [256]uint16
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), 256)
	return syscall.UTF16ToString(buf[:n])
}

func isCloaked(hwnd uintptr) bool {
	var cloaked uint32
	procDwmGetWindowAttribute.Call(hwnd, dwmwaCloaked,
		uintptr(unsafe.Pointer(&cloaked)), unsafe.Sizeof(cloaked))
	return cloaked != 0
}

// frameBounds returns the DWM extended frame bounds (visible window rect
// without the invisible resize borders / drop shadow).
func frameBounds(hwnd uintptr) (rect, bool) {
	var r rect
	hr, _, _ := procDwmGetWindowAttribute.Call(hwnd, dwmwaExtendedFrameBounds,
		uintptr(unsafe.Pointer(&r)), unsafe.Sizeof(r))
	if hr != 0 {
		// Fall back to GetWindowRect.
		ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
		if ok == 0 {
			return r, false
		}
	}
	return r, true
}

func monitorHandle(hwnd uintptr) uintptr {
	m, _, _ := procMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	return m
}

func monitorRect(hMon uintptr) (rect, rect) {
	var mi monitorInfo
	mi.Size = uint32(unsafe.Sizeof(mi))
	procGetMonitorInfoW.Call(hMon, uintptr(unsafe.Pointer(&mi)))
	return mi.Monitor, mi.Work
}

// coversMonitor reports whether r covers (nearly) the full monitor area —
// treats borderless-fullscreen apps like maximized windows.
func coversMonitor(r rect, mon rect) bool {
	return r.Left <= mon.Left+2 && r.Top <= mon.Top+2 &&
		r.Right >= mon.Right-2 && r.Bottom >= mon.Bottom-2
}

// enumResult collects handles from the EnumWindows callback. Enumeration is
// only performed from the desktop tracker goroutine, guarded by enumMu.
var (
	enumMu     sync.Mutex
	enumResult []uintptr
)

var enumCallback = syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
	enumResult = append(enumResult, hwnd)
	return 1
})

// ListColliderWindows returns visible, non-minimized top-level windows in
// z-order (topmost first), excluding:
//   - our own overlay window and shell windows,
//   - maximized / fullscreen windows,
//   - any window on a monitor that already has a maximized window above it
//     in the z-order (they're hidden behind it, so the buddy shouldn't
//     collide with them).
func ListColliderWindows(selfHWND uintptr) []WindowRect {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumResult = enumResult[:0]
	procEnumWindows.Call(enumCallback, 0)
	handles := enumResult

	coveredMonitors := map[uintptr]bool{}
	out := make([]WindowRect, 0, 16)

	for _, hwnd := range handles {
		if hwnd == selfHWND {
			continue
		}
		if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 {
			continue
		}
		if ic, _, _ := procIsIconic.Call(hwnd); ic != 0 {
			continue
		}
		cls := className(hwnd)
		if ignoredClasses[cls] || strings.HasPrefix(cls, "Xaml") {
			continue
		}
		if isCloaked(hwnd) {
			continue
		}
		title := windowText(hwnd)
		if title == "" {
			continue
		}

		r, ok := frameBounds(hwnd)
		if !ok || r.Right-r.Left < 40 || r.Bottom-r.Top < 40 {
			continue
		}

		hMon := monitorHandle(hwnd)
		if coveredMonitors[hMon] {
			continue // hidden behind a maximized window above it
		}

		monR, _ := monitorRect(hMon)
		zoomed, _, _ := procIsZoomed.Call(hwnd)
		if zoomed != 0 || coversMonitor(r, monR) {
			// Maximized / fullscreen: no collision, and everything on this
			// monitor below it is occluded.
			coveredMonitors[hMon] = true
			continue
		}

		out = append(out, WindowRect{
			HWND:  hwnd,
			X:     r.Left,
			Y:     r.Top,
			W:     r.Right - r.Left,
			H:     r.Bottom - r.Top,
			Title: title,
		})
		if len(out) >= 32 {
			break
		}
	}
	return out
}

// ListOccluderRects returns the rects of ALL visible app windows — including
// maximized/fullscreen ones that are excluded from the collider list. The
// desktop (and its icons) sits below every top-level window in z-order, so
// any of these rects hides the icons beneath it.
func ListOccluderRects(selfHWND uintptr) []rect {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumResult = enumResult[:0]
	procEnumWindows.Call(enumCallback, 0)

	out := make([]rect, 0, 32)
	for _, hwnd := range enumResult {
		if hwnd == selfHWND {
			continue
		}
		if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 {
			continue
		}
		if ic, _, _ := procIsIconic.Call(hwnd); ic != 0 {
			continue
		}
		cls := className(hwnd)
		if ignoredClasses[cls] || strings.HasPrefix(cls, "Xaml") {
			continue
		}
		if isCloaked(hwnd) {
			continue
		}
		if windowText(hwnd) == "" {
			continue
		}
		r, ok := frameBounds(hwnd)
		if !ok || r.Right-r.Left < 40 || r.Bottom-r.Top < 40 {
			continue
		}
		out = append(out, r)
	}
	return out
}

// FilterVisibleIcons drops icons that are mostly hidden behind windows.
func FilterVisibleIcons(icons []IconRect, occluders []rect) []IconRect {
	out := make([]IconRect, 0, len(icons))
	for _, ic := range icons {
		area := int64(ic.W) * int64(ic.H)
		if area <= 0 {
			continue
		}
		covered := false
		for _, oc := range occluders {
			ol := max32(ic.X, oc.Left)
			ot := max32(ic.Y, oc.Top)
			or := min32(ic.X+ic.W, oc.Right)
			ob := min32(ic.Y+ic.H, oc.Bottom)
			if or <= ol || ob <= ot {
				continue
			}
			overlap := int64(or-ol) * int64(ob-ot)
			if overlap*2 > area { // >50% hidden
				covered = true
				break
			}
		}
		if !covered {
			out = append(out, ic)
		}
	}
	return out
}

func max32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}

func min32(a, b int32) int32 {
	if a < b {
		return a
	}
	return b
}
