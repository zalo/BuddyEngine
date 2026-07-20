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
    // Instancing: one cell can host N instances of its buddy.
    instFactory: null,          // pack's create(inst) from Buddy.instances()
    instances: new Map(),       // iid -> { inst, handle (may be a promise), frameCb }
    optionsCb: null,
    // Perf self-report (the host can't time another JS context).
    perfAcc: 0, perfWorst: 0, perfFrames: 0,
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
        // Multiple listeners per topic (instances each register their own).
        on(topic, cb) {
            if (!state.busCbs.has(topic)) state.busCbs.set(topic, new Set());
            state.busCbs.get(topic).add(cb);
            return () => state.busCbs.get(topic).delete(cb);
        },
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

// ---------------------------------------------------------------------------
// Instancing: a pack registers a factory and the host creates/destroys
// instances inside this one cell (no per-instance iframes). Each instance
// gets a namespaced facade of `buddy`: local ids become `i<N>.<id>`, except
// ids starting with '$', which name pack-global shared resources (define
// those once with the plain `buddy.gfx` and reference them as '$name').
// ---------------------------------------------------------------------------
function makeInstanceFacade(iid, spawn) {
    const pref = 'i' + iid + '.';
    const P = (id) => typeof id === 'string' && id.startsWith('$') ? id.slice(1) : pref + id;
    // Body refs may be foreign fq ids ('sys/…', 'b2/…') or already-prefixed
    // locals (e.g. from an instance rig's linkBody()) — leave those alone.
    const PB = (id) => (typeof id === 'string' && (id.includes('/') || id.startsWith(pref))) ? id : P(id);
    const owned = { bodies: new Set(), artis: new Set(), nodes: new Set() };
    const rec = { inst: null, handle: null, frameCb: null, owned };

    const prefixMat = (def) => {
        if (!def || !def.params || !def.params.map) return def;
        return { ...def, params: { ...def.params, map: P(def.params.map) } };
    };
    const prefixNodeProps = (props = {}) => {
        const p = { ...props };
        if (p.geo) p.geo = P(p.geo);
        if (p.mat) p.mat = P(p.mat);
        if (p.parent) p.parent = P(p.parent);
        return p;
    };
    const trackNode = (id) => { owned.nodes.add(P(id)); return id; };

    const inst = {
        iid,
        spawn: spawn || {},
        get id() { return initData.instanceId; },
        get screen() { return initData.screen; },
        // Fully-qualified world id of one of this instance's bodies.
        bodyId(local) { return initData.instanceId + '/' + P(local); },
        log(...args) { buddy.log('[i' + iid + ']', ...args); },
        onFrame(cb) { rec.frameCb = cb; },
        phys: {
            spawn(id, desc) { owned.bodies.add(P(id)); return buddy.phys.spawn(P(id), desc); },
            body(id) { return buddy.phys.body(P(id)); },
            articulation(id, data, spawnArg) {
                owned.artis.add(P(id));
                return buddy.phys.articulation(P(id), data, spawnArg);
            },
        },
        gfx: {
            geometry(id, def) { return buddy.gfx.geometry(P(id), def); },
            material(id, def) { return buddy.gfx.material(P(id), prefixMat(def)); },
            texture(id, def) { return buddy.gfx.texture(P(id), def); },
            group(id, props) { trackNode(id); return wrapNode(buddy.gfx.group(P(id), prefixNodeProps(props))); },
            mesh(id, props) { trackNode(id); return wrapNode(buddy.gfx.mesh(P(id), prefixNodeProps(props))); },
            sprite(id, props) { trackNode(id); return wrapNode(buddy.gfx.sprite(P(id), prefixNodeProps(props))); },
            gltf(id, asset, props) { trackNode(id); return wrapNode(buddy.gfx.gltf(P(id), asset, prefixNodeProps(props))); },
            node(id) { return wrapNode(buddy.gfx.node(P(id))); },
        },
        assets: buddy.assets,
        bus: buddy.bus,
        view: buddy.view,
        publishCanvas(texId, canvas, opts) { return buddy.publishCanvas(P(texId), canvas, opts); },
    };
    // Node handles attach to bodies by local name — instance-prefix those.
    function wrapNode(handle) {
        const origAttach = handle.attach.bind(handle);
        handle.attach = (body, op, oq) => { origAttach(PB(body), op, oq); return handle; };
        return handle;
    }
    rec.inst = inst;
    return rec;
}

function addInstance(iid, spawn) {
    if (!state.instFactory || state.instances.has(iid)) return;
    const rec = makeInstanceFacade(iid, spawn);
    state.instances.set(iid, rec);
    try {
        rec.handle = state.instFactory(rec.inst);
    } catch (e) {
        buddy.log('instance create error:', e.stack || e.message);
        state.instances.delete(iid);
        return;
    }
    flush();
}

async function removeInstance(iid) {
    const rec = state.instances.get(iid);
    if (!rec) return;
    state.instances.delete(iid);
    try {
        const h = await rec.handle;
        if (h && typeof h.dispose === 'function') h.dispose();
    } catch (e) { buddy.log('instance dispose error:', e.message); }
    // Sweep anything the instance left behind.
    for (const id of rec.owned.artis) send({ op: 'arti.remove', id });
    for (const id of rec.owned.bodies) send({ op: 'phys.remove', id });
    for (const id of rec.owned.nodes) send({ op: 'node.remove', id });
    flush();
}

// Adjustable options, surfaced in the host's toybox sidebar.
// schema: { key: { label, type: 'range'|'toggle'|'select', value, min?, max?, step?, choices? } }
buddy.options = function (schema, onChange) {
    state.optionsCb = onChange || null;
    send({ op: 'options', schema });
    flush();
};

const Buddy = {
    ready() {
        if (state.connected) return Promise.resolve(buddy);
        return new Promise(res => state.readyResolvers.push(res));
    },
    // Register an instance factory: create(inst) -> optional { dispose() }
    // (or a promise of one). The host then adds/removes instances at will;
    // the first instance is created automatically after boot.
    instances(create) {
        state.instFactory = create;
        send({ op: 'caps', instanced: true });
        flush();
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
        } else if (d.t === 'inst') {
            if (d.op === 'add') addInstance(d.iid, d.spawn);
            else if (d.op === 'remove') removeInstance(d.iid);
        } else if (d.t === 'options.set') {
            if (state.optionsCb) {
                try { state.optionsCb(d.key, d.value); } catch (err) { buddy.log('options cb error:', err.message); }
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
        for (const cb of state.busCbs.get(m.topic) || []) {
            try { cb(m.data, m.from); } catch (e) { buddy.log('bus cb error:', e.message); }
        }
    }

    const world = {
        time: f.time,
        dt: f.dt,
        cursor: f.cursor,
        bodies: state.bodies,
        colliders: state.colliders,
        arti: state.arti,
        events: meta.events || [],
    };

    const t0 = performance.now();
    if (state.frameCb) {
        try {
            // Async callbacks (e.g. ONNX inference) are awaited so drive
            // commands computed from THIS frame's observations flush in the
            // same turn — the host applies them before its next sim step.
            const r = state.frameCb(world);
            if (r && typeof r.then === 'function') {
                state.framePending = true;
                try { await r; } finally { state.framePending = false; }
            }
        } catch (e) {
            state.framePending = false;
            buddy.log('frame cb error: ' + (e.stack || e.message));
        }
    }

    // Instance callbacks get the same world with events filtered to their
    // own objects ('<cell>/i<N>.…', including articulation link suffixes).
    for (const [iid, rec] of state.instances) {
        if (!rec.frameCb) continue;
        const pref = initData.instanceId + '/i' + iid + '.';
        try {
            const r = rec.frameCb({
                ...world,
                iid,
                events: world.events.filter(ev => ev.id && ev.id.startsWith(pref)),
            });
            if (r && typeof r.then === 'function') {
                state.framePending = true;
                try { await r; } finally { state.framePending = false; }
            }
        } catch (e) {
            state.framePending = false;
            buddy.log('i' + iid + ' frame cb error: ' + (e.stack || e.message));
        }
    }

    // Self-timed CPU cost, reported ~2x/s (the host can't profile across
    // the iframe boundary; this is main-thread time spent in this cell).
    const ms = performance.now() - t0;
    state.perfAcc += ms;
    state.perfWorst = Math.max(state.perfWorst, ms);
    if (++state.perfFrames >= 30) {
        send({
            op: 'perf',
            avg: state.perfAcc / state.perfFrames,
            worst: state.perfWorst,
            instances: state.instFactory ? state.instances.size : 1,
        });
        state.perfAcc = 0; state.perfWorst = 0; state.perfFrames = 0;
    }
    flush();
}
