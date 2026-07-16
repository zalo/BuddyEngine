package win32

import (
	"os"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmApp          = 0x8000
	wmTrayCallback = wmApp + 1
	wmDestroy      = 0x0002
	wmCommand      = 0x0111
	wmLButtonUp    = 0x0202
	wmRButtonUp    = 0x0205

	nifMessage = 0x1
	nifIcon    = 0x2
	nifTip     = 0x4
	nimAdd     = 0x0
	nimDelete  = 0x2

	tpmReturnCmd = 0x0100
	tpmNoNotify  = 0x0080

	mfString    = 0x0000
	mfSeparator = 0x0800

	idiApplication = 32512
)

var (
	shell32                = windows.NewLazySystemDLL("shell32.dll")
	procShellNotifyIconW   = shell32.NewProc("Shell_NotifyIconW")
	procExtractIconW       = shell32.NewProc("ExtractIconW")
	procRegisterClassExW   = user32.NewProc("RegisterClassExW")
	procCreateWindowExW    = user32.NewProc("CreateWindowExW")
	procDefWindowProcW     = user32.NewProc("DefWindowProcW")
	procGetMessageW        = user32.NewProc("GetMessageW")
	procTranslateMessage   = user32.NewProc("TranslateMessage")
	procDispatchMessageW   = user32.NewProc("DispatchMessageW")
	procCreatePopupMenu    = user32.NewProc("CreatePopupMenu")
	procDestroyMenu        = user32.NewProc("DestroyMenu")
	procAppendMenuW        = user32.NewProc("AppendMenuW")
	procTrackPopupMenu     = user32.NewProc("TrackPopupMenu")
	procSetForegroundWnd   = user32.NewProc("SetForegroundWindow")
	procLoadIconW          = user32.NewProc("LoadIconW")
	procPostMessageW       = user32.NewProc("PostMessageW")
	procPostQuitMessage    = user32.NewProc("PostQuitMessage")
	procShowWindow         = user32.NewProc("ShowWindow")
	procGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
)

type wndClassEx struct {
	Size, Style                        uint32
	WndProc                            uintptr
	ClsExtra, WndExtra                 int32
	Instance, Icon, Cursor, Background uintptr
	MenuName, ClassName                *uint16
	IconSm                             uintptr
}

type notifyIconData struct {
	Size            uint32
	HWnd            uintptr
	ID              uint32
	Flags           uint32
	CallbackMessage uint32
	Icon            uintptr
	Tip             [128]uint16
	State           uint32
	StateMask       uint32
	Info            [256]uint16
	Version         uint32
	InfoTitle       [64]uint16
	InfoFlags       uint32
	GuidItem        [16]byte
	BalloonIcon     uintptr
}

type msg struct {
	HWnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	_       uint32
}

// TrayItem is one context-menu entry; empty Label = separator.
type TrayItem struct {
	ID    string
	Label string
}

// Tray puts an icon in the notification area with a right/left-click menu.
// onCommand is invoked (on the tray's own goroutine) with the item ID.
type Tray struct {
	hwnd      uintptr
	items     []TrayItem
	onCommand func(id string)
}

var activeTray *Tray // wndProc needs package-level access

func NewTray(tooltip string, items []TrayItem, onCommand func(id string)) *Tray {
	t := &Tray{items: items, onCommand: onCommand}
	activeTray = t
	ready := make(chan struct{})
	go t.run(tooltip, ready)
	<-ready
	return t
}

func (t *Tray) run(tooltip string, ready chan struct{}) {
	runtime.LockOSThread()

	hInst, _, _ := procGetModuleHandleW.Call(0)
	className, _ := windows.UTF16PtrFromString("BuddyEngineTray")

	wndProc := syscall.NewCallback(func(hwnd, m, wParam, lParam uintptr) uintptr {
		if m == wmTrayCallback && (lParam == wmRButtonUp || lParam == wmLButtonUp) {
			t.showMenu(hwnd)
			return 0
		}
		if m == wmDestroy {
			procPostQuitMessage.Call(0)
			return 0
		}
		r, _, _ := procDefWindowProcW.Call(hwnd, m, wParam, lParam)
		return r
	})

	wc := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   wndProc,
		Instance:  hInst,
		ClassName: className,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	// Hidden top-level window (not message-only: TrackPopupMenu needs a
	// window that can take foreground).
	title, _ := windows.UTF16PtrFromString("BuddyEngineTrayWnd")
	t.hwnd, _, _ = procCreateWindowExW.Call(0,
		uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)),
		0, 0, 0, 0, 0, 0, 0, hInst, 0)

	// Icon: the exe's own icon, falling back to the generic app icon.
	var hIcon uintptr
	if exe, err := os.Executable(); err == nil {
		exeW, _ := windows.UTF16PtrFromString(exe)
		hIcon, _, _ = procExtractIconW.Call(hInst, uintptr(unsafe.Pointer(exeW)), 0)
	}
	if hIcon == 0 || hIcon == 1 {
		hIcon, _, _ = procLoadIconW.Call(0, idiApplication)
	}

	nid := notifyIconData{
		Size:            uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:            t.hwnd,
		ID:              1,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: wmTrayCallback,
		Icon:            hIcon,
	}
	tipW, _ := windows.UTF16FromString(tooltip)
	copy(nid.Tip[:], tipW)
	procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))

	close(ready)

	var m msg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 || int32(r) == -1 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}

	procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
}

func (t *Tray) showMenu(hwnd uintptr) {
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)

	for i, item := range t.items {
		if item.Label == "" {
			procAppendMenuW.Call(menu, mfSeparator, 0, 0)
			continue
		}
		label, _ := windows.UTF16PtrFromString(item.Label)
		procAppendMenuW.Call(menu, mfString, uintptr(i+1), uintptr(unsafe.Pointer(label)))
	}

	var p point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	procSetForegroundWnd.Call(hwnd)
	cmd, _, _ := procTrackPopupMenu.Call(menu, tpmReturnCmd|tpmNoNotify,
		uintptr(p.X), uintptr(p.Y), 0, hwnd, 0)
	if cmd > 0 && int(cmd) <= len(t.items) && t.onCommand != nil {
		t.onCommand(t.items[cmd-1].ID)
	}
}

// Dispose removes the tray icon and stops its message loop.
func (t *Tray) Dispose() {
	if t.hwnd != 0 {
		procPostMessageW.Call(t.hwnd, 0x0010 /*WM_CLOSE*/, 0, 0)
	}
}
