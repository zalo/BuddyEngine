package win32

import "unsafe"

const (
	vkLButton = 0x01
	vkRButton = 0x02
)

// CursorState is the global cursor position (physical pixels, screen space)
// plus mouse button state.
type CursorState struct {
	X int32 `json:"x"`
	Y int32 `json:"y"`
	L bool  `json:"l"`
	R bool  `json:"r"`
}

// Cursor reads the global cursor state. Works regardless of window focus or
// click-through state.
func Cursor() CursorState {
	var p point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	l, _, _ := procGetAsyncKeyState.Call(vkLButton)
	r, _, _ := procGetAsyncKeyState.Call(vkRButton)
	return CursorState{
		X: p.X,
		Y: p.Y,
		L: l&0x8000 != 0,
		R: r&0x8000 != 0,
	}
}
