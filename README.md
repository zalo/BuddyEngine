# BuddyEngine

A souptoys-style interactive desktop buddy. A physics-simulated humanoid
(PhysX articulation driven by MimicKit RL policies) lives on your desktop in a
borderless, transparent, always-on-top overlay. It chases and sword-swings at
your mouse cursor, collides with your windows and desktop icons, and can be
picked up and thrown with the mouse — all while you keep working in other
apps.

## How it works

```
┌────────────────────────────── Wails (Go) ──────────────────────────────┐
│ Win32 backend                                                          │
│  • overlay window styles: WS_EX_LAYERED|TOOLWINDOW|NOACTIVATE|TOPMOST  │
│  • click-through toggle (WS_EX_TRANSPARENT) driven by the frontend     │
│  • 120Hz global cursor + button polling  ──event──▶ frontend           │
│  • 8Hz z-ordered window enumeration (DWM frame bounds), skipping       │
│    maximized/fullscreen windows AND everything beneath them            │
│  • desktop icon rects via shell SysListView32 (cross-process reads)    │
│  • workshop packs: local folder + Steam UGC (steam_api64.dll flat API) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ events / bindings
┌──────────────────────── WebView2 (frontend) ──────────────────────────┐
│  PhysX WASM (physx-js-webidl) 120Hz Z-up world                        │
│   • humanoid articulation built from MJCF baked in the LLC ONNX       │
│   • windows/icons/ground/taskbar as static box colliders             │
│   • kinematic "strike target" pinned to the mouse cursor              │
│  ONNX Runtime Web 30Hz control                                        │
│   • HLC: obs(158) + task_obs(15) → latent z                           │
│   • LLC: obs + z → 31 PD drive targets                                │
│   • idle mode: random ASE latents when the cursor is idle             │
│  three.js orthographic transparent renderer (meters ↔ pixels)         │
└───────────────────────────────────────────────────────────────────────┘
```

The overlay is click-through by default. Every frame the frontend hit-tests
the (backend-supplied) global cursor against the buddy's links; on hover it
flips the OS click-through bit so the buddy is clickable, and flips it back
when the cursor leaves. Left-drag applies a spring force at the grabbed body
(release mid-motion to throw him). Right-click the buddy for the menu
(reset / workshop packs / quit).

Because absolute height is part of the policy observation, observations are
built relative to the surface the buddy is standing on, so he can stand on
window title bars and desktop icons without going out-of-distribution.

## Building

Requires Go 1.23+, the Wails v2 CLI, and WebView2 (preinstalled on Win11).

```
wails build            # produces build/bin/BuddyEngine.exe
wails dev              # dev mode with live frontend reload
```

The frontend has no build step — it's plain ES modules in `frontend/dist`
with vendored three.js, onnxruntime-web and physx-js-webidl.

## Workshop packs

A pack is any folder containing a `main.js` — nothing else is required. The
folder name is the pack's ID and default display name; richer metadata is
exported from the script itself:

```js
export const meta = {
  name: 'My Buddy',
  author: 'you',
  version: '1',
  description: 'What it does',
};

const buddy = await Buddy.ready();
// ...spawn bodies/rigs, build visuals, drive behavior (see BUDDY_API.md)
```

Pack code runs in a sandboxed null-origin iframe, never on the host; see
`BUDDY_API.md` for the full API and `workshop/swordfighter` /
`workshop/wisp` for reference packs.

Sources scanned at startup (and from the right-click menu):

1. `workshop/` folder next to `BuddyEngine.exe` (also the CWD in dev mode)
2. Steam Workshop subscribed items — automatic when `steam_api64.dll` sits
   next to the exe and Steam is running (`steam_appid.txt` with your AppID;
   480/Spacewar works for testing). Items whose install folder contains a
   `main.js` are loaded like local packs.

The swordfighter's LLC/HLC models come from the MimicKit pipeline (same
format as the SwordBrawl web demo — the LLC carries a `mimickit_config`
JSON blob with the MJCF, normalization stats, init pose and action bounds
in its ONNX metadata).

## Notes / current limitations

- Primary monitor only (buddy world = primary screen).
- Windows are solid colliders: the buddy stands on and bumps into them.
  Maximized windows (and windows fully behind them) are ignored.
- Steam Workshop item *publishing* isn't built in yet; use
  `steamcmd +workshop_build_item` or SteamUGC tooling to upload packs.
