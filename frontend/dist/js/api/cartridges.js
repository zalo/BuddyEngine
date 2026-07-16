// Buddy cell runtime: each buddy pack with a `main` script runs in a
// sandboxed null-origin iframe. The host pumps packcat-packed world frames
// in; cells reply with validated command batches. No pack code ever runs in
// this context.

import { getCodecs, OPS, isValidLocalId, BODY_STRIDE } from './protocol.js';
import { SceneMirror } from './scene-mirror.js';

const HARNESS = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy"
 content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: 'wasm-unsafe-eval'; worker-src blob:; img-src blob: data:; connect-src blob: data:;">
</head><body><script>
(function () {
  let booted = false;
  window.addEventListener('message', async function onBoot(e) {
    if (booted || !e.data || e.data.t !== 'boot') return;
    booted = true;
    window.removeEventListener('message', onBoot);
    const mk = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    try {
      const packcat = await import(mk(e.data.packcat));
      const proto = await import(mk(e.data.protocol));
      proto.initProtocol(packcat);
      const sdk = await import(mk(e.data.sdk));
      sdk.__init(proto, e.data.init);
      // Pack code executes HERE, in the cell - never on the host. Its
      // optional 'export const meta = {...}' is relayed as plain strings.
      const mod = await import(mk(e.data.main));
      if (mod && mod.meta) {
        const m = mod.meta;
        parent.postMessage({ t: 'commands', cmds: [{
          op: 'meta',
          name: m.name, description: m.description,
          author: m.author, version: m.version,
        }] }, '*');
      }
    } catch (err) {
      parent.postMessage({ t: 'commands', cmds: [{ op: 'log', msg: 'cell boot error: ' + (err.stack || err) }] }, '*');
    }
  });
})();
<\/script></body></html>`;

let cellCounter = 0;

class Cell {
    constructor(mgr, pack) {
        this.mgr = mgr;
        this.pack = pack;
        this.name = pack.name;   // folder name until the cell's meta arrives
        this.meta = {};
        this.id = 'b' + (++cellCounter);
        this.ready = false;
        this.dead = false;
        this.spawnedAt = performance.now();
        this.pendingPhys = [];
        this.inbox = [];        // bus messages queued for next frame
        this.events = [];       // pointer events queued for next frame
        this.lastEpochSent = -1;
        this.lastCollidersJson = '';
        this.bodyIds = new Set(); // local ids of bodies this cell spawned
        this.artiIds = new Set(); // local ids of articulations this cell spawned
        this.mirror = new SceneMirror(mgr.renderer.scene, (path) => mgr.readPackAsset(pack, path));
        this.iframe = null;
    }

    fq(localId) { return this.id + '/' + localId; }

    // DOM view modality: composite this cell's iframe directly over (or
    // under) the three.js canvas. The iframe stays sandboxed/null-origin;
    // pointer-events:none is forced so input always lands on the host,
    // which routes it back through physics hit-testing like any buddy.
    setView(c) {
        const f = this.iframe;
        if (!f) return;
        if (!c.visible) {
            f.style.display = 'none';
            return;
        }
        const layer = c.layer === 'below' ? '-1' : '5'; // menu=20, overlay=10
        f.style.cssText =
            'display:block; position:fixed; inset:0; width:100vw; height:100vh;' +
            'border:none; background:transparent; pointer-events:none;' +
            'z-index:' + layer + ';' +
            'opacity:' + (typeof c.opacity === 'number' ? Math.max(0, Math.min(1, c.opacity)) : 1) + ';';
    }

    async start() {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.display = 'none';
        iframe.srcdoc = HARNESS;
        this.iframe = iframe;
        document.body.appendChild(iframe);
        await new Promise(res => iframe.addEventListener('load', res, { once: true }));

        const mainSrc = await this.mgr.readPackText(this.pack, 'main.js');
        iframe.contentWindow.postMessage({
            t: 'boot',
            packcat: this.mgr.sources.packcat,
            protocol: this.mgr.sources.protocol,
            sdk: this.mgr.sources.sdk,
            main: mainSrc,
            init: {
                v: 1,
                instanceId: this.id,
                packName: this.pack.name,
                screen: this.mgr.screenInfo(),
            },
        }, '*');
    }

    kill(reason) {
        if (this.dead) return;
        this.dead = true;
        this.mgr.log(`cell ${this.id} (${this.name}) killed: ${reason}`);
        for (const local of this.bodyIds) this.mgr.sim.removeBody(this.fq(local));
        this.bodyIds.clear();
        for (const local of this.artiIds) this.mgr.sim.removeArticulation(this.fq(local));
        this.artiIds.clear();
        this.mirror.disposeAll();
        if (this.iframe) this.iframe.remove();
        this.mgr.cells.delete(this.id);
    }
}

export class CartridgeManager {
    constructor(sim, desk, renderer, log) {
        this.sim = sim;
        this.desk = desk;
        this.renderer = renderer;
        this.log = log || console.log;
        this.cells = new Map();
        this.sources = null;
        this.epoch = 0;
        this.lastIdsKey = '';
        this.cachedIds = [];

        window.addEventListener('message', (e) => this.onMessage(e));
    }

    async loadSources() {
        const get = async (p) => (await fetch(p)).text();
        this.sources = {
            packcat: await get('./vendor/packcat.js'),
            protocol: await get('./js/api/protocol.js'),
            sdk: await get('./js/buddy-sdk.js'),
        };
    }

    screenInfo() {
        return {
            wPx: this.desk.screenW,
            hPx: this.desk.screenH,
            ppm: this.desk.ppm,
            groundPy: this.desk.groundPy,
        };
    }

    async spawn(pack) {
        if (!this.sources) await this.loadSources();
        const cell = new Cell(this, pack);
        this.cells.set(cell.id, cell);
        try {
            await cell.start();
        } catch (e) {
            cell.kill('start failed: ' + e.message);
        }
        return cell.id;
    }

    async readPackAsset(pack, path) {
        // 'sys:' prefix = host-provided shared runtime assets (whitelisted),
        // so packs don't have to bundle onnxruntime/three-scale payloads.
        if (path.startsWith('sys:')) {
            const sub = path.slice(4).replace(/^\/+/, '');
            if (!sub.startsWith('vendor/') && !sub.startsWith('assets/')) {
                throw new Error('sys asset not allowed: ' + sub);
            }
            const resp = await fetch('./' + sub);
            if (!resp.ok) throw new Error('sys asset missing: ' + sub);
            return resp.arrayBuffer();
        }
        const b64 = await window.go.main.App.ReadPackFile(pack.id, path);
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    }

    async readPackText(pack, path) {
        return new TextDecoder().decode(await this.readPackAsset(pack, path));
    }

    cellFromEvent(e) {
        for (const cell of this.cells.values()) {
            if (cell.iframe && e.source === cell.iframe.contentWindow) return cell;
        }
        return null;
    }

    onMessage(e) {
        const cell = this.cellFromEvent(e);
        if (!cell || cell.dead || !e.data) return;
        if (e.data.t === 'commands' && Array.isArray(e.data.cmds)) {
            for (const cmd of e.data.cmds.slice(0, 256)) {
                try {
                    this.applyCommand(cell, cmd, e.data);
                } catch (err) {
                    this.log(`cell ${cell.id} cmd ${cmd && cmd.op} error: ${err.message}`);
                }
            }
        }
    }

    applyCommand(cell, c, envelope) {
        switch (c.op) {
            case OPS.READY:
                cell.ready = true;
                break;
            case OPS.LOG:
                this.log(`[${cell.id} ${cell.name}] ${String(c.msg).slice(0, 500)}`);
                break;
            case OPS.META:
                // Pack self-description, exported from its main.js and read
                // inside the cell — the host only receives these strings.
                cell.meta = {
                    name: c.name !== undefined ? String(c.name).slice(0, 64) : undefined,
                    description: c.description !== undefined ? String(c.description).slice(0, 500) : undefined,
                    author: c.author !== undefined ? String(c.author).slice(0, 64) : undefined,
                    version: c.version !== undefined ? String(c.version).slice(0, 16) : undefined,
                };
                if (cell.meta.name) cell.name = cell.meta.name;
                break;

            // -- physics (queued; applied just before the next sim step) ----
            case OPS.PHYS_SPAWN:
                if (!isValidLocalId(c.id)) throw new Error('bad id');
                if (cell.bodyIds.size >= 64) throw new Error('body budget');
                cell.pendingPhys.push(() => {
                    this.sim.spawnBody(cell.fq(c.id), c);
                    cell.bodyIds.add(c.id);
                });
                break;
            case OPS.PHYS_REMOVE:
                cell.pendingPhys.push(() => {
                    this.sim.removeBody(cell.fq(c.id));
                    cell.bodyIds.delete(c.id);
                });
                break;
            case OPS.PHYS_FORCE:
                cell.pendingPhys.push(() => this.sim.applyForceTo(cell.fq(c.id), c.f, c.p, c.mode));
                break;
            case OPS.PHYS_VELOCITY:
                cell.pendingPhys.push(() => this.sim.setBodyVelocity(cell.fq(c.id), c.v, c.w));
                break;
            case OPS.PHYS_KINEMATIC:
                cell.pendingPhys.push(() => this.sim.setBodyKinematicTarget(cell.fq(c.id), c.pos, c.quat));
                break;

            // -- articulated rigs -------------------------------------------
            case OPS.ARTI_CREATE: {
                if (!isValidLocalId(c.id)) throw new Error('bad id');
                if (cell.artiIds.size >= 4) throw new Error('articulation budget');
                const d = c.data || {};
                if (!Array.isArray(d.bodies) || d.bodies.length === 0 || d.bodies.length > 64)
                    throw new Error('bad rig: bodies');
                if ((d.dofInfo || []).length > 64) throw new Error('bad rig: dofs');
                cell.pendingPhys.push(() => {
                    this.sim.createArticulation(cell.fq(c.id), d, c.spawn);
                    cell.artiIds.add(c.id);
                });
                break;
            }
            case OPS.ARTI_DRIVE:
                cell.pendingPhys.push(() =>
                    this.sim.setArticulationDriveTargets(cell.fq(c.id), c.targets || []));
                break;
            case OPS.ARTI_RESET:
                cell.pendingPhys.push(() =>
                    this.sim.applyArticulationInit(cell.fq(c.id), { x: c.x !== undefined ? c.x : 0 }));
                break;
            case OPS.ARTI_REMOVE:
                cell.pendingPhys.push(() => {
                    this.sim.removeArticulation(cell.fq(c.id));
                    cell.artiIds.delete(c.id);
                });
                break;

            // -- retained scene graph ---------------------------------------
            case OPS.GEO_DEFINE: cell.mirror.defineGeometry(c); break;
            case OPS.MAT_DEFINE: cell.mirror.defineMaterial(c); break;
            case OPS.TEX_DEFINE:
                cell.mirror.defineTexture(c).catch(err => this.log(`tex ${c.id}: ${err.message}`));
                break;
            case OPS.NODE_ADD:
                cell.mirror.addNode(c).catch(err => this.log(`node ${c.id}: ${err.message}`));
                break;
            case OPS.NODE_SET: cell.mirror.setNode(c); break;
            case OPS.NODE_ATTACH: {
                // May attach to own bodies or any sys body (read-only tracking).
                const body = c.body.includes('/') ? c.body : cell.fq(c.body);
                if (!body.startsWith('sys/') && !body.startsWith(cell.id + '/')) {
                    throw new Error('attach: foreign body');
                }
                cell.mirror.attachNode({ ...c, body }, (id) => this.sim.bodyPose(id));
                break;
            }
            case OPS.NODE_REMOVE: cell.mirror.removeNode(c); break;
            case OPS.ANIM: cell.mirror.anim(c); break;

            // -- DOM view ---------------------------------------------------
            case OPS.VIEW_SET:
                cell.setView(c);
                break;

            // -- assets & bus -----------------------------------------------
            case OPS.ASSET_FETCH:
                this.readPackAsset(cell.pack, c.path).then(bytes => {
                    if (!cell.dead) cell.iframe.contentWindow.postMessage(
                        { t: 'asset', reqId: c.reqId, bytes }, '*', [bytes]);
                }).catch(err => {
                    if (!cell.dead) cell.iframe.contentWindow.postMessage(
                        { t: 'asset', reqId: c.reqId, error: err.message }, '*');
                });
                break;
            case OPS.BUS_SEND: {
                const msg = { from: cell.id, topic: String(c.topic).slice(0, 64), data: c.data };
                if (c.to === '*') {
                    for (const other of this.cells.values()) {
                        if (other !== cell) other.inbox.push(msg);
                    }
                } else {
                    const target = this.cells.get(c.to);
                    if (target) target.inbox.push(msg);
                }
                break;
            }
            default:
                throw new Error('unknown op');
        }
    }

    // Queue a pointer event for the owning cell of a body fqid.
    routePointerEvent(fqid, type, wx, wz) {
        const owner = fqid.split('/')[0];
        const cell = this.cells.get(owner);
        if (cell) cell.events.push({ type, id: fqid, wx, wz });
    }

    // Apply queued physics commands (call once per render frame, before
    // stepping the sim).
    applyPendingPhysics() {
        for (const cell of this.cells.values()) {
            for (const fn of cell.pendingPhys) {
                try { fn(); } catch (e) { this.log(`cell ${cell.id} phys: ${e.message}`); }
            }
            cell.pendingPhys.length = 0;
        }
    }

    // Track attached nodes / animations (call after physics, before render).
    updateMirrors() {
        for (const cell of this.cells.values()) {
            cell.mirror.update((id) => this.sim.bodyPose(id));
        }
    }

    // Send one world frame to every ready cell (call once per render frame).
    pumpFrames(time, dt, cursor) {
        if (this.cells.size === 0) return;
        const snap = this.sim.snapshotBodies();
        const idsKey = snap.ids.join('|');
        if (idsKey !== this.lastIdsKey) {
            this.epoch++;
            this.lastIdsKey = idsKey;
            this.cachedIds = snap.ids;
        }

        const colliders = [];
        for (const [key, entry] of this.sim.staticActors) {
            colliders.push({
                id: 'sys/' + key,
                cx: entry.box.cx, cz: entry.box.cz,
                hx: entry.box.hx, hz: entry.box.hz,
                kinematic: !!entry.kinematic,
            });
        }
        const collidersJson = JSON.stringify(colliders);

        const packed = getCodecs().frame.pack({
            time, dt,
            epoch: this.epoch,
            cursor,
            bodies: snap.buf,
        });

        for (const cell of this.cells.values()) {
            if (!cell.ready || cell.dead) continue;
            const meta = { events: cell.events, messages: cell.inbox };
            // Joint states for this cell's articulations, fresh every frame
            // so policies can observe and drive with no added latency.
            if (cell.artiIds.size > 0) {
                meta.arti = {};
                for (const local of cell.artiIds) {
                    const js = this.sim.articulationJointState(cell.fq(local));
                    if (js) meta.arti[local] = js;
                }
            }
            if (this.epoch !== cell.lastEpochSent) {
                meta.ids = this.cachedIds;
                cell.lastEpochSent = this.epoch;
            }
            if (collidersJson !== cell.lastCollidersJson) {
                meta.colliders = colliders;
                cell.lastCollidersJson = collidersJson;
            }
            // pack() returns a fresh Uint8Array; copy per cell so each post
            // can transfer its own buffer.
            const bin = this.cells.size > 1 ? packed.slice() : packed;
            cell.iframe.contentWindow.postMessage({ t: 'frame', bin, meta }, '*', [bin.buffer]);
            cell.events = [];
            cell.inbox = [];
        }
    }

    // Reset every articulation to its init pose and tell the cells why.
    resetArticulations() {
        for (const cell of this.cells.values()) {
            for (const local of cell.artiIds) {
                this.sim.applyArticulationInit(cell.fq(local), { x: 0 });
            }
            cell.inbox.push({ from: 'sys', topic: 'sys.reset', data: {} });
        }
    }

    // Watchdog: kill cells that never became ready.
    checkHealth() {
        for (const cell of [...this.cells.values()]) {
            if (!cell.ready && performance.now() - cell.spawnedAt > 20000) {
                cell.kill('never became ready');
            }
        }
    }
}
