//go:build windows

package win32

import (
	"errors"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Window tracking cadence (shared with app.go's desktop loop).
const DesktopTickMs = 33 // ~30Hz window rects for low-latency colliders

const (
	// GWL_EXSTYLE == -20, passed as a zero-extended 32-bit value; the API
	// truncates it back to a signed int.
	gwlExStyle uintptr = 0xFFFFFFEC

	wsExTransparent = 0x00000020
	wsExLayered     = 0x00080000
	wsExToolWindow  = 0x00000080
	wsExAppWindow   = 0x00040000 // forces a taskbar button; Wails sets it
	wsExNoActivate  = 0x08000000
	wsExTopmost     = 0x00000008

	swpNoActivate = 0x0010
	swpShowWindow = 0x0040
)

var hwndTopmost = ^uintptr(0) // (HWND)-1

// Overlay wraps the Wails window HWND and manages its extended styles so it
// behaves as a full-screen, always-on-top, optionally click-through overlay.
type Overlay struct {
	hwnd         uintptr
	mu           sync.Mutex
	clickThrough bool
	// Form-fit rect (physical px). Zero size = span the full screen. The
	// frontend keeps this hugging the buddies' bounding box so the DWM
	// stops compositing a screen of empty transparency.
	rx, ry, rw, rh int32
}

// NewOverlay locates the window by title.
func NewOverlay(title string) (*Overlay, error) {
	t, _ := windows.UTF16PtrFromString(title)
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(t)))
	if hwnd == 0 {
		return nil, errors.New("window not found")
	}
	return &Overlay{hwnd: hwnd, clickThrough: true}, nil
}

func (o *Overlay) HWND() uintptr { return o.hwnd }

// Apply sets overlay styles: layered + click-through by default, tool window
// (no taskbar entry / alt-tab), never activates, spans the full primary
// screen in physical pixels, topmost.
func (o *Overlay) Apply() {
	o.mu.Lock()
	defer o.mu.Unlock()

	ex, _, _ := procGetWindowLongPtrW.Call(o.hwnd, gwlExStyle)
	newEx := (ex | wsExLayered | wsExToolWindow | wsExNoActivate | wsExTopmost) &^ uintptr(wsExAppWindow)
	if o.clickThrough {
		newEx |= wsExTransparent
	}

	// WS_EX_TOOLWINDOW only removes the taskbar button if the style changes
	// while the window is hidden — cycle visibility around the style change.
	const swHide, swShowNA = 0, 8
	procShowWindow.Call(o.hwnd, swHide)
	procSetWindowLongPtrW.Call(o.hwnd, gwlExStyle, newEx)
	procShowWindow.Call(o.hwnd, swShowNA)

	o.applyRectLocked()
}

// RefreshTaskbarState re-asserts the tool-window style with a hide/show
// cycle. Needed once after Wails has actually shown the window — the
// taskbar only drops the button when the style is present at show time.
func (o *Overlay) RefreshTaskbarState() {
	o.mu.Lock()
	defer o.mu.Unlock()
	const swHide, swShowNA = 0, 8
	ex, _, _ := procGetWindowLongPtrW.Call(o.hwnd, gwlExStyle)
	procShowWindow.Call(o.hwnd, swHide)
	procSetWindowLongPtrW.Call(o.hwnd, gwlExStyle, (ex|wsExToolWindow)&^uintptr(wsExAppWindow))
	procShowWindow.Call(o.hwnd, swShowNA)
	o.applyRectLocked()
}

// SetRect moves/resizes the overlay window (physical px) — the form-fit
// path. Keeps topmost + no-activate so following the buddies around never
// steals focus.
func (o *Overlay) SetRect(x, y, w, h int32) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.rx, o.ry, o.rw, o.rh = x, y, w, h
	o.applyRectLocked()
}

func (o *Overlay) applyRectLocked() {
	x, y, w, h := o.rx, o.ry, o.rw, o.rh
	if w <= 0 || h <= 0 {
		x, y = 0, 0
		w, h = PrimaryScreenSize()
	}
	procSetWindowPos.Call(o.hwnd, hwndTopmost, uintptr(x), uintptr(y), uintptr(w), uintptr(h),
		swpNoActivate|swpShowWindow)
}

// SetClickThrough toggles WS_EX_TRANSPARENT. When true, all mouse input
// passes through to whatever is underneath.
func (o *Overlay) SetClickThrough(enabled bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.clickThrough == enabled {
		return
	}
	o.clickThrough = enabled

	ex, _, _ := procGetWindowLongPtrW.Call(o.hwnd, gwlExStyle)
	if enabled {
		ex |= wsExTransparent
	} else {
		ex &^= wsExTransparent
	}
	procSetWindowLongPtrW.Call(o.hwnd, gwlExStyle, ex)
}
