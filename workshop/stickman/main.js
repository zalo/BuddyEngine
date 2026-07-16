// Stickman — a Pivot / Animator-vs-Animation style 2D stick figure buddy.
//
// Two-layer design:
//   ANIM     — keyframed absolute-angle poses (Pivot-style) drive the joint
//              bodies via strong velocity steering: crisp, posed motion.
//   RAGDOLL  — grab him, hit him, or throw him and the pose targets drop
//              away; Verlet-style stick constraints keep the skeleton
//              connected while PhysX gravity and collisions take over.
//   RECOVER  — settled ragdolls lerp back onto their feet and resume ANIM.
//
// Rendering is a single OffscreenCanvas cartridge: the skeleton is drawn as
// round-capped 2D lines from the *physics truth* (world.bodies), so ragdoll
// frames render correctly for free.

export const meta = {
    name: 'Stickman',
    author: 'shiftmaker',
    version: '1',
    description: 'A Pivot-style stick figure: keyframe-animated until you grab, hit, or throw him — then full ragdoll, and he gets back up swinging.',
};

const buddy = await Buddy.ready();
const DEBUG = false; // set true to log a state heartbeat every ~5s
buddy.log('stickman booting, instance', buddy.id);

// ---------------------------------------------------------------------------
// Units & skeleton
// ---------------------------------------------------------------------------
const FPS = 36, DT = 1 / FPS;
const SIZE = 1.9;
const S = SIZE / buddy.screen.ppm;   // meters per figure-px
const V = FPS * S;                   // px/frame -> m/s

const TORSO = 34, HEADOFF = 17, HEAD_R = 13.5, UARM = 24, LARM = 24, ULEG = 28.5, LLEG = 28.5;
const STAND_H = 59;                  // pelvis height: legs' reach + foot sphere radius

// Joints (point masses). Small spheres so PhysX gives us ground/window
// contact and host grab/throw; the lines between them are pure rendering.
const JOINTS = {
    pelvis: { m: 0.30, r: 5 },
    neck:   { m: 0.20, r: 5 },
    head:   { m: 0.15, r: HEAD_R, cursor: true },
    elL:    { m: 0.05, r: 4 },
    haL:    { m: 0.05, r: 4 },
    elR:    { m: 0.05, r: 4 },
    haR:    { m: 0.05, r: 4 },
    knL:    { m: 0.07, r: 4 },
    ftL:    { m: 0.07, r: 4 },
    knR:    { m: 0.07, r: 4 },
    ftR:    { m: 0.07, r: 4 },
};
const JOINT_NAMES = Object.keys(JOINTS);

// Stick constraints (ragdoll connectivity), lengths in figure px.
const STICKS = [
    ['pelvis', 'neck', TORSO],
    ['neck', 'head', HEADOFF],
    ['neck', 'elL', UARM], ['elL', 'haL', LARM],
    ['neck', 'elR', UARM], ['elR', 'haR', LARM],
    ['pelvis', 'knL', ULEG], ['knL', 'ftL', LLEG],
    ['pelvis', 'knR', ULEG], ['knR', 'ftR', LLEG],
    ['pelvis', 'head', TORSO + HEADOFF], // soft brace: keeps the spine from folding
];

// ---------------------------------------------------------------------------
// Poses & clips (Pivot-style absolute angles, degrees)
//   limbs: 0 = straight down, + = toward facing direction
//   torso: 0 = straight up,   + = lean toward facing direction
//   bob:   root height offset in px
// ---------------------------------------------------------------------------
function P(t, ual, lal, uar, lar, ull, lll, ulr, llr, bob = 0) {
    return { t, ual, lal, uar, lar, ull, lll, ulr, llr, bob };
}
// Mirror a pose (swap left/right limbs) for the second half of gait cycles.
function M(p) {
    return { t: p.t, ual: p.uar, lal: p.lar, uar: p.ual, lar: p.lal,
             ull: p.ulr, lll: p.llr, ulr: p.ull, llr: p.lll, bob: p.bob };
}

const walk0 = P(4, -28, -14, 30, 18, 28, 14, -22, -34, 0);
const walk1 = P(5, -6, -10, 8, 14, 4, 0, -8, -52, 2);
const run0 = P(14, -50, -70, 42, 20, 44, 12, -30, -70, 2);
const run1 = P(15, -10, -60, 5, 30, 8, -20, -12, -95, 5);

const CLIPS = {
    idle: {
        loop: true, hold: 55,
        frames: [
            P(0, 10, 5, -10, -5, 9, 4, -9, -4, 0),
            P(1.5, 12, 7, -12, -7, 9, 4, -9, -4, -1.5),
        ],
    },
    walk: { loop: true, hold: 8, frames: [walk0, walk1, M(walk0), M(walk1)] },
    run:  { loop: true, hold: 5, frames: [run0, run1, M(run0), M(run1)] },
    wave: {
        loop: true, hold: 10,
        frames: [
            P(0, 10, 5, 155, 175, 9, 4, -9, -4, 0),
            P(0, 10, 5, 165, 135, 9, 4, -9, -4, 0),
        ],
    },
    fight: {
        loop: true, hold: 14,
        frames: [
            P(8, 35, 105, 55, 115, 22, 8, -14, -14, -2),
            P(9, 38, 100, 58, 110, 22, 8, -14, -14, -3.5),
        ],
    },
    punch: {
        loop: false, hold: 4,
        frames: [
            P(10, 35, 105, 20, 130, 22, 8, -14, -14, -2),   // windup
            P(16, 35, 105, 88, 88, 26, 10, -16, -16, -1),   // strike!
            P(10, 35, 105, 55, 115, 22, 8, -14, -14, -2),   // recover
        ],
    },
    taunt: {
        loop: true, hold: 12,
        frames: [
            P(-4, 60, 40, -60, -40, 9, 4, -9, -4, 0),       // arms out: "come on!"
            P(-2, 70, 65, -70, -65, 9, 4, -9, -4, -1),
        ],
    },
    dance: {
        loop: true, hold: 9,
        frames: [
            P(-6, 140, 165, -30, -60, 24, 10, -6, -4, -2),
            P(6, -30, -60, 140, 165, -6, -4, 24, 10, -2),
            P(-6, 140, 100, 140, 100, 14, 6, -14, -6, 2),
            P(6, -40, -80, -40, -80, -14, -6, 14, 6, -3),
        ],
    },
};

// Forward kinematics: pose -> joint positions (figure px, y-up) around a
// pelvis root, with facing (+1/-1) and a whole-body rotation (radians, for
// lying down / getting up).
function fk(pose, f, rot) {
    const rad = Math.PI / 180;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const rotv = (x, y) => [x * cr - y * sr, x * sr + y * cr];
    // limbs: 0 = down, + = toward facing; mirror x for facing, then body rot
    const add = (base, a, len) => {
        const t = a * rad;
        const d = rotv(Math.sin(t) * f, -Math.cos(t));
        return [base[0] + d[0] * len, base[1] + d[1] * len];
    };
    const pts = { pelvis: [0, 0] };
    const tt = pose.t * rad;
    const td = rotv(Math.sin(tt) * f, Math.cos(tt)); // torso: 0 = up
    pts.neck = [td[0] * TORSO, td[1] * TORSO];
    pts.head = [pts.neck[0] + td[0] * HEADOFF, pts.neck[1] + td[1] * HEADOFF];
    pts.elL = add(pts.neck, pose.ual, UARM);
    pts.haL = add(pts.elL, pose.lal, LARM);
    pts.elR = add(pts.neck, pose.uar, UARM);
    pts.haR = add(pts.elR, pose.lar, LARM);
    pts.knL = add(pts.pelvis, pose.ull, ULEG);
    pts.ftL = add(pts.knL, pose.lll, LLEG);
    pts.knR = add(pts.pelvis, pose.ulr, ULEG);
    pts.ftR = add(pts.knR, pose.llr, LLEG);
    return pts;
}

function lerpPose(a, b, t) {
    const o = {};
    for (const k of Object.keys(a)) o[k] = a[k] + (b[k] - a[k]) * t;
    return o;
}

// ---------------------------------------------------------------------------
// Physics bodies
// ---------------------------------------------------------------------------
const handles = {};

function spawnJoint(name, pos) {
    const j = JOINTS[name];
    handles[name] = buddy.phys.spawn(name, {
        shape: { type: 'sphere', r: j.r * S },
        pos,
        mass: j.m,
        friction: 0.6,
        restitution: 0.2,
        planar2D: true,
        angularDamping: 0.95,
        linearDamping: 0.01,
        collides: 'world',
        collidesCursor: !!j.cursor,
    });
}

function spawnAll() {
    const x0 = 4.0, z0 = STAND_H * S + 0.3; // clear of the swordfighter's spawn
    const pts = fk(CLIPS.idle.frames[0], 1, 0);
    for (const name of JOINT_NAMES) {
        spawnJoint(name, [x0 + pts[name][0] * S, 0, z0 + pts[name][1] * S]);
    }
}
spawnAll();

// ---------------------------------------------------------------------------
// Rendering: one canvas cartridge, redrawn from body positions each step
// ---------------------------------------------------------------------------
const CAN = 320;
const canvas = new OffscreenCanvas(CAN, CAN);
const ctx = canvas.getContext('2d');
// publish once BEFORE the material exists: materials resolve their map at
// define time, and later canvas frames update that same texture in place
buddy.publishCanvas('texFig', canvas);
buddy.gfx.material('matFig', { type: 'sprite', params: { map: 'texFig', transparent: true } });
const figNode = buddy.gfx.sprite('fig', { mat: 'matFig', scale: [CAN * S, CAN * S, 1] });

const DRAW_STICKS = STICKS.slice(0, 10); // skip the soft spine brace

function render(parts, center) {
    const c = ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, CAN, CAN);
    // No flip transform here: the px() mapping below already writes world-up
    // to high canvas rows, which the un-flipped ImageBitmap upload (three.js
    // ignores flipY for ImageBitmaps) then displays right side up.
    const px = (p) => [(p[0] - center[0]) / S + CAN / 2, CAN / 2 + (p[2] - center[2]) / S];
    c.strokeStyle = '#202020';
    c.fillStyle = '#202020';
    c.lineWidth = 5;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const LEAF = { haL: 1, haR: 1, ftL: 1, ftR: 1 };
    for (const [a, b] of DRAW_STICKS) {
        const pa = px(parts[a].pos), pb = px(parts[b].pos);
        // extend to the leaf joint's sphere surface: the physics sphere holds
        // the joint center one radius off whatever it touches (the ground)
        if (LEAF[b]) {
            const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
            const d = Math.hypot(dx, dy) || 1;
            const ext = JOINTS[b].r / d;
            pb[0] += dx * ext; pb[1] += dy * ext;
        }
        c.beginPath(); c.moveTo(pa[0], pa[1]); c.lineTo(pb[0], pb[1]); c.stroke();
    }
    const h = px(parts.head.pos);
    c.beginPath(); c.arc(h[0], h[1], HEAD_R, 0, Math.PI * 2); c.fill();
    buddy.publishCanvas('texFig', canvas);
    figNode.set({ pos: [center[0], -0.05, center[2]] });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let tick = 0, lastDebug = 0;
let mode = 'ANIM';                 // ANIM | RAGDOLL | RECOVER
let clip = 'idle', clipFrame = 0, clipTime = 0, clipDone = false;
let facing = 1;
let root = null;                   // [x, z] pelvis target (set on first frame)
let rot = 0;                       // whole-body rotation (radians)
let grabbed = null;
let grabbedLoose = 0;
let settleTimer = 0;
let recoverT = 0, recoverFrom = null;
let anger = 0;                     // punches you into fight mode
let nextIdleThink = 300;
let wanderTarget = null;
let punchCooldown = 0;
const vSet = {};
let lastCursor = { wx: 0, wz: 0 };
let cursorSpeed = 0, cursorMovedAt = 0;

buddy.bus.on('sys.reset', () => {
    spawnAll();
    mode = 'ANIM'; clip = 'idle'; clipFrame = 0; clipTime = 0;
    root = null; rot = 0; anger = 0; grabbed = null;
});

function partState(world, name) { return world.bodies.get(buddy.id + '/' + name); }

function supportZAt(colliders, x, z) {
    let best = 0;
    for (const c of colliders) {
        if (c.id.startsWith('sys/wall')) continue;
        const top = c.cz + c.hz;
        if (x >= c.cx - c.hx && x <= c.cx + c.hx && top <= z + 0.02 && top > best) best = top;
    }
    return best;
}

function setClip(name) {
    if (clip === name) return;
    clip = name; clipFrame = 0; clipTime = 0; clipDone = false;
}

function currentPose() {
    const c = CLIPS[clip];
    const i = clipFrame % c.frames.length;
    const j = (clipFrame + 1) % c.frames.length;
    const t = Math.min(1, clipTime / c.hold);
    if (!c.loop && clipFrame >= c.frames.length - 1) { clipDone = true; return c.frames[c.frames.length - 1]; }
    return lerpPose(c.frames[i], c.frames[j], t);
}

function advanceClip(k) {
    const c = CLIPS[clip];
    if ((clipTime += k) >= c.hold) {
        clipTime = 0;
        clipFrame++;
        if (c.loop) clipFrame %= c.frames.length;
        else if (clipFrame >= c.frames.length) { clipFrame = c.frames.length - 1; clipDone = true; }
    }
}

// ---------------------------------------------------------------------------
// The 36Hz step
// ---------------------------------------------------------------------------
function step(world, dt) {
    // k = elapsed time in "36Hz frames": all timers/speeds keep their original
    // tuning but the sim now runs (and renders) at full host frame rate.
    const k = dt * FPS;
    tick += k;
    punchCooldown = Math.max(0, punchCooldown - k);

    const parts = {};
    for (const name of JOINT_NAMES) {
        const st = partState(world, name);
        if (!st) return;
        parts[name] = st;
    }
    const pelvis = parts.pelvis;
    if (!root) root = [pelvis.pos[0], pelvis.pos[2]];

    // cursor bookkeeping
    const cdx = (world.cursor.wx - lastCursor.wx) / S, cdz = (world.cursor.wz - lastCursor.wz) / S;
    cursorSpeed = Math.hypot(cdx, cdz) / Math.max(k, 1e-3); // px per 36Hz-frame
    if (cursorSpeed > 0.5) cursorMovedAt = tick;
    lastCursor = { wx: world.cursor.wx, wz: world.cursor.wz };
    const dCursor = Math.hypot(world.cursor.wx - pelvis.pos[0], world.cursor.wz - pelvis.pos[2]) / S;

    // pointer events: grab -> ragdoll
    for (const ev of world.events) {
        const id = ev.id.includes('/') ? ev.id.split('/').pop() : ev.id;
        if (ev.type === 'pointerdown' && JOINT_NAMES.includes(id)) {
            grabbed = id;
            mode = 'RAGDOLL';
        } else if (ev.type === 'pointerup') {
            grabbed = null;
        }
    }
    if (grabbed && !world.cursor.l && !world.cursor.r) {
        if ((grabbedLoose += k) > 3) { grabbed = null; grabbedLoose = 0; }
    } else grabbedLoose = 0;

    // hit detection: big unexplained velocity change on head/pelvis/neck
    // (skipped for the first moments while the joints settle into pose)
    for (const name of tick < 60 ? [] : ['head', 'pelvis', 'neck']) {
        if (grabbed === name || !(name in vSet)) continue;
        const p = parts[name];
        const dvx = p.vel[0] - vSet[name][0];
        const dvz = p.vel[2] - (vSet[name][1] - 9.81 * dt);
        const vpf = Math.hypot(dvx, dvz) / V;
        const nearCursor = Math.hypot(world.cursor.wx - p.pos[0], world.cursor.wz - p.pos[2]) / S
            < JOINTS[name].r + 30;
        if (vpf > (nearCursor ? 16 : 12)) {
            mode = 'RAGDOLL';
            settleTimer = 0;
            anger = Math.min(anger + (nearCursor ? 2 : 1), 8);
            break;
        }
    }

    const supportZ = supportZAt(world.colliders, pelvis.pos[0], pelvis.pos[2]);
    const onGround = pelvis.pos[2] - supportZ < (STAND_H + 14) * S;

    // ------------------------------------------------------------- behavior
    if (mode === 'ANIM') {
        // fight mode: square up against the cursor and throw punches
        if (anger > 2 && tick - cursorMovedAt < 400) {
            facing = world.cursor.wx >= pelvis.pos[0] ? 1 : -1;
            if (dCursor > 95) {
                setClip(anger > 5 ? 'run' : 'walk');
                root[0] += facing * (anger > 5 ? 4.4 : 2.4) * S * k;
            } else if (punchCooldown === 0) {
                setClip('punch');
                punchCooldown = 34;
            } else if (clipDone || clip !== 'punch') {
                setClip('fight');
            }
            anger -= 0.004 * k; // fights cool off slowly
        } else if (clip === 'punch' && !clipDone) {
            // finish the swing
        } else if (wanderTarget !== null) {
            const dx = wanderTarget - pelvis.pos[0];
            facing = dx >= 0 ? 1 : -1;
            setClip('walk');
            root[0] += facing * 2.4 * S * k;
            if (Math.abs(dx) / S < 30) { wanderTarget = null; setClip('idle'); }
        } else if (tick > nextIdleThink) {
            nextIdleThink = tick + 250 + Math.random() * 350;
            const r = Math.random();
            const halfW = buddy.screen.wPx / 2 / buddy.screen.ppm;
            if (r < 0.30) {
                wanderTarget = (Math.random() * 2 - 1) * (halfW - 1);
            } else if (r < 0.45 && dCursor < 500) {
                facing = world.cursor.wx >= pelvis.pos[0] ? 1 : -1;
                setClip('wave');
            } else if (r < 0.58) {
                setClip('dance');
            } else if (r < 0.68) {
                // taunt whatever humanoid is nearby (or the void)
                for (const [id, b] of world.bodies) {
                    if (id.endsWith('.pelvis') && !id.startsWith(buddy.id)) {
                        facing = b.pos[0] >= pelvis.pos[0] ? 1 : -1;
                        break;
                    }
                }
                setClip('taunt');
            } else {
                setClip('idle');
            }
        } else if ((clip === 'wave' || clip === 'dance' || clip === 'taunt') && tick > nextIdleThink - 150) {
            setClip('idle');
        }
        anger = Math.max(0, anger - 0.002 * k);
        advanceClip(k);
    }

    // ------------------------------------------------------------ solve
    const newV = {};

    if (mode === 'ANIM' || mode === 'RECOVER') {
        // steer joints to the posed FK targets
        let pose, useRot = 0;
        if (mode === 'RECOVER') {
            recoverT = Math.min(1, recoverT + k / 40);
            pose = lerpPose(recoverFrom.pose, CLIPS.idle.frames[0], recoverT);
            useRot = recoverFrom.rot * (1 - recoverT);
            root[0] = recoverFrom.x;
            root[1] = recoverFrom.z + (supportZ + STAND_H * S - recoverFrom.z) * recoverT;
            if (recoverT >= 1) { mode = 'ANIM'; setClip(anger > 2 ? 'fight' : 'idle'); }
        } else {
            pose = currentPose();
            root[1] = supportZ + (STAND_H + (pose.bob || 0)) * S;
        }
        // keep the root on-screen
        const halfW = buddy.screen.wPx / 2 / buddy.screen.ppm;
        root[0] = Math.max(-halfW + 0.4, Math.min(halfW - 0.4, root[0]));

        const pts = fk(pose, facing, useRot);
        for (const name of JOINT_NAMES) {
            const p = parts[name];
            const tx = root[0] + pts[name][0] * S;
            const tz = root[1] + pts[name][1] * S;
            let vx = (tx - p.pos[0]) * FPS * 0.55;
            let vz = (tz - p.pos[2]) * FPS * 0.55;
            const cap = 30 * V;
            const sp = Math.hypot(vx, vz);
            if (sp > cap) { vx *= cap / sp; vz *= cap / sp; }
            newV[name] = [vx, vz];
        }
        // if the pose is being dragged wildly off target, he's been yanked
        const err = Math.hypot(pelvis.pos[0] - root[0], pelvis.pos[2] - root[1]) / S;
        if (err > 55) { mode = 'RAGDOLL'; settleTimer = 0; }
    }

    if (mode === 'RAGDOLL') {
        // stick constraints as velocity corrections; PhysX does the rest
        for (const name of JOINT_NAMES) {
            newV[name] = [parts[name].vel[0], parts[name].vel[2]];
        }
        for (let iter = 0; iter < 3; iter++) {
            for (const [a, b, len] of STICKS) {
                const pa = parts[a], pb = parts[b];
                const ax = pa.pos[0] + newV[a][0] * DT, az = pa.pos[2] + newV[a][1] * DT;
                const bx = pb.pos[0] + newV[b][0] * DT, bz = pb.pos[2] + newV[b][1] * DT;
                let dx = bx - ax, dz = bz - az;
                const d = Math.hypot(dx, dz) || 1e-6;
                const err = d - len * S;
                dx /= d; dz /= d;
                const wa = grabbed === a ? 0 : 1 / JOINTS[a].m;
                const wb = grabbed === b ? 0 : 1 / JOINTS[b].m;
                const wsum = wa + wb;
                if (wsum === 0) continue;
                const corr = err * FPS * 0.4 / wsum;
                newV[a][0] += dx * corr * wa; newV[a][1] += dz * corr * wa;
                newV[b][0] -= dx * corr * wb; newV[b][1] -= dz * corr * wb;
            }
        }
        // mild air drag so he settles
        const drag = Math.max(0, 1 - 0.005 * k);
        for (const name of JOINT_NAMES) {
            newV[name][0] *= drag;
            newV[name][1] *= drag;
        }
        // settled? get back up
        let maxSp = 0;
        for (const name of JOINT_NAMES) {
            maxSp = Math.max(maxSp, Math.hypot(parts[name].vel[0], parts[name].vel[2]) / V);
        }
        if (!grabbed && maxSp < 2.2) {
            if ((settleTimer += k) > 22) {
                // snapshot the lie: torso direction -> body rotation
                const tdx = parts.neck.pos[0] - pelvis.pos[0];
                const tdz = parts.neck.pos[2] - pelvis.pos[2];
                recoverFrom = {
                    pose: CLIPS.idle.frames[0],
                    rot: Math.atan2(-tdx, tdz), // torso dir at rot: (-sin, cos)
                    x: pelvis.pos[0],
                    z: pelvis.pos[2],
                };
                recoverT = 0;
                mode = 'RECOVER';
            }
        } else settleTimer = 0;
    }

    // apply
    for (const name of JOINT_NAMES) {
        if (name === grabbed || !newV[name]) {
            vSet[name] = [parts[name].vel[0], parts[name].vel[2]];
            continue;
        }
        handles[name].velocity([newV[name][0], 0, newV[name][1]]);
        vSet[name] = newV[name];
    }

    // draw from physics truth, centered between pelvis and neck
    const cx = (pelvis.pos[0] + parts.neck.pos[0]) / 2;
    const cz = (pelvis.pos[2] + parts.neck.pos[2]) / 2;
    render(parts, [cx, 0, cz]);

    if (DEBUG && tick - lastDebug >= 180) {
        lastDebug = tick;
        buddy.log(`t=${Math.floor(tick)} mode=${mode} clip=${clip} pelvis=(${pelvis.pos[0].toFixed(2)},${pelvis.pos[2].toFixed(2)})` +
            ` anger=${anger.toFixed(1)} ground=${onGround} facing=${facing}`);
    }
}

// Full host frame rate with dt scaling — a fixed low tick makes the canvas
// cartridge visibly stutter (nothing host-side interpolates it for us).
buddy.onFrame((world) => {
    step(world, Math.min(world.dt, DT * 2));
});

buddy.log('stickman online');
