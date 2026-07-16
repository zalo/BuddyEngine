// Buddy API v1 — wire protocol shared by the host and every buddy cell.
//
// IDENTITY
//   'sys'                     the buddy system (host) itself
//   'b<N>'                    a buddy instance (assigned by host at spawn)
//   '<owner>/<localName>'     an object owned by <owner>:
//                             'sys/ground', 'sys/win:198446', 'sys/cursor',
//                             'sys/avatar/pelvis', 'b3/ball', 'b3/fx.flame'
//   Cells address their OWN objects by localName; the host prefixes and
//   enforces ownership. Foreign objects are read-only world state.
//
// TRANSPORT
//   Hot path (every host frame, host -> cell): one packcat-packed binary
//   frame packet + a small JSON sidecar, posted as {t:'frame', bin, meta}
//   with `bin` transferred. The same packet bytes are the intended unit of
//   future network replication (peer ids get a 'peer:<id>:' prefix).
//   Cell -> host: {t:'commands', cmds:[...]} JSON, batched per cell tick.
//   Rare/bulky payloads (assets, GLTF bytes, boot sources) use structured
//   clone with transferred ArrayBuffers.
//
// BODY STATE LAYOUT (frame.bodies, Float32Array, stride 13)
//   [px py pz  qx qy qz qw  vx vy vz  wx wy wz]
//   Index -> id mapping comes from meta.ids, re-sent when meta.epoch changes.

// packcat is injected (the cell imports it from a blob URL, the host from
// the vendor dir), so this module builds its codecs lazily.
let codecs = null;

export function initProtocol(packcat) {
    const { build, object, float32, float64, uint32, boolean, float32Array } = packcat;

    const frameSchema = object({
        time: float64(),
        dt: float32(),
        epoch: uint32(),
        cursor: object({
            px: float32(),   // physical desktop pixels
            py: float32(),
            wx: float32(),   // world meters (desktop plane)
            wz: float32(),
            l: boolean(),
            r: boolean(),
        }),
        bodies: float32Array(), // stride 13, ids from meta sidecar
    });

    codecs = { frame: build(frameSchema) };
    return codecs;
}

export function getCodecs() {
    if (!codecs) throw new Error('protocol not initialized');
    return codecs;
}

export const BODY_STRIDE = 13;

// ---------------------------------------------------------------------------
// Command catalogue (cell -> host, JSON). Every command carries `op`.
// Ownership rule: `id` fields refer to the sender's own objects and are
// prefixed by the host; `body`/`target` fields may reference any world body
// (read/attach only, never mutate).
// ---------------------------------------------------------------------------
export const OPS = {
    // physics
    PHYS_SPAWN: 'phys.spawn',       // {id, shape:{type:'box'|'sphere'|'capsule',...}, pos:[3], quat?:[4], mass?, kinematic?, collides?:'all'|'world'|'none', friction?, restitution?}
    PHYS_REMOVE: 'phys.remove',     // {id}
    PHYS_FORCE: 'phys.force',       // {id, f:[3], p?:[3], mode?:'force'|'impulse'}
    PHYS_VELOCITY: 'phys.velocity', // {id, v?:[3], w?:[3]}
    PHYS_KINEMATIC: 'phys.kinematic', // {id, pos:[3], quat?:[4]}

    // articulated rigs (engine-agnostic: MJCF humanoids, mecanim chains,
    // GLTF skeleton proxies all lower to the same description)
    ARTI_CREATE: 'arti.create',     // {id, data:{bodies,joints,fixedJoints,dofInfo,init_*}, spawn?:{x,z}}
    ARTI_DRIVE: 'arti.drive',       // {id, targets:[dof PD targets]} — applied before the next sim step
    ARTI_RESET: 'arti.reset',       // {id, x?}
    ARTI_REMOVE: 'arti.remove',     // {id}

    // retained-mode scene graph (three.js semantics)
    GEO_DEFINE: 'geo.define',       // {id, type:'box'|'sphere'|'capsule'|'plane'|'cylinder', params} | {id, type:'buffer', position:F32, normal?:F32, uv?:F32, index?:U32}
    MAT_DEFINE: 'mat.define',       // {id, type:'standard'|'basic'|'shader'|'sprite', params?, map?:texId, vertexShader?, fragmentShader?, uniforms?, transparent?, blending?}
    TEX_DEFINE: 'tex.define',       // {id, asset?:path} | {id, bitmap:ImageBitmap (transferred)} — bitmap path is how cartridges publish OffscreenCanvas output
    NODE_ADD: 'node.add',           // {id, kind:'group'|'mesh'|'sprite'|'gltf', parent?:localId, geo?:geoId, mat?:matId, asset?:gltfPath, pos?, quat?, scale?}
    NODE_SET: 'node.set',           // {id, pos?, quat?, scale?, visible?, matParams?:{...uniform/param updates}}
    NODE_ATTACH: 'node.attach',     // {id, body:<any world body id>, offsetPos?, offsetQuat?} — host tracks at render rate, zero latency
    NODE_REMOVE: 'node.remove',     // {id}
    ANIM: 'anim',                   // {id (gltf node), clip, action:'play'|'stop'|'crossfade', loop?:'repeat'|'once', speed?, fade?}

    // assets & bus & lifecycle
    ASSET_FETCH: 'asset.fetch',     // {reqId, path} -> host replies {t:'asset', reqId, bytes|error}
    BUS_SEND: 'bus.send',           // {to:'b<N>'|'*', topic, data} — data is structured-clone JSON
    READY: 'ready',                 // {} — first command a cell must send
    LOG: 'log',                     // {msg}
    META: 'meta',                   // {name?, description?, author?, version?} — relayed from the pack's `export const meta`
};

// Host -> cell message types (besides 'frame'): 'boot', 'init', 'asset',
// frame.meta = { ids?:[...], colliders?:[{id,cx,cz,hx,hz,kinematic}],
//                events:[{type:'pointerdown'|'pointerup'|'pointerenter'|'pointerleave', id, wx, wz}],
//                messages:[{from, topic, data}] }

export function splitId(fqid) {
    const i = fqid.indexOf('/');
    return i < 0 ? { owner: fqid, local: '' } : { owner: fqid.slice(0, i), local: fqid.slice(i + 1) };
}

export function isValidLocalId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 64 &&
        !id.includes('/') && /^[\w.\-:]+$/.test(id);
}
