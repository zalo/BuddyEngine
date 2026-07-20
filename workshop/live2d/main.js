// Wanko — a Live2D dog (in a soba bowl) rendered through the DOM view
// modality, instanced: every dog lives in this one cell, each with its own
// canvas + l2d runtime riding a plane-locked physics body.
//
// The model's whole feature set is wired up:
//   motions — Idle (auto) · Tap (poke) · Flick/FlickLeft/FlickUp (thrown,
//             by direction) · Shake (after tumbling back upright) ·
//             Flick3 (petting: slow hold)
//   params  — PARAM_ANGLE/BODY_ANGLE gaze at the cursor · PARAM_EAR_L/R
//             perk when the cursor is near · PARAM_TERE blush while petted
//             · PARAM_MOUTH_OPEN_Y barks on hard landings · PARAM_YUGE
//             steam (option) · PARAM_BOWL_LID (option) · physics3 sway
//
// Cell-level plumbing (vfs fetch/Image shims for the no-network sandbox,
// the l2d runtime, view.show) happens once; instances share it all.

export const meta = {
    name: 'Wanko',
    author: 'BuddyEngine',
    version: '1',
    description: 'A Live2D dog in a soba bowl: pet it, poke it, throw it (it has opinions about that). Runtime: l2d (MIT) + Live2D Cubism core; model: wanko_touch (Live2D sample material).',
};

const buddy = await Buddy.ready();
buddy.log('wanko cell booting');
window.addEventListener('error', (e) => buddy.log('cell error:', e.message, e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => buddy.log('cell rejection:', String(e.reason && e.reason.stack || e.reason)));

// ---------------------------------------------------------------------------
// Sizing (world meters <-> CSS px)
// ---------------------------------------------------------------------------
const { wPx, ppm, groundPy } = buddy.screen;
const DPR = window.devicePixelRatio || 1;
const toCssX = (wx) => (wx * ppm + wPx / 2) / DPR;
const toCssY = (wz) => (groundPy - wz * ppm) / DPR;

const AV_H = 0.95;                 // bowl-dog is squat: near-square canvas
const AV_W = AV_H * 1.0;
const BODY_HH = AV_H / 2 * 0.80;
const BODY_HW = AV_W * 0.34;
const CSS_W = AV_W * ppm / DPR;
const CSS_H = AV_H * ppm / DPR;

// ---------------------------------------------------------------------------
// Virtual file system + l2d runtime (cell-global, shared by instances)
// ---------------------------------------------------------------------------
const MODEL_JSON = 'model/wanko_touch_t02.model3.json';
const modelDir = 'model/';
const settings = JSON.parse(await buddy.assets.text(MODEL_JSON));
const fr = settings.FileReferences;
const files = [fr.Moc, fr.Physics, fr.Pose, fr.UserData, fr.DisplayInfo]
    .filter(Boolean)
    .concat(fr.Textures || []);
for (const group of Object.values(fr.Motions || {})) {
    for (const m of group) files.push(m.File);
}

const vfs = new Map();
vfs.set(MODEL_JSON, new TextEncoder().encode(JSON.stringify(settings)).buffer);
await Promise.all(files.map(async (rel) => {
    vfs.set(modelDir + rel, await buddy.assets.bytes(modelDir + rel));
}));
buddy.log('model files loaded:', vfs.size);

const norm = (u) => String(u).replace(/^\.\//, '');
const realFetch = window.fetch.bind(window);
window.fetch = (url, opts) => {
    const hit = vfs.get(norm(url));
    if (hit) return Promise.resolve(new Response(hit.slice(0)));
    return realFetch(url, opts);
};
const blobUrls = new Map();
const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get() { return srcDesc.get.call(this); },
    set(v) {
        const key = norm(v);
        if (vfs.has(key)) {
            if (!blobUrls.has(key)) {
                blobUrls.set(key, URL.createObjectURL(new Blob([vfs.get(key)], { type: 'image/png' })));
            }
            v = blobUrls.get(key);
        }
        srcDesc.set.call(this, v);
    },
});

await buddy.assets.script('l2d.min.js');

// Show the (transparent) view BEFORE any model loads: hidden iframes get no
// rAF, and l2d's whole load pipeline rides its render loop.
buddy.view.show({ layer: 'above' });

// ---------------------------------------------------------------------------
// Options (toybox sidebar) — shared by all wankos
// ---------------------------------------------------------------------------
const opts = { gaze: true, barks: true, steam: false, lid: false };
buddy.options({
    gaze: { label: 'Watch the cursor', type: 'toggle', value: true },
    barks: { label: 'Bark on landing', type: 'toggle', value: true },
    steam: { label: 'Bowl steam', type: 'toggle', value: false },
    lid: { label: 'Bowl lid', type: 'toggle', value: false },
}, (key, value) => { opts[key] = !!value; });

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
Buddy.instances(async (inst) => {
    const sx = inst.spawn.x !== undefined ? inst.spawn.x : 2.2 + (inst.iid % 4) * 0.8;
    const sz = inst.spawn.z !== undefined ? Math.max(inst.spawn.z, BODY_HH) : BODY_HH + 0.4;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(CSS_W * DPR);
    canvas.height = Math.round(CSS_H * DPR);
    function styleCanvas(el) {
        const s = el.style;
        s.position = 'fixed';
        s.left = '0'; s.top = '0';
        s.width = CSS_W + 'px'; s.height = CSS_H + 'px';
        s.willChange = 'transform';
        s.visibility = 'hidden';
        return s;
    }
    styleCanvas(canvas);
    document.body.appendChild(canvas);

    const l2d = L2D.init(canvas);
    const loaded = new Promise((res) => l2d.on('loaded', res));
    await l2d.load({ path: MODEL_JSON, logLevel: 'error', volume: 0 });
    await loaded;
    const liveCanvas = l2d.getCanvas();
    const cs = styleCanvas(liveCanvas);
    inst.log('rendering');

    const body = inst.phys.spawn('avatar', {
        shape: { type: 'box', hx: BODY_HW, hy: 0.18, hz: BODY_HH },
        pos: [sx, 0, sz],
        mass: 3,
        friction: 0.7,
        restitution: 0.1,
        planar2D: true,
        angularDamping: 1.6,
        linearDamping: 0.02,
    });

    let held = false;
    let heldSince = 0;
    let petting = false;
    let petAmount = 0;          // eases blush in/out
    let tumbled = false;        // did a full tumble since last upright?
    let lastMotion = 0;
    let bark = 0;               // mouth pulse envelope
    let prevVz = 0;
    let lastHeldPos = null;
    let holdStillTime = 0;
    const track = { x: 0, y: 0, amt: 0 };

    const play = (group, priority, world) => {
        l2d.playMotion(group, undefined, priority);
        if (world) lastMotion = world.time;
    };

    inst.onFrame((world) => {
        const me = world.bodies.get(inst.bodyId('avatar'));
        if (!me) return;
        const [bx, , bz] = me.pos;
        const theta = 2 * Math.atan2(me.quat[1], me.quat[3]);

        const cx = toCssX(bx) - CSS_W / 2;
        const cy = toCssY(bz) - CSS_H / 2;
        cs.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px) rotate(${theta.toFixed(3)}rad)`;
        if (cs.visibility === 'hidden') cs.visibility = 'visible';

        // -- pointer events -------------------------------------------------
        for (const ev of world.events) {
            if (ev.type === 'pointerdown') {
                held = true;
                heldSince = world.time;
                lastHeldPos = [world.cursor.wx, world.cursor.wz];
                holdStillTime = 0;
                if (world.time - lastMotion > 0.8) play('Tap', 3, world);
            }
            if (ev.type === 'pointerup') held = false;
        }
        if (held && !world.cursor.l) held = false;

        // -- petting: held mostly still for a while -------------------------
        if (held) {
            const dx = world.cursor.wx - lastHeldPos[0], dz = world.cursor.wz - lastHeldPos[1];
            const speed = Math.hypot(dx, dz) / Math.max(world.dt, 1e-3);
            lastHeldPos = [world.cursor.wx, world.cursor.wz];
            holdStillTime = speed < 0.6 ? holdStillTime + world.dt : 0;
            if (!petting && holdStillTime > 0.7) {
                petting = true;
                play('Flick3', 3, world);
            }
        } else if (petting) {
            petting = false;
        }
        petAmount += ((petting ? 1 : 0) - petAmount) * Math.min(1, world.dt * 3);

        // -- thrown: flick motions by release direction ----------------------
        const speed = Math.hypot(me.vel[0], me.vel[2]);
        if (!held && world.time - lastMotion > 0.6 && speed > 3.2 && bz > BODY_HH + 0.2) {
            if (me.vel[2] > 2.5 && me.vel[2] > Math.abs(me.vel[0])) play('FlickUp', 3, world);
            else if (me.vel[0] < -2.5) play('FlickLeft', 3, world);
            else play('Flick', 3, world);
        }

        // -- tumble + recovery: shake it off ---------------------------------
        if (Math.abs(theta) > 1.5) tumbled = true;
        if (!held && speed < 2.5 && Math.abs(theta) > 0.02) {
            body.velocity(me.vel, [0, -3.0 * theta - 0.4 * me.angvel[1], 0]);
        }
        if (tumbled && Math.abs(theta) < 0.1 && speed < 0.8) {
            tumbled = false;
            play('Shake', 3, world);
        }

        // -- bark on hard landings -------------------------------------------
        const landed = prevVz < -3.5 && Math.abs(me.vel[2]) < 0.8 && bz < BODY_HH + 0.15;
        if (landed && opts.barks) bark = 1;
        prevVz = me.vel[2];
        bark = Math.max(0, bark - world.dt * 3.5);

        // -- cursor gaze + ear perk + forced params --------------------------
        const params = {};
        const headZ = bz + BODY_HH * 0.5;
        const dxC = world.cursor.wx - bx;
        const dzC = world.cursor.wz - headZ;
        const dCursor = Math.hypot(dxC, dzC);
        const near = opts.gaze && dCursor < 2.8 && Math.abs(theta) < 0.4;
        track.amt += ((near ? 1 : 0) - track.amt) * Math.min(1, world.dt * 4);
        track.x += (Math.max(-1, Math.min(1, dxC / 1.2)) - track.x) * Math.min(1, world.dt * 6);
        track.y += (Math.max(-1, Math.min(1, dzC / 1.0)) - track.y) * Math.min(1, world.dt * 6);
        if (track.amt > 0.02) {
            params.PARAM_ANGLE_X = 30 * track.x * track.amt;
            params.PARAM_ANGLE_Y = 30 * track.y * track.amt;
            params.PARAM_BODY_ANGLE_X = 8 * track.x * track.amt;
        }
        if (dCursor < 1.2) { params.PARAM_EAR_L = 1; params.PARAM_EAR_R = 1; }
        if (petAmount > 0.03) params.PARAM_TERE = petAmount;                // blush
        if (bark > 0.02) params.PARAM_MOUTH_OPEN_Y = Math.min(1, bark * 1.4);
        if (opts.steam) {
            params.PARAM_YUGE_01 = (world.time * 0.35) % 1;
            params.PARAM_YUGE_02 = (world.time * 0.35 + 0.5) % 1;
        }
        if (opts.lid) params.PARAM_BOWL_LID = 1;
        l2d.setParams(params);
    });

    return {
        dispose() {
            try { l2d.destroy(); } catch (e) {}
            liveCanvas.remove();
            canvas.remove();
            body.remove();
        },
    };
});
