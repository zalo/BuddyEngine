// Buddy SDK — the API a buddy pack's main script programs against, inside
// its sandboxed cell. Loaded by the cell harness, which injects the shared
// protocol module and the init payload, then imports the pack main.
//
//   const buddy = await Buddy.ready();
//   const ball = buddy.phys.spawn('ball', { shape: { type: 'sphere', r: 0.15 }, pos: [0, 0, 2] });
//   buddy.gfx.material('glow', { type: 'shader', fragmentShader: ..., uniforms: { t: 0 } });
//   buddy.gfx.mesh('orb', { geo: ..., mat: 'glow' }).attach('ball');
//   buddy.onFrame(world => { ball.impulse([0, 0, 1]); });
//
// world (per frame): time, dt, cursor {px,py,wx,wz,l,r}, bodies (Map of
// fqid -> {pos,quat,vel,angvel}), colliders (latest window/icon/ground
// boxes), events (pointer events on your objects), messages (bus).

let proto = null;
let initData = null;

const state = {
    cmds: [],
    frameCb: null,
    busCbs: new Map(),   // topic -> cb
    assetWaits: new Map(),
    reqCounter: 0,
    readyResolvers: [],
    connected: false,
    ids: [],
    colliders: [],
    bodies: new Map(),
    arti: {},
    framePending: false,
};

function send(cmd) { state.cmds.push(cmd); }

function flush() {
    if (state.cmds.length === 0) return;
    const cmds = state.cmds;
    state.cmds = [];
    // ImageBitmaps inside tex.define commands must be transferred.
    const transfers = [];
    for (const c of cmds) {
        if (c.op === 'tex.define' && c.bitmap) transfers.push(c.bitmap);
    }
    parent.postMessage({ t: 'commands', cmds }, '*', transfers);
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

class BodyHandle {
    constructor(id) { this.id = id; }
    get state() { return state.bodies.get(initData.instanceId + '/' + this.id); }
    force(f, p) { send({ op: 'phys.force', id: this.id, f, p, mode: 'force' }); }
    impulse(f, p) { send({ op: 'phys.force', id: this.id, f, p, mode: 'impulse' }); }
    velocity(v, w) { send({ op: 'phys.velocity', id: this.id, v, w }); }
    kinematicTarget(pos, quat) { send({ op: 'phys.kinematic', id: this.id, pos, quat }); }
    remove() { send({ op: 'phys.remove', id: this.id }); }
}

class ArticulationHandle {
    constructor(id) { this.id = id; }
    // Latest joint state (dofPos/dofVel arrays), refreshed every frame.
    get state() { return state.arti[this.id] || null; }
    // PD drive targets by dof index; call from onFrame — commands flush at
    // the end of the callback and apply before the next physics step.
    drive(targets) {
        send({ op: 'arti.drive', id: this.id, targets: Array.from(targets) });
    }
    reset(x) { send({ op: 'arti.reset', id: this.id, x }); }
    remove() { send({ op: 'arti.remove', id: this.id }); }
    // World body id of one of this rig's links (for world.bodies / attach).
    linkBody(linkName) { return this.id + '.' + linkName; }
}

class NodeHandle {
    constructor(id) { this.id = id; }
    set(props) { send({ op: 'node.set', id: this.id, ...props }); return this; }
    attach(body, offsetPos, offsetQuat) {
        send({ op: 'node.attach', id: this.id, body, offsetPos, offsetQuat });
        return this;
    }
    anim(clip, opts = {}) {
        send({ op: 'anim', id: this.id, clip, action: opts.action || 'play', ...opts });
        return this;
    }
    remove() { send({ op: 'node.remove', id: this.id }); }
}

// ---------------------------------------------------------------------------
// The API object
// ---------------------------------------------------------------------------

const buddy = {
    get id() { return initData.instanceId; },
    get packName() { return initData.packName; }, // folder name; display name comes from your `export const meta`
    get screen() { return initData.screen; },

    onFrame(cb) { state.frameCb = cb; },

    log(...args) { send({ op: 'log', msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') }); },

    phys: {
        spawn(id, desc) { send({ op: 'phys.spawn', id, ...desc }); return new BodyHandle(id); },
        body(id) { return new BodyHandle(id); },
        // Articulated rig from an engine-agnostic description (named links
        // with geoms/mass, joints with axes/limits/PD drives, init pose).
        articulation(id, data, spawn) {
            send({ op: 'arti.create', id, data, spawn });
            return new ArticulationHandle(id);
        },
    },

    gfx: {
        geometry(id, def) { send({ op: 'geo.define', id, ...def }); return id; },
        material(id, def) { send({ op: 'mat.define', id, ...def }); return id; },
        texture(id, def) { send({ op: 'tex.define', id, ...def }); return id; },
        group(id, props = {}) { send({ op: 'node.add', id, kind: 'group', ...props }); return new NodeHandle(id); },
        mesh(id, props = {}) { send({ op: 'node.add', id, kind: 'mesh', ...props }); return new NodeHandle(id); },
        sprite(id, props = {}) { send({ op: 'node.add', id, kind: 'sprite', ...props }); return new NodeHandle(id); },
        gltf(id, asset, props = {}) { send({ op: 'node.add', id, kind: 'gltf', asset, ...props }); return new NodeHandle(id); },
        node(id) { return new NodeHandle(id); },
    },

    assets: {
        // Raw pack file bytes (also how a cell pulls its own WASM modules).
        async bytes(path) {
            const reqId = 'r' + (++state.reqCounter);
            send({ op: 'asset.fetch', reqId, path });
            flush();
            return new Promise((res, rej) => state.assetWaits.set(reqId, { res, rej }));
        },
        async text(path) { return new TextDecoder().decode(await this.bytes(path)); },
        async json(path) { return JSON.parse(await this.text(path)); },
        async wasm(path, imports = {}) {
            const bytes = await this.bytes(path);
            return WebAssembly.instantiate(bytes, imports);
        },
        // Import another (self-contained) JS module from the pack.
        async module(path) {
            const bytes = await this.bytes(path);
            const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
            return import(url);
        },
        // Run a classic (non-module) script, e.g. UMD bundles like
        // onnxruntime-web, so its top-level vars land on globalThis.
        // (eval won't do: strict-mode bundles keep their vars eval-scoped.)
        async script(path) {
            const bytes = await this.bytes(path);
            const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
            await new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = url;
                s.onload = res;
                s.onerror = () => rej(new Error('script load failed: ' + path));
                document.head.appendChild(s);
            });
        },
    },

    bus: {
        send(to, topic, data) { send({ op: 'bus.send', to, topic, data }); },
        broadcast(topic, data) { send({ op: 'bus.send', to: '*', topic, data }); },
        on(topic, cb) { state.busCbs.set(topic, cb); },
    },

    // DOM view modality: composite this cell's iframe directly with the
    // desktop (fullscreen, transparent, pointer-events:none — input still
    // arrives via physics hit-testing on your bodies). Render anything into
    // your own document: Live2D, HTML overlays, a <canvas> you position.
    // Note: the cell CSP blocks <style> tags and style="" attributes; set
    // styles through the CSSOM (el.style.foo = ...), which is allowed.
    view: {
        set(props) {
            if (props && props.visible) {
                // The iframe only composites transparently if its own
                // document is transparent; also drop the default margin so
                // CSS pixels line up with the host viewport.
                document.documentElement.style.background = 'transparent';
                document.body.style.background = 'transparent';
                document.body.style.margin = '0';
                document.body.style.overflow = 'hidden';
            }
            send({ op: 'view.set', ...props });
        },
        show(opts = {}) { this.set({ visible: true, ...opts }); },
        hide() { this.set({ visible: false }); },
    },

    // Escape hatch for cartridge-style visuals: render into any canvas you
    // like in here (OffscreenCanvas + WebGL/2D), then publish frames:
    publishCanvas(texId, offscreenCanvas, opts = {}) {
        const bitmap = offscreenCanvas.transferToImageBitmap();
        send({ op: 'tex.define', id: texId, bitmap, nearest: !!opts.nearest });
    },
};

const Buddy = {
    ready() {
        if (state.connected) return Promise.resolve(buddy);
        return new Promise(res => state.readyResolvers.push(res));
    },
};

// ---------------------------------------------------------------------------
// Wire-up (called by the harness)
// ---------------------------------------------------------------------------

export function __init(protocolModule, init) {
    proto = protocolModule;
    initData = init;
    globalThis.Buddy = Buddy;
    globalThis.buddy = buddy;

    window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d) return;
        if (d.t === 'frame') onFrame(d);
        else if (d.t === 'asset') {
            const w = state.assetWaits.get(d.reqId);
            if (w) {
                state.assetWaits.delete(d.reqId);
                d.error ? w.rej(new Error(d.error)) : w.res(d.bytes);
            }
        }
    });

    send({ op: 'ready' });
    flush();
    state.connected = true;
    for (const r of state.readyResolvers) r(buddy);
    state.readyResolvers.length = 0;
}

async function onFrame(msg) {
    if (state.framePending) return; // drop frames while an async callback runs
    const f = proto.getCodecs().frame.unpack(msg.bin);
    const meta = msg.meta || {};
    if (meta.ids) state.ids = meta.ids;
    if (meta.colliders) state.colliders = meta.colliders;
    if (meta.arti) state.arti = meta.arti;

    // Decode body states into a Map view.
    state.bodies.clear();
    const S = proto.BODY_STRIDE;
    const n = Math.min(state.ids.length, Math.floor(f.bodies.length / S));
    for (let i = 0; i < n; i++) {
        const o = i * S;
        state.bodies.set(state.ids[i], {
            pos: [f.bodies[o], f.bodies[o+1], f.bodies[o+2]],
            quat: [f.bodies[o+3], f.bodies[o+4], f.bodies[o+5], f.bodies[o+6]],
            vel: [f.bodies[o+7], f.bodies[o+8], f.bodies[o+9]],
            angvel: [f.bodies[o+10], f.bodies[o+11], f.bodies[o+12]],
        });
    }

    for (const m of meta.messages || []) {
        const cb = state.busCbs.get(m.topic);
        if (cb) { try { cb(m.data, m.from); } catch (e) { buddy.log('bus cb error:', e.message); } }
    }

    if (state.frameCb) {
        try {
            // Async callbacks (e.g. ONNX inference) are awaited so drive
            // commands computed from THIS frame's observations flush in the
            // same turn — the host applies them before its next sim step.
            const r = state.frameCb({
                time: f.time,
                dt: f.dt,
                cursor: f.cursor,
                bodies: state.bodies,
                colliders: state.colliders,
                arti: state.arti,
                events: meta.events || [],
            });
            if (r && typeof r.then === 'function') {
                state.framePending = true;
                try { await r; } finally { state.framePending = false; }
            }
        } catch (e) {
            state.framePending = false;
            buddy.log('frame cb error: ' + (e.stack || e.message));
        }
    }
    flush();
}
