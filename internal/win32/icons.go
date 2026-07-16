package win32

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	lvmFirst           = 0x1000
	lvmGetItemCount    = lvmFirst + 4
	lvmGetItemRect     = lvmFirst + 14
	lvirBounds         = 0
	lvirIcon           = 1

	processVMOperation = 0x0008
	processVMRead      = 0x0010
	processVMWrite     = 0x0020
	processQueryInfo   = 0x0400

	memCommit  = 0x1000
	memReserve = 0x2000
	memRelease = 0x8000
	pageRW     = 0x04
)

var (
	procVirtualAllocEx    = kernel32.NewProc("VirtualAllocEx")
	procVirtualFreeEx     = kernel32.NewProc("VirtualFreeEx")
	procReadProcessMemory = kernel32.NewProc("ReadProcessMemory")
	procWriteProcessMemory = kernel32.NewProc("WriteProcessMemory")
)

// IconRect is a desktop icon bounding box in physical screen pixels.
type IconRect struct {
	X int32 `json:"x"`
	Y int32 `json:"y"`
	W int32 `json:"w"`
	H int32 `json:"h"`
}

// findDesktopListView locates the desktop icon SysListView32. It lives under
// Progman normally, or under a WorkerW when wallpaper hosting rearranges the
// shell hierarchy.
func findDesktopListView() uintptr {
	progman, _ := windows.UTF16PtrFromString("Progman")
	defView, _ := windows.UTF16PtrFromString("SHELLDLL_DefView")
	listView, _ := windows.UTF16PtrFromString("SysListView32")
	workerW, _ := windows.UTF16PtrFromString("WorkerW")

	pm, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(progman)), 0)
	if pm != 0 {
		dv, _, _ := procFindWindowExW.Call(pm, 0, uintptr(unsafe.Pointer(defView)), 0)
		if dv != 0 {
			lv, _, _ := procFindWindowExW.Call(dv, 0, uintptr(unsafe.Pointer(listView)), 0)
			if lv != 0 {
				return lv
			}
		}
	}

	// Walk WorkerW siblings.
	var ww uintptr
	for {
		ww, _, _ = procFindWindowExW.Call(0, ww, uintptr(unsafe.Pointer(workerW)), 0)
		if ww == 0 {
			break
		}
		dv, _, _ := procFindWindowExW.Call(ww, 0, uintptr(unsafe.Pointer(defView)), 0)
		if dv != 0 {
			lv, _, _ := procFindWindowExW.Call(dv, 0, uintptr(unsafe.Pointer(listView)), 0)
			if lv != 0 {
				return lv
			}
		}
	}
	return 0
}

// ListDesktopIcons reads desktop icon bounds out of the shell's list view
// using cross-process memory (the LVM_GETITEMRECT struct must live in the
// shell process's address space).
func ListDesktopIcons() []IconRect {
	lv := findDesktopListView()
	if lv == 0 {
		return nil
	}
	if v, _, _ := procIsWindowVisible.Call(lv); v == 0 {
		return nil // desktop icons hidden
	}

	count, _, _ := procSendMessageW.Call(lv, lvmGetItemCount, 0, 0)
	if count == 0 || count > 512 {
		return nil
	}

	var pid uint32
	procGetWindowThreadProcess.Call(lv, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return nil
	}

	hProc, _, _ := kernel32.NewProc("OpenProcess").Call(
		processVMOperation|processVMRead|processVMWrite|processQueryInfo, 0, uintptr(pid))
	if hProc == 0 {
		return nil
	}
	defer windows.CloseHandle(windows.Handle(hProc))

	remote, _, _ := procVirtualAllocEx.Call(hProc, 0, unsafe.Sizeof(rect{}),
		memCommit|memReserve, pageRW)
	if remote == 0 {
		return nil
	}
	defer procVirtualFreeEx.Call(hProc, remote, 0, memRelease)

	// List view origin in screen coordinates.
	var origin point
	procClientToScreen.Call(lv, uintptr(unsafe.Pointer(&origin)))

	out := make([]IconRect, 0, count)
	for i := uintptr(0); i < count; i++ {
		// LVM_GETITEMRECT: rect.Left holds the LVIR code on input.
		in := rect{Left: lvirIcon}
		procWriteProcessMemory.Call(hProc, remote, uintptr(unsafe.Pointer(&in)),
			unsafe.Sizeof(in), 0)
		ok, _, _ := procSendMessageW.Call(lv, lvmGetItemRect, i, remote)
		if ok == 0 {
			continue
		}
		var r rect
		procReadProcessMemory.Call(hProc, remote, uintptr(unsafe.Pointer(&r)),
			unsafe.Sizeof(r), 0)
		out = append(out, IconRect{
			X: origin.X + r.Left,
			Y: origin.Y + r.Top,
			W: r.Right - r.Left,
			H: r.Bottom - r.Top,
		})
	}
	return out
}
