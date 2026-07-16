// Buddy cell runtime: each buddy pack with a `main` script runs in a
// sandboxed null-origin iframe. The host pumps packcat-packed world frames
// in; cells reply with validated command batches. No pack code ever runs in
// this context.

import { getCodecs, OPS, isValidLocalId, BODY_STRIDE } from './protocol.js';
import { SceneMirror } from './scene-mirror.js';

const HARNESS = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy"
 content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: 'wasm-unsafe-eval'; worker-src blob:; img-src blob: data:;">
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
      await import(mk(e.data.main));
    } catch (err) {
      parent.postMessage({ t: 'commands', cmds: [{ op: 'log', msg: 'cell boot error: ' + (err.stack || err) }] }, '*');
    }
  });
})();
<\/script></body></html>`;

let cellCounter = 0;

class Cell {
    constructor(mgr, pack, manifest) {
        this.mgr = mgr;
        this.pack = pack;
        this.manifest = manifest;
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
        this.mirror = new SceneMirror(mgr.renderer.scene, (path) => mgr.readPackAsset(pack, path));
        this.iframe = null;
    }

    fq(localId) { return this.id + '/' + localId; }

    async start() {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.display = 'none';
        iframe.srcdoc = HARNESS;
        this.iframe = iframe;
        document.body.appendChild(iframe);
        await new Promise(res => iframe.addEventListener('load', res, { once: true }));

        const mainSrc = await this.mgr.readPackText(this.pack, this.manifest.main);
        iframe.contentWindow.postMessage({
            t: 'boot',
            packcat: this.mgr.sources.packcat,
            protocol: this.mgr.sources.protocol,
            sdk: this.mgr.sources.sdk,
            main: mainSrc,
            init: {
                v: 1,
                instanceId: this.id,
                manifest: this.manifest,
                screen: this.mgr.screenInfo(),
            },
        }, '*');
    }

    kill(reason) {
        if (this.dead) return;
        this.dead = true;
        this.mgr.log(`cell ${this.id} (${this.manifest.name}) killed: ${reason}`);
        for (const local of this.bodyIds) this.mgr.sim.removeBody(this.fq(local));
        this.bodyIds.clear();
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

    async spawn(pack, manifest) {
        if (!this.sources) await this.loadSources();
        const cell = new Cell(this, pack, manifest);
        this.cells.set(cell.id, cell);
        try {
            await cell.start();
        } catch (e) {
            cell.kill('start failed: ' + e.message);
        }
        return cell.id;
    }

    async readPackAsset(pack, path) {
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
                this.log(`[${cell.id} ${cell.manifest.name}] ${String(c.msg).slice(0, 500)}`);
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

    // Watchdog: kill cells that never became ready.
    checkHealth() {
        for (const cell of [...this.cells.values()]) {
            if (!cell.ready && performance.now() - cell.spawnedAt > 20000) {
                cell.kill('never became ready');
            }
        }
    }
}
