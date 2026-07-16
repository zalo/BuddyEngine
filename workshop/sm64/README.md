# Mario (libsm64 buddy)

Real Super Mario 64 running as a desktop buddy. The genuine SM64 movement
code (via [libsm64](https://github.com/libsm64/libsm64)) runs as WASM inside
the pack's sandboxed cell, extracting Mario's model, textures and animations
at boot from a ROM you provide: place your legal backup as
`Super Mario 64 (USA).z64` in this folder (ROMs are gitignored and never
distributed). Without it the pack loads but stays dormant, logging one line.

## How the two physics worlds are bridged

- **PhysX → libsm64**: every collider the host reports (`world.colliders` —
  windows, icons, ground, screen walls) is lowered into SM64 collision
  geometry. Ground/window/icon boxes become *surface objects*
  (`sm64_surface_object_create/move/delete`), so dragging a window moves a
  platform under Mario's feet in real SM64 physics. A static "corridor"
  (front/back walls ±100 units, end caps, safety floor) pins him to the
  desktop plane.
- **libsm64 → PhysX**: Mario is mirrored into the shared world as a dynamic
  box proxy (`b<N>/mario`) that chases his SM64 position, so he pushes toys,
  other buddies can see and hit him, and the host's grab/throw spring works.
  While grabbed, authority flips: SM64 Mario is teleported to the proxy
  (clamped into the corridor — outside it his tick soft-locks), and on
  release the throw velocity is handed to SM64's air physics.

## Damage model (high-speed collisions)

- Foreign bodies (thrown balls, the swordfighter's blade) within 0.5 m and
  closing faster than 3.5 m/s → `sm64_mario_take_damage` (1–3 wedges,
  knockback away from the impact).
- Being hurled into a wall: airborne horizontal speed > 38 u/f stopped dead
  → slam damage.
- Fall damage is native SM64 behavior and comes for free.
- Health is the authentic 8-wedge power meter (drawn to an OffscreenCanvas,
  shown above his head after damage). At 0 he dies, then respawns at home
  after 3.5 s. Slow regen when he's been safe for a while.

## Behavior state machine

`idle → wander → idle` strolling (with hops and the occasional
crouch-backflip to stay limber), `climb` expeditions — he periodically
scouts reachable ledges (window tops, icons), walks to the edge, jumps up
onto them (chaining SM64 double/triple jumps for taller targets, steering
over the lip at the apex), and enjoys the view — `chase` the cursor after a
double-poke, `flee` from fast-moving bodies, `hurt` (knockback, no input),
`held`/`thrown` for grab-and-throw, `dead → respawn`. Single poke = jump.
He watches the cursor when it lingers.

## Rendering & audio

Mario's real geometry (up to 1024 tris, vertex colors + 704×64 ROM texture
atlas) is rendered in-cell with WebGL2 into an OffscreenCanvas and published
as a cartridge texture on a quad riding the proxy body. SM64 simulates at
30 Hz but rendering runs at the host frame rate: vertices and position are
lerped between the last two ticks (the libsm64-three trick), so motion is
smooth at 60+ fps. SM64's own
mixer is streamed into WebAudio when the cell is allowed to start an
AudioContext (silent otherwise).

## Files

- `main.js` — the buddy (bridge, renderer, state machine).
- `sm64.js` / `sm64.wasm` — emscripten build of libsm64 + `native/mario_buddy.c`.
- `native/mario_buddy.c` — flat C ABI over libsm64 (surface builder, mario
  tick with mixed f32/i32 state buffer, damage/audio passthroughs).
- `native/build.sh` — rebuild: needs an emsdk install and a libsm64 checkout
  with `import-mario-geo.py` already run (network). See script header.
- `native/test-harness.mjs` — headless Node e2e: stubs the Buddy SDK, runs
  the real pack + WASM, asserts boot/wander/platform-ride/damage/throw/
  death/respawn. Run: `node native/test-harness.mjs`.
- `Super Mario 64 (USA).z64` — not included; bring your own legal backup.
  It is read at runtime only; nothing from it ends up in the committed
  build artifacts.
