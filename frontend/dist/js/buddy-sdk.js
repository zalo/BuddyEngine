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
    get manifest() { return initData.manifest; },
    get screen() { return initData.screen; },

    onFrame(cb) { state.frameCb = cb; },

    log(...args) { send({ op: 'log', msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') }); },

    phys: {
        spawn(id, desc) { send({ op: 'phys.spawn', id, ...desc }); return new BodyHandle(id); },
        body(id) { return new BodyHandle(id); },
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
    },

    bus: {
        send(to, topic, data) { send({ op: 'bus.send', to, topic, data }); },
        broadcast(topic, data) { send({ op: 'bus.send', to: '*', topic, data }); },
        on(topic, cb) { state.busCbs.set(topic, cb); },
    },

    // Escape hatch for cartridge-style visuals: render into any canvas you
    // like in here (OffscreenCanvas + WebGL/2D), then publish frames:
    publishCanvas(texId, offscreenCanvas) {
        const bitmap = offscreenCanvas.transferToImageBitmap();
        send({ op: 'tex.define', id: texId, bitmap });
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

function onFrame(msg) {
    const f = proto.getCodecs().frame.unpack(msg.bin);
    const meta = msg.meta || {};
    if (meta.ids) state.ids = meta.ids;
    if (meta.colliders) state.colliders = meta.colliders;

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
            state.frameCb({
                time: f.time,
                dt: f.dt,
                cursor: f.cursor,
                bodies: state.bodies,
                colliders: state.colliders,
                events: meta.events || [],
            });
        } catch (e) {
            buddy.log('frame cb error: ' + (e.stack || e.message));
        }
    }
    flush();
}
