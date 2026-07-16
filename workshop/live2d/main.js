// Live2D avatar buddy — first user of the DOM view modality. The cell asks
// the host to composite its iframe directly (fullscreen, transparent), then
// renders a Cubism model with the vendored `l2d` runtime (MIT, hacxy/l2d;
// bundles the Live2D Cubism cores) into an in-DOM canvas that tracks a
// plane-locked physics body. So she stands on the taskbar and on window
// ledges, can be grabbed and thrown (and tumbles, then rights herself),
// watches the cursor, and plays a tap motion when poked.
//
// The cell has no network, but `l2d` loads model files with
// fetch(dir + name) and Image.src — so we shim both with a virtual file
// map fed from pack assets before calling load().

export const meta = {
    name: 'Hiyori',
    author: 'BuddyEngine',
    version: '1',
    description: 'A Live2D desk companion (DOM-view modality): stands on windows, follows the cursor with her eyes, tumbles when thrown. Runtime: l2d (MIT) + Live2D Cubism core; model: Hiyori, Live2D Inc. sample (Free Material License).',
};

const buddy = await Buddy.ready();
buddy.log('live2d buddy booting');
window.addEventListener('error', (e) => buddy.log('cell error:', e.message, e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => buddy.log('cell rejection:', String(e.reason && e.reason.stack || e.reason)));

// ---------------------------------------------------------------------------
// Sizing (world meters <-> CSS px)
// ---------------------------------------------------------------------------
const { wPx, hPx, ppm, groundPy } = buddy.screen;
const DPR = window.devicePixelRatio || 1;
const toCssX = (wx) => (wx * ppm + wPx / 2) / DPR;
const toCssY = (wz) => (groundPy - wz * ppm) / DPR;

const AV_H = 1.45;                 // avatar height in meters (canvas box)
const AV_W = AV_H * 0.62;          // canvas box width
const BODY_HH = AV_H / 2 * 0.92;   // physics half-height (feet to head, snug)
const BODY_HW = AV_W * 0.30;       // physics half-width (torso, not sleeves)
const CSS_W = AV_W * ppm / DPR;
const CSS_H = AV_H * ppm / DPR;

// ---------------------------------------------------------------------------
// Virtual file system: pack assets served to l2d's fetch()/Image.src
// ---------------------------------------------------------------------------
const MODEL_JSON = 'model/Hiyori.model3.json';
const modelDir = 'model/';
const settings = JSON.parse(await buddy.assets.text(MODEL_JSON));
const fr = settings.FileReferences;
const files = [fr.Moc, fr.Physics, fr.Pose, fr.UserData, fr.DisplayInfo]
    .filter(Boolean)
    .concat(fr.Textures || []);
for (const group of Object.values(fr.Motions || {})) {
    for (const m of group) files.push(m.File);
}

const vfs = new Map(); // 'model/<rel>' -> ArrayBuffer
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
// Textures load via `img.src = dir + file`; reroute those to blob URLs
// (img-src blob: is allowed by the cell CSP).
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

// ---------------------------------------------------------------------------
// Boot l2d on an in-DOM canvas and go visible via the DOM view modality
// ---------------------------------------------------------------------------
await buddy.assets.script('l2d.min.js');   // classic IIFE -> window.L2D

const canvas = document.createElement('canvas');
canvas.width = Math.round(CSS_W * DPR);
canvas.height = Math.round(CSS_H * DPR);
function styleCanvas(el) { // CSP blocks style=""/<style>; CSSOM is fine
    const s = el.style;
    s.position = 'fixed';
    s.left = '0';
    s.top = '0';
    s.width = CSS_W + 'px';
    s.height = CSS_H + 'px';
    s.willChange = 'transform';
    s.visibility = 'hidden';   // revealed once the first frame positions it
    return s;
}
styleCanvas(canvas);
document.body.appendChild(canvas);

// Go visible BEFORE loading: a display:none iframe gets no rAF ticks, and
// l2d's whole load pipeline (and its 'loaded' event) rides its rAF render
// loop. The iframe is transparent and the canvas hidden, so nothing shows.
buddy.view.show({ layer: 'above' });

const l2d = L2D.init(canvas);
const loaded = new Promise((res) => l2d.on('loaded', res));
await l2d.load({ path: MODEL_JSON, logLevel: 'error', volume: 0 });
await loaded;
// l2d clones + replaces the canvas element internally; style the live one.
const cs = styleCanvas(l2d.getCanvas());
buddy.log('model rendering');

// ---------------------------------------------------------------------------
// Physics anchor
// ---------------------------------------------------------------------------
const body = buddy.phys.spawn('avatar', {
    shape: { type: 'box', hx: BODY_HW, hy: 0.18, hz: BODY_HH },
    pos: [2.2, 0, BODY_HH + 0.4],
    mass: 4,
    friction: 0.65,
    restitution: 0.08,
    planar2D: true,          // slides in the desktop plane, spins on depth axis
    angularDamping: 1.5,
    linearDamping: 0.02,
});

// ---------------------------------------------------------------------------
// Per-frame: track the body, right ourselves, watch the cursor
// ---------------------------------------------------------------------------
let held = false;
let lastTap = 0;
const track = { x: 0, y: 0, amt: 0 };   // smoothed gaze state

buddy.onFrame((world) => {
    const me = world.bodies.get(buddy.id + '/avatar');
    if (!me) return;
    const [bx, , bz] = me.pos;

    // Spin angle around the depth axis (planar2D leaves only quat y/w).
    const theta = 2 * Math.atan2(me.quat[1], me.quat[3]);

    // Move the canvas: horizontally centered on the body, feet at the box
    // bottom, rotation about the body center.
    const cx = toCssX(bx) - CSS_W / 2;
    const cy = toCssY(bz) - CSS_H / 2;
    cs.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px) rotate(${theta.toFixed(3)}rad)`;
    if (cs.visibility === 'hidden') cs.visibility = 'visible';

    for (const ev of world.events) {
        if (ev.type === 'pointerdown') {
            held = true;
            if (world.time - lastTap > 1.2) {
                lastTap = world.time;
                l2d.playMotion('TapBody', undefined, 3);
            }
        }
        if (ev.type === 'pointerup') held = false;
    }
    // A pointerup can go missing (click routed elsewhere); the cursor
    // button state is authoritative.
    if (held && !world.cursor.l) held = false;

    // Self-righting: PD on the spin, unless held or tumbling fast (a good
    // throw deserves a full somersault before she recovers).
    const speed = Math.hypot(me.vel[0], me.vel[2]);
    if (!held && speed < 2.5 && Math.abs(theta) > 0.02) {
        body.velocity(me.vel, [0, -3.0 * theta - 0.4 * me.angvel[1], 0]);
    }

    // Cursor gaze: head + eyes ease toward the cursor when it's nearby,
    // ease back to the idle motion when it leaves.
    const headZ = bz + BODY_HH * 0.72;
    const dx = world.cursor.wx - bx;
    const dz = world.cursor.wz - headZ;
    const near = Math.hypot(dx, dz) < 3.2 && Math.abs(theta) < 0.4;
    track.amt += ((near ? 1 : 0) - track.amt) * Math.min(1, world.dt * 4);
    track.x += (Math.max(-1, Math.min(1, dx / 1.4)) - track.x) * Math.min(1, world.dt * 6);
    track.y += (Math.max(-1, Math.min(1, dz / 1.2)) - track.y) * Math.min(1, world.dt * 6);
    if (track.amt > 0.02) {
        const a = track.amt;
        l2d.setParams({
            ParamAngleX: 30 * track.x * a,
            ParamAngleY: 30 * track.y * a,
            ParamBodyAngleX: 10 * track.x * a,
            ParamEyeBallX: track.x * a,
            ParamEyeBallY: track.y * a,
        });
    } else {
        l2d.setParams({});   // release: idle motion owns the params again
    }
});

// Friendly gossip hooks: greet new buddies, flinch at wisp panic.
buddy.bus.on('wisp.startled', () => l2d.playMotion('TapBody', undefined, 2));
