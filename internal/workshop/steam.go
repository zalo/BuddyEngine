//go:build windows

package workshop

import (
	"os"
	"path/filepath"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

// steamProvider talks to the Steamworks flat (C) API in steam_api64.dll.
// Everything is defensive: if the DLL is missing, Steam isn't running, or an
// export isn't found, the provider simply deactivates and BuddyEngine runs
// with local packs only.
//
// To ship on Steam: place steam_api64.dll next to BuddyEngine.exe and a
// steam_appid.txt containing your AppID (480 = Spacewar works for testing).
type steamProvider struct {
	active bool
	dll    *windows.LazyDLL

	ugc uintptr // ISteamUGC*
}

func newSteamProvider() *steamProvider {
	p := &steamProvider{}
	defer func() {
		// A bad DLL / ABI mismatch must never take the app down.
		if r := recover(); r != nil {
			p.active = false
		}
	}()

	exe, err := os.Executable()
	if err != nil {
		return p
	}
	dllPath := filepath.Join(filepath.Dir(exe), "steam_api64.dll")
	if _, err := os.Stat(dllPath); err != nil {
		return p
	}

	p.dll = windows.NewLazyDLL(dllPath)
	initProc := p.dll.NewProc("SteamAPI_Init")
	if initProc.Find() != nil {
		return p
	}
	ok, _, _ := initProc.Call()
	if ok == 0 {
		return p // Steam not running / no appid
	}

	// Resolve ISteamUGC through the version-agnostic accessor if present,
	// falling back through known interface versions.
	p.ugc = p.findUGC()
	p.active = p.ugc != 0
	return p
}

func (p *steamProvider) findUGC() uintptr {
	// Newer SDKs export versioned accessors: SteamAPI_SteamUGC_v0NN.
	for v := 21; v >= 14; v-- {
		proc := p.dll.NewProc("SteamAPI_SteamUGC_v0" + pad2(v))
		if proc.Find() == nil {
			ugc, _, _ := proc.Call()
			if ugc != 0 {
				return ugc
			}
		}
	}
	return 0
}

func pad2(v int) string {
	s := strconv.Itoa(v)
	if len(s) < 2 {
		s = "0" + s
	}
	return s
}

// subscribedItemDirs returns install folders of subscribed workshop items.
func (p *steamProvider) subscribedItemDirs() []string {
	if !p.active {
		return nil
	}
	defer func() { recover() }()

	numProc := p.dll.NewProc("SteamAPI_ISteamUGC_GetNumSubscribedItems")
	listProc := p.dll.NewProc("SteamAPI_ISteamUGC_GetSubscribedItems")
	infoProc := p.dll.NewProc("SteamAPI_ISteamUGC_GetItemInstallInfo")
	if numProc.Find() != nil || listProc.Find() != nil || infoProc.Find() != nil {
		return nil
	}

	n, _, _ := numProc.Call(p.ugc)
	if n == 0 || n > 4096 {
		return nil
	}
	ids := make([]uint64, n)
	got, _, _ := listProc.Call(p.ugc, uintptr(unsafe.Pointer(&ids[0])), n)
	if got == 0 {
		return nil
	}
	if got < n {
		n = got
	}

	dirs := make([]string, 0, n)
	folder := make([]byte, 1024) // UTF-8 char* in the flat API
	for i := uintptr(0); i < n; i++ {
		var sizeOnDisk uint64
		var timestamp uint32
		ok, _, _ := infoProc.Call(p.ugc,
			uintptr(ids[i]),
			uintptr(unsafe.Pointer(&sizeOnDisk)),
			uintptr(unsafe.Pointer(&folder[0])),
			uintptr(len(folder)),
			uintptr(unsafe.Pointer(&timestamp)))
		if ok != 0 {
			end := 0
			for end < len(folder) && folder[end] != 0 {
				end++
			}
			dirs = append(dirs, string(folder[:end]))
		}
	}
	return dirs
}
