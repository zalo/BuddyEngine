# Buddy API v1

One unified API for every buddy modality — RL humanoids (SwordBrawl-style),
sprite actors, physics toys, and multiplayer game buddies. Every buddy runs
its non-physics computation in a **sandboxed null-origin iframe** ("cell"),
while all buddies share **one PhysX world** and **one three.js scene** owned
by the host. three.js is the lingua franca: the rendering API is a
serialized subset of the three.js scene graph, and world coordinates are the
desktop plane (X right, Z up, Y depth, meters; `ppm` pixels-per-meter).

```
┌─ Host (trusted, no pack code ever) ───────────────────────────────────┐
│  PhysX world · three.js scene · Win32 desktop tracker · Steam/local   │
│  CartridgeManager ─ SceneMirror per cell ─ physics proxy ─ bus        │
└──────┬──────────────────────┬──────────────────────┬──────────────────┘
   frame packets          frame packets          frame packets
   commands ▲             commands ▲             commands ▲
┌──────────┴─────┐  ┌─────────────┴───┐  ┌───────────────┴─┐
│ cell b1        │  │ cell b2         │  │ cell b3         │
│ RL policy WASM │  │ sprite actor JS │  │ game logic +    │
│ (onnx in cell) │  │                 │  │ OffscreenCanvas │
└────────────────┘  └─────────────────┘  └─────────────────┘
```

## Identity

| ID | Meaning |
|---|---|
| `sys` | the buddy system (host) |
| `b<N>` | a buddy instance (assigned at spawn) |
| `sys/ground`, `sys/wall_l`, `sys/win:<hwnd>`, `sys/icon:<n>` | desktop colliders |
| `sys/target` | the strike target (the cursor's physics proxy) |
| `b3/ball`, `b3/fx.flame` | objects owned by buddy `b3` |
| `b1/avatar.pelvis`, `b1/avatar.sword` | links of buddy `b1`'s articulation `avatar` |

Cells name their own objects with bare local IDs (`[\w.\-:]+`, ≤64 chars);
the host prefixes and enforces ownership. Foreign objects are readable world
state — never directly mutable. A reserved `peer:<id>:` prefix dimension is
set aside for multiplayer replication (below).

## Transport

- **Host → cell, every host frame**: one **packcat**-packed binary packet
  (time, dt, epoch, cursor, all body states as a stride-13 Float32Array:
  `pos3 quat4 linvel3 angvel3`) plus a JSON sidecar sent only when changed:
  body-ID table (on epoch bump), collider list, pointer events, bus messages.
  The binary packet is transferred, not cloned — and its bytes are the
  intended unit of future network replication.
- **Cell → host**: one JSON command batch per cell tick (≤256 cmds), with
  ImageBitmaps transferred alongside. Commands are validated per-op with
  budgets (64 bodies, 512 scene nodes, 2048px textures per cell).
- **Rare/bulky**: boot sources, asset bytes, GLTF binaries — structured
  clone with transferred ArrayBuffers.

packcat's quantized/quat/uv codecs are reserved for the network layer where
bandwidth matters; over postMessage, bulk float32 + transfer is faster.

## The world view (what a cell receives per frame)

```js
buddy.onFrame(world => {
  world.time, world.dt
  world.cursor            // {px, py (desktop pixels), wx, wz (meters), l, r}
  world.bodies            // Map<fqid, {pos, quat, vel, angvel}> — every dynamic body in the world
  world.colliders         // [{id:'sys/win:…', cx, cz, hx, hz, kinematic}] — windows/icons/ground/walls
  world.events            // pointer events on YOUR objects: {type:'pointerenter|leave|down|up', id, wx, wz}
});
```

This is the "compressed desktop": windows and icons appear as boxes, the
mouse as `cursor` + the grabbable `sys/target` body, the native humanoid as
17 `sys/avatar/*` bodies. Host-side grab/throw works on cell bodies
automatically (the same spring the sword buddy uses), with pointer events
routed to the owner.

## Physics (shared PhysX world)

```js
const ball = buddy.phys.spawn('ball', {
  shape: {type:'sphere', r:0.14},           // box {hx,hy,hz} | capsule {r,hh} | sphere {r}
  pos: [2,0,1], quat: [0,0,0,1],
  mass: 0.5, friction: 0.4, restitution: 0.65,
  angularDamping: 0.9, linearDamping: 0.01,
  kinematic: false,
  collides: 'all',                           // 'all' | 'world' (not other buddies) | 'none'
  collidesCursor: false,                     // opt into the cursor-target collision layer
                                             // (only the avatar hits it by default)
  planar2D: true,                            // 2D-sprite motion: locks linear Y + angular X/Z,
                                             // so it moves in the desktop plane and spins only
                                             // around the depth axis
  lock: {linX, linY, linZ, angX, angY, angZ} // or pick individual DOF locks
});
ball.force([fx,fy,fz], point?); ball.impulse(...); ball.velocity(v, w);
ball.kinematicTarget(pos, quat);             // kinematic bodies sweep with velocity
ball.remove();
```

Buddy↔buddy interaction is physical (collision groups) plus the bus —
never direct mutation of foreign bodies.

### Articulated rigs

```js
const rig = buddy.phys.articulation('avatar', rigData, {x: -1.5});
rig.state                       // {dofPos, dofVel} — refreshed every frame
rig.drive(targets)              // PD drive targets by dof index
rig.linkBody('pelvis')          // world body id: '<me>/avatar.pelvis'
rig.reset(x); rig.remove();
```

`rigData` is engine-agnostic: named links (collision geoms, mass/inertia/com),
joints (spherical/revolute/fixed, axes, limits, PD stiffness/damping/maxForce,
armature), `dofInfo` ordering and an init pose. MimicKit MJCF humanoids lower
to it today (see the swordfighter pack's `mimickit.js`); mecanim-style bone
chains and GLTF skeleton proxies lower to the same structure — pair with
`gfx.gltf` + per-link `node.attach` (or a future `skin.bind`) to skin them.
Because drive commands flush at the end of the same frame callback that
observed the world, obs→action latency is one host frame, identical to a
host-native controller. The swordfighter runs its ONNX policies (via
onnxruntime-web booted *inside the cell* from `sys:vendor/...` shared assets)
in exactly this loop.

## Rendering (retained three.js over the wire)

```js
buddy.gfx.geometry('g', {type:'plane'|'box'|'sphere'|'capsule'|'cylinder', params}
                    /* or */ {type:'buffer', position:F32, normal?, uv?, index?});
buddy.gfx.texture('t', {asset:'skin.png'});         // pack file, host-decoded
buddy.gfx.material('m', {type:'standard'|'basic'|'sprite', params:{map:'t', color:…}});
buddy.gfx.material('fx', {type:'shader', vertexShader, fragmentShader,
                          uniforms:{uTime:0, uTint:[1,0,0]}, transparent:true, blending:'additive'});
const node = buddy.gfx.mesh('orb', {geo:'g', mat:'fx', parent?, pos?, quat?, scale?});
node.set({pos, quat, scale, visible, matParams:{uTime: t}});   // uniforms & material params
node.attach('ball', offsetPos?, offsetQuat?);  // host-side tracking at render rate, zero latency
const rig = buddy.gfx.gltf('char', 'model.glb');   // full GLTF: skinned meshes, bones, morphs
rig.anim('Run', {action:'crossfade', fade:0.3, loop:'repeat', speed:1.2});
```

The mirror owns real THREE objects (Group/Mesh/Sprite/ShaderMaterial/
GLTFLoader/AnimationMixer); a dead cell is disposed wholesale.

### Cartridge modality (custom pixels)

The escape hatch when retained mode isn't enough — render anything into an
OffscreenCanvas inside your cell (2D, WebGL2, your own WASM engine) and
publish frames as a texture other nodes use:

```js
const canvas = new OffscreenCanvas(256, 256);
// ...draw with any code you like, including your own WASM (buddy.assets.wasm)...
buddy.publishCanvas('screenTex', canvas);   // transferToImageBitmap → transferred
```

Declarative and cartridge visuals are the *same* API — a cartridge is just a
`tex.define` whose pixels come from the cell instead of a pack file.

## Assets & WASM

```js
await buddy.assets.bytes('policy.onnx');    // any pack file, path-traversal-checked
await buddy.assets.json('config.json');
await buddy.assets.wasm('brain.wasm', imports);  // cells run their own WASM
```

Cells have **no network** (CSP `default-src 'none'`) — everything comes from
the pack via the host.

## Bus (buddy ↔ buddy)

```js
buddy.bus.broadcast('wisp.startled', {at:[x,z]});
buddy.bus.send('b2', 'challenge', {game:'duel'});
buddy.bus.on('challenge', (data, from) => { … });
```

Topics are strings (≤64 chars), payloads structured-clone JSON, delivery
in-order within the next frame. `world.bodies` + the bus is enough for
emergent interactions; formal contact events are a v2 item.

## Multiplayer affordances (design, not yet wired)

- Everything a buddy does is already a **serializable command stream**, and
  everything it sees is a **packcat packet** — replication is "forward these
  over a DataChannel". packcat quantized/quat codecs shrink them for the wire.
- ID scheme reserves `peer:<peerId>:b<N>/…`; remote-owned bodies materialize
  locally as kinematic ghosts driven by replicated body states (PhysX is not
  cross-machine deterministic, so state-sync with owner-authority, not lockstep).
- The bus becomes the cross-peer message fabric unchanged.

## Lifecycle & safety

- The host's manifest contract is exactly two fields: `"name"` and
  `"main"` (presence of `main` spawns a cell). Everything else in
  manifest.json is pack-private configuration, delivered untouched to the
  cell as `buddy.manifest` — the swordfighter's `llc`/`hlc_strike` entries
  are its own file references, never read by the host.
- Harness boots packcat + protocol + SDK + your main from blob URLs inside a
  `sandbox="allow-scripts"` iframe (null origin: no `window.go`, no storage,
  no network; `wasm-unsafe-eval` enabled for your own WASM).
- Kill conditions: never `ready` within 20s, command errors are logged and
  dropped, budgets enforced per cell. Killing a cell removes its bodies and
  disposes its scene subtree; the host and other buddies are untouched.
- Known accepted risk: custom shaders can still stall the GPU (same trade
  every moddable WebGL platform makes); the host watchdog + WebGL
  context-loss reload recover, and Workshop moderation is the social backstop.

## Reference implementation

The host has no built-in character — the default buddy IS a pack. See
`workshop/swordfighter/`: `mimickit.js` (MJCF parser + ONNX metadata
extraction + quat math) and `main.js` (in-cell onnxruntime, rig spawn,
mesh building, observation construction from `world.bodies` +
`world.arti`, 30Hz HLC/LLC control in the frame callback, strike/idle
behaviors). `workshop/wisp/` is the minimal sprite-actor example.
