// Kirby — sprite-actor buddy from a Kirby: Squeak Squad spritesheet.
// The sheet is auto-segmented in-cell (blank-band scanning + background
// color-key), frames become textures, and a flip-book shader quad rides a
// rotation-locked physics ball.
//
// Kirby lives a little life on the desktop. Reflexes (grabbed, hit, blade
// nearby) preempt whatever he's doing; otherwise an energy/boredom-driven
// decide() picks activities: wandering, window-ledge parkour (with a real
// rise → somersault → fall → land jump), rolling trips across the screen,
// naps that other buddies can disturb, chase-and-nom games with wisps,
// spectating the swordfighter from a safe distance, greeting newly spawned
// buddies, and gossiping about all of it on the bus.

export const meta = {
    name: 'Kirby',
    author: 'BuddyEngine',
    version: '2',
    description: 'A round pink friend with a life of his own: naps, ledge parkour, wisp chasing, swordfight spectating, bus gossip. Sprites: Kirby Squeak Squad (Nintendo/HAL, ripped by Jackster).',
};

const buddy = await Buddy.ready();
buddy.log('kirby booting');

// ---------------------------------------------------------------------------
// Spritesheet segmentation
// ---------------------------------------------------------------------------
const sheetBytes = await buddy.assets.bytes('kirby-spritesheet.png');
const sheetBmp = await createImageBitmap(new Blob([sheetBytes]));
const W = sheetBmp.width, H = sheetBmp.height;
const scan = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
scan.drawImage(sheetBmp, 0, 0);
const px = scan.getImageData(0, 0, W, H).data;

const bg = [px[0], px[1], px[2], px[3]]; // top-left pixel = background
function isBg(i) {
    if (px[i + 3] < 16) return true;
    return Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) < 40 && bg[3] > 0;
}
function rowBlank(y) {
    for (let x = 0; x < W; x++) if (!isBg((y * W + x) * 4)) return false;
    return true;
}
function colBlank(x, y0, y1) {
    for (let y = y0; y <= y1; y++) if (!isBg((y * W + x) * 4)) return false;
    return true;
}

// Rows: maximal non-blank y-bands.
const rows = [];
let y = 0;
while (y < H) {
    while (y < H && rowBlank(y)) y++;
    if (y >= H) break;
    const y0 = y;
    while (y < H && !rowBlank(y)) y++;
    if (y - y0 >= 8) rows.push([y0, y - 1]);
}

// Frames per row: maximal non-blank x-runs, trimmed vertically.
function segmentRow(r) {
    const [y0, y1] = rows[r];
    const frames = [];
    let x = 0;
    while (x < W) {
        while (x < W && colBlank(x, y0, y1)) x++;
        if (x >= W) break;
        const x0 = x;
        while (x < W && !colBlank(x, y0, y1)) x++;
        if (x - x0 >= 6) {
            let ty0 = y0, ty1 = y1;
            const rowHasInk = (yy) => {
                for (let xx = x0; xx < x; xx++) if (!isBg((yy * W + xx) * 4)) return true;
                return false;
            };
            while (ty0 < ty1 && !rowHasInk(ty0)) ty0++;
            while (ty1 > ty0 && !rowHasInk(ty1)) ty1--;
            frames.push({ x: x0, y: ty0, w: x - x0, h: ty1 - ty0 + 1 });
        }
    }
    return frames;
}

const allRows = rows.map((_, i) => segmentRow(i));
buddy.log('sheet ' + W + 'x' + H + ', rows: ' +
    allRows.map((f, i) => `${i}:[y${rows[i][0]}-${rows[i][1]} n${f.length}]`).join(' '));

// ---------------------------------------------------------------------------
// Frame -> texture publishing (color-keyed, pixel-crisp, deduped)
// ---------------------------------------------------------------------------
let texCount = 0;
const texCache = new Map(); // sheet rect -> published frame (clips share frames)
function publishFrame(f) {
    const key = f.x + ',' + f.y + ',' + f.w + ',' + f.h;
    if (texCache.has(key)) return texCache.get(key);
    const c = new OffscreenCanvas(f.w, f.h);
    const g = c.getContext('2d');
    g.drawImage(sheetBmp, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    const img = g.getImageData(0, 0, f.w, f.h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 16 ||
            (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < 40 && bg[3] > 0)) {
            d[i + 3] = 0;
        }
    }
    g.putImageData(img, 0, 0);
    const id = 'k' + (texCount++);
    buddy.publishCanvas(id, c, { nearest: true }); // crisp pixel art
    const out = { id, w: f.w, h: f.h };
    texCache.set(key, out);
    return out;
}

// Animation clips: row index + frame indices. Calibrated against this sheet
// by offline segmentation (same algorithm) + eyeballing every frame. Beware:
// rows 1/6 and the wide round frames are INFLATED (full-of-air) Kirby — only
// use those for the puffed gag, never for grounded idle/walk.
//   row 0: 0 stand, 1 flat pancake, 2-9 slide lunges
//   row 2: 0-11 hurt spin, 18-19 drowsy stand, 20-27 doze->flat asleep,
//          28-29 happy sit, 30-31 excited stand/look-up, 32-35 puffed stand
//   row 1: 28-31 inhale, 32-35 full-of-air
//   row 7: 0-12 somersault, 13-25 arms-out falling, 29-38 walk cycle
//   row 8: 0 front stand, 5 leap, 10-15 dash, 40 startled ears-up
//   row 9: 0 spread-eagle dangle, 1 curled            (sprites face RIGHT)
function clip(row, indices, fps, loop = true) {
    const frames = indices
        .filter(i => allRows[row] && allRows[row][i])
        .map(i => publishFrame(allRows[row][i]));
    return { frames, fps, loop };
}

const ANIM = {
    idle:     clip(0, [0], 2),
    blink:    clip(2, [18], 8, false),
    drowsy:   clip(2, [18, 19], 2),
    walk:     clip(7, [29, 30, 31, 32, 33, 34, 35, 36, 37, 38], 10),
    run:      clip(8, [10, 11, 12, 13, 14, 15], 14),
    jump:     clip(8, [5], 8, false),
    flip:     clip(7, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 26, false),
    roll:     clip(7, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 18),
    fall:     clip(7, [18, 19, 20, 19], 9),
    land:     clip(0, [1], 10, false),
    tumble:   clip(2, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 16),
    inhale:   clip(1, [28, 29, 30, 31], 10, false),
    puffed:   clip(1, [32, 33, 34, 35], 6),
    doze:     clip(2, [20, 21, 22, 23, 24, 25, 26], 4, false),
    sleep:    clip(2, [26, 27], 1),
    wake:     clip(2, [31], 6, false),
    cheer:    clip(2, [30, 31], 5),
    sit:      clip(2, [28], 1),
    surprise: clip(8, [40], 1, false),
    held:     clip(9, [0, 1], 2),
};
// Fallback: any empty clip borrows idle's frames.
for (const k of Object.keys(ANIM)) {
    if (ANIM[k].frames.length === 0) ANIM[k] = { ...ANIM.idle };
}
buddy.log('anims: ' + Object.entries(ANIM).map(([k, a]) => k + ':' + a.frames.length).join(' '));

// ---------------------------------------------------------------------------
// Body + billboard
// ---------------------------------------------------------------------------
const R = 0.19;
const MASS = 0.35;
const G = 9.81;
const ball = buddy.phys.spawn('body', {
    shape: { type: 'sphere', r: R },
    pos: [-3.5, 0, 1.0],
    mass: MASS,
    friction: 0.6,
    restitution: 0.35,
    linearDamping: 0.2,
    planar2D: true,
    lock: { angX: true, angY: true, angZ: true }, // sprites don't roll
});

// Pixel-constant scale: a native texel is M_PER_PX meters on screen, every
// frame renders at its true pixel size (no zoom pumping between frames).
const M_PER_PX = 0.55 / 26; // Kirby's ~26px body -> 0.55m on screen
buddy.gfx.geometry('quad', { type: 'plane', params: { w: 1, h: 1 } }); // unit; scaled per frame
buddy.gfx.material('sprite', {
    type: 'shader',
    transparent: true,
    depthWrite: false,
    uniforms: { uTex: ANIM.idle.frames[0] ? ANIM.idle.frames[0].id : 'k0', uFlipX: 0, uFlipY: 1 },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uTex;
        uniform float uFlipX;
        uniform float uFlipY;
        void main() {
            vec2 uv = vUv;
            if (uFlipX > 0.5) uv.x = 1.0 - uv.x;
            if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
            vec4 c = texture2D(uTex, uv);
            if (c.a < 0.05) discard;
            gl_FragColor = c;
        }`,
});
const sprite = buddy.gfx.mesh('sprite', { geo: 'quad', mat: 'sprite' });
sprite.attach('body', [0, 0, 0], [0.7071, 0, 0, 0.7071]);

// ---------------------------------------------------------------------------
// Animation player (rate-scalable; one-shot clips report completion)
// ---------------------------------------------------------------------------
let anim = 'idle', animT = 0, frameIdx = 0, animRate = 1;
let facing = 1; // sheet sprites natively face RIGHT: facing > 0 = raw frames
function setAnim(name, rate = 1) {
    animRate = rate;
    if (anim === name) return;
    anim = name;
    animT = 0;
    frameIdx = 0;
}
function animDone() {
    const a = ANIM[anim];
    return !a.loop && frameIdx >= a.frames.length - 1;
}
let lastFrameH = -1;
function tickAnim(dt) {
    const a = ANIM[anim];
    animT += dt;
    const step = 1 / (a.fps * animRate);
    while (animT >= step) {
        animT -= step;
        frameIdx = a.loop ? (frameIdx + 1) % a.frames.length : Math.min(frameIdx + 1, a.frames.length - 1);
    }
    const f = a.frames[frameIdx];
    if (f) {
        const w = f.w * M_PER_PX, h = f.h * M_PER_PX;
        // Plane geometry spans local X/Y; Z is its normal.
        sprite.set({
            matParams: { uTex: f.id, uFlipX: facing < 0 ? 1 : 0 },
            scale: [w, h, 1],
        });
        // Bottom-anchor: feet stay at the ball's bottom no matter the trim.
        if (f.h !== lastFrameH) {
            lastFrameH = f.h;
            sprite.attach('body', [0, 0, h / 2 - R], [0.7071, 0, 0, 0.7071]);
        }
    }
}

// ---------------------------------------------------------------------------
// World helpers
// ---------------------------------------------------------------------------
function supportHeight(colliders, x, z) {
    let best = 0;
    for (const c of colliders) {
        if (c.id.startsWith('sys/wall')) continue;
        const top = c.cz + c.hz;
        if (x >= c.cx - c.hx && x <= c.cx + c.hx && top <= z && top > best) best = top;
    }
    return best;
}

// A window ledge Kirby could reach with one jump from where he stands.
function pickPlatform(world, x, z) {
    const feet = z - R;
    const cands = [];
    for (const c of world.colliders) {
        if (!c.id.startsWith('sys/win:')) continue;
        const top = c.cz + c.hz;
        const rise = top - feet;
        if (rise < 0.25 || rise > 1.2) continue;   // single-jump reach only
        if (c.hx < 0.4) continue;                  // too narrow to stand on
        const dx = Math.abs(c.cx - x);
        if (dx > 6) continue;
        cands.push({ cx: c.cx, hx: c.hx, top, dx });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.dx - b.dx);
    return cands[Math.floor(Math.random() * Math.min(2, cands.length))];
}

// ---------------------------------------------------------------------------
// Behavior state
// ---------------------------------------------------------------------------
let mode = 'wander', modeT = 0, md = { tx: -2 };
let energy = 0.8;         // naps when low, recovers asleep
let boredom = 0;          // idling builds it; adventures spend it
let heldUntil = 0, tumbleUntil = 0;
let airTime = 0, airFlip = false, landUntil = 0;
let lastHopT = 0, lastSqueak = 0, lastOwnerScan = 0, lastApplause = 0;
let cheerUntil = 0, surpriseUntil = 0, nomUntil = 0, puffedUntil = 0;
let playCooldownUntil = 0;
let poi = null;           // {x, z, t} point of interest from bus chatter
const greetQueue = [];    // newly spawned buddies to go say hi to
const knownOwners = new Set(['sys', buddy.id]);
const busInbox = [];

function setMode(m, data = {}) {
    if (mode !== m) buddy.log('mode: ' + mode + ' -> ' + m);
    mode = m;
    modeT = 0;
    md = data;
}

function leap(dvx, dvz, withFlip = false) {
    ball.impulse([MASS * dvx, 0, MASS * dvz]);
    airFlip = withFlip;
    lastHopT = worldTime;
}

// Ground locomotion toward an x target. Returns true on arrival.
let worldTime = 0, meVX = 0;
function move(tx, maxSpd, forceN) {
    const dx = tx - meX;
    if (Math.abs(dx) < 0.18) return true;
    const dir = Math.sign(dx);
    if (dir * meVX < maxSpd) ball.force([dir * forceN, 0, 0]);
    facing = dir;
    return false;
}
let meX = 0, meZ = 0;

function squeak(oomph, scared) {
    if (worldTime - lastSqueak < 2) return;
    lastSqueak = worldTime;
    buddy.bus.broadcast('kirby.poyo', { at: [meX, meZ], oomph, scared: !!scared });
}

function decide(world, s) {
    const halfW = buddy.screen.wPx / 2 / buddy.screen.ppm;
    const clampX = (v) => Math.max(-(halfW - 1), Math.min(halfW - 1, v));

    if (energy < 0.25) return setMode('nap', { phase: 'drowsy', nextSnore: 0 });
    if (greetQueue.length) return setMode('greet', { ...greetQueue.shift(), hops: 0, sent: false });
    if (poi && world.time - poi.t < 10) {
        const p = poi;
        poi = null;
        return setMode('investigate', { x: p.x, lookT: 0 });
    }
    if (s.wisp && s.dWisp < 3.8 && world.time > playCooldownUntil && energy > 0.35)
        return setMode('play', { pounces: 0 });
    if (s.pelvis && s.dPelvis > 2.2 && s.dPelvis < 6.5 && s.pelvisSpeed > 1.2 && Math.random() < 0.7)
        return setMode('watch', { settled: 0 });
    if (boredom > 16) {
        boredom = 0;
        const plat = pickPlatform(world, meX, meZ);
        if (plat && Math.random() < 0.65) return setMode('explore', { plat, phase: 'approach', jumpT: 0 });
        // roll trip: cross to the far side of the screen for no reason at all
        const far = clampX(-Math.sign(meX || 1) * (halfW - 1.5) * (0.5 + Math.random() * 0.45));
        return setMode('travel', { tx: far });
    }
    const r = Math.random();
    if (r < 0.18) {
        const plat = pickPlatform(world, meX, meZ);
        if (plat) return setMode('explore', { plat, phase: 'approach', jumpT: 0 });
    }
    if (r < 0.45) return setMode('idle', { until: world.time + 2.5 + Math.random() * 5, nextBlink: 0, blinkUntil: 0, nextGlance: 0 });
    if (r < 0.92) return setMode('wander', { tx: clampX(meX + (Math.random() * 7 - 3.5)) });
    cheerUntil = world.time + 1.3; // little dance for no reason
    return setMode('idle', { until: world.time + 2.5, nextBlink: 0, blinkUntil: 0, nextGlance: 0 });
}

// ---------------------------------------------------------------------------
// Bus: gossip in, gossip out
// ---------------------------------------------------------------------------
buddy.bus.on('wisp.startled', (data, from) => busInbox.push({ topic: 'wisp.startled', data, from }));
buddy.bus.on('kirby.poyo', (data, from) => busInbox.push({ topic: 'kirby.poyo', data, from }));
buddy.bus.on('kirby.greet', (data, from) => busInbox.push({ topic: 'kirby.greet', data, from }));
buddy.bus.on('sys.reset', () => {
    energy = 0.8;
    boredom = 0;
    setAnim('idle');
    setMode('wander', { tx: 0 });
});

// ---------------------------------------------------------------------------
// The frame loop
// ---------------------------------------------------------------------------
buddy.onFrame((world) => {
    const me = world.bodies.get(buddy.id + '/body');
    if (!me) return;
    const dt = world.dt;
    worldTime = world.time;
    modeT += dt;
    const [x, , z] = me.pos;
    const [vx, , vz] = me.vel;
    meX = x; meZ = z; meVX = vx;
    const speed = Math.hypot(vx, vz);
    const support = supportHeight(world.colliders, x, z);
    const grounded = z - R < support + 0.06;
    const halfW = buddy.screen.wPx / 2 / buddy.screen.ppm;

    // -- airtime / landing squish --------------------------------------------
    if (grounded) {
        if (airTime > 0.35) landUntil = world.time + 0.18;
        airTime = 0;
        airFlip = false;
    } else {
        airTime += dt;
    }

    // -- energy ---------------------------------------------------------------
    if (mode === 'nap' && md.phase === 'sleep') energy = Math.min(1, energy + dt * 0.03);
    else energy = Math.max(0, energy - dt * (speed > 2 ? 0.007 : 0.0035));
    if (mode === 'idle' || mode === 'wander' || mode === 'watch') boredom += dt;

    // -- perception -----------------------------------------------------------
    const s = { wisp: null, sword: null, pelvis: null, dWisp: Infinity, dPelvis: Infinity, pelvisSpeed: 0, swordThreat: 0, hunted: false };
    for (const [id, b] of world.bodies) {
        if (id.startsWith(buddy.id + '/')) continue;
        if (!s.wisp && id.endsWith('/ball')) s.wisp = b;
        if (id.endsWith('.sword')) s.sword = b;
        if (id.endsWith('.pelvis')) s.pelvis = b;
    }
    if (s.wisp) s.dWisp = Math.hypot(s.wisp.pos[0] - x, s.wisp.pos[2] - z);
    if (s.sword) {
        const d = Math.hypot(s.sword.pos[0] - x, s.sword.pos[2] - z);
        const swSpeed = Math.hypot(s.sword.vel[0], s.sword.vel[2]);
        if (d < 1.4 && swSpeed > 3) s.swordThreat = 1;
        else if (d < 0.8) s.swordThreat = 0.6;
    }
    if (s.pelvis) {
        s.dPelvis = Math.hypot(s.pelvis.pos[0] - x, s.pelvis.pos[2] - z);
        s.pelvisSpeed = Math.hypot(s.pelvis.vel[0], s.pelvis.vel[2]);
        // Hunted: the swordfighter targets the nearest buddy — notice it closing in.
        if (s.dPelvis < 2.6) {
            const nx = (x - s.pelvis.pos[0]) / (s.dPelvis || 1);
            const nz = (z - s.pelvis.pos[2]) / (s.dPelvis || 1);
            if (s.pelvis.vel[0] * nx + s.pelvis.vel[2] * nz > 1.0) s.hunted = true;
        }
    }

    // -- new buddies appear: queue a greeting ---------------------------------
    if (world.time - lastOwnerScan > 1.5) {
        lastOwnerScan = world.time;
        for (const [id] of world.bodies) {
            const owner = id.split('/')[0];
            if (knownOwners.has(owner)) continue;
            knownOwners.add(owner); // first body per owner is its root
            if (world.time > 6) greetQueue.push({ owner, bodyId: id });
        }
    }

    // -- bus inbox --------------------------------------------------------------
    for (const m of busInbox) {
        if (m.from === buddy.id) continue;
        const at = m.data && m.data.at;
        if (m.topic === 'wisp.startled') {
            const d = at ? Math.hypot(at[0] - x, at[1] - z) : Infinity;
            if (mode === 'nap') {
                if (d < 2.5) md.disturbed = true; // commotion right next to the nap spot
            } else if (at) {
                poi = { x: at[0], z: at[1], t: world.time };
                if (grounded && (mode === 'idle' || mode === 'wander')) leap(0, 2.2); // excited hop
            }
        } else if (m.topic === 'kirby.poyo' || m.topic === 'kirby.greet') {
            if (mode !== 'nap' && at) {
                facing = Math.sign(at[0] - x) || facing;
                cheerUntil = world.time + 1.0; // wave back at a fellow kirby
            }
        }
    }
    busInbox.length = 0;

    // -- pointer events ---------------------------------------------------------
    for (const ev of world.events) {
        if (ev.type === 'pointerdown') {
            if (mode === 'nap') md.disturbed = true;
            else {
                surpriseUntil = world.time + 0.5;
                if (grounded) leap(0, 2.6);
            }
        }
        if (ev.type === 'pointerenter' && mode !== 'nap') facing = Math.sign(world.cursor.wx - x) || facing;
    }

    // -- reflexes ----------------------------------------------------------------
    const dCursor = Math.hypot(world.cursor.wx - x, world.cursor.wz - z);
    if (dCursor < 0.6 && world.cursor.l) heldUntil = world.time + 0.15;

    if (world.time < heldUntil && mode !== 'held') setMode('held', {});
    if (speed > 6 && world.time > tumbleUntil && world.time >= heldUntil) {
        tumbleUntil = world.time + 1.2;
        squeak(speed);
        if (mode !== 'tumble') setMode('tumble', {});
    }
    if (mode !== 'tumble' && mode !== 'held' && (s.swordThreat > 0 || s.hunted) && mode !== 'flee') {
        squeak(1, true);
        setMode('flee', { clearT: 0 });
    }

    // -- mode updates -------------------------------------------------------------
    switch (mode) {
        case 'held': {
            if (world.time >= heldUntil) {
                surpriseUntil = world.time + 0.4;
                decide(world, s);
            }
            break;
        }
        case 'tumble': {
            if (world.time > tumbleUntil && grounded) decide(world, s);
            break;
        }
        case 'flee': {
            const threat = s.sword || s.pelvis;
            let dThreat = Infinity;
            if (threat) {
                dThreat = Math.hypot(threat.pos[0] - x, threat.pos[2] - z);
                const dir = Math.sign(x - threat.pos[0]) || 1;
                if (dir * vx < 3.8) ball.force([dir * 1.8, 0, 0]);
                facing = dir;
                if (grounded && dThreat < 1.6 && world.time - lastHopT > 0.5) leap(dir * 1.4, 3.6);
            }
            md.clearT = (s.swordThreat === 0 && !s.hunted && dThreat > 3.5) ? md.clearT + dt : 0;
            if (md.clearT > 1.2 || modeT > 12) decide(world, s);
            break;
        }
        case 'idle': {
            // blinks and glances keep the stand from looking frozen
            if (world.time > md.nextBlink) {
                md.blinkUntil = world.time + 0.13;
                md.nextBlink = world.time + 2.5 + Math.random() * 4;
            }
            if (world.time > md.nextGlance) {
                if (Math.random() < 0.4) facing = -facing;
                md.nextGlance = world.time + 1.5 + Math.random() * 3;
            }
            if (world.time > md.until) decide(world, s);
            break;
        }
        case 'wander': {
            if (move(md.tx, 1.6, 0.55)) decide(world, s);
            else if (grounded && Math.random() < dt * 0.05) leap(0, 1.8); // skip in the step
            if (modeT > 15) decide(world, s);
            break;
        }
        case 'travel': {
            // tuck and roll: fast trip across the desktop
            const dir = Math.sign(md.tx - x) || 1;
            if (Math.abs(md.tx - x) < 0.4) {
                if (grounded) leap(0, 2.8, true); // pop out of the roll with a flourish
                cheerUntil = world.time + 1.4;
                decide(world, s);
            } else {
                if (dir * vx < 4.4) ball.force([dir * 1.6, 0, 0]);
                facing = dir;
            }
            if (modeT > 12) decide(world, s);
            break;
        }
        case 'explore': {
            const p = md.plat;
            if (md.phase === 'approach') {
                const side = Math.sign(x - p.cx) || 1;                  // approach from Kirby's side
                const jumpX = p.cx + side * (p.hx + 0.35);              // just off the ledge edge
                const dxj = Math.abs(jumpX - x);
                if (dxj > 0.25) move(jumpX, dxj > 2.5 ? 3.0 : 1.6, dxj > 2.5 ? 1.2 : 0.55);
                else if (Math.abs(vx) > 0.5) ball.force([-vx * 0.8, 0, 0]); // brake before the leap
                else if (grounded) {
                    const feet = z - R;
                    const rise = p.top - feet;
                    const apex = rise + 0.5;                            // clear the ledge by half a meter
                    const vjz = Math.sqrt(2 * G * apex);
                    const tFlight = vjz / G + Math.sqrt(2 * 0.5 / G);
                    const landX = p.cx + side * Math.max(p.hx - 0.6, 0);
                    leap((landX - jumpX) / tFlight - vx, vjz - vz, true);
                    md.phase = 'air';
                    md.jumpT = world.time;
                }
            } else if (md.phase === 'air') {
                if (grounded && world.time - md.jumpT > 0.25) {
                    const onLedge = Math.abs((z - R) - p.top) < 0.2 && Math.abs(x - p.cx) < p.hx + 0.1;
                    if (onLedge) {
                        cheerUntil = world.time + 1.5; // made it!
                        setMode('idle', { until: world.time + 3 + Math.random() * 4, nextBlink: 0, blinkUntil: 0, nextGlance: 0 });
                    } else {
                        decide(world, s); // missed; shrug it off
                    }
                }
            }
            if (modeT > 10) decide(world, s);
            break;
        }
        case 'play': {
            if (!s.wisp || s.dWisp > 5.5) { decide(world, s); break; }
            const dx = s.wisp.pos[0] - x;
            const wSpeed = Math.hypot(s.wisp.vel[0], s.wisp.vel[2]);
            if (world.time < nomUntil || world.time < puffedUntil) {
                // savoring the (pretend) nom — hold still
            } else if (Math.abs(dx) > 0.5) {
                move(x + dx, 2.8, 1.1);
            }
            // pounce when close and the wisp sits still
            if (Math.abs(dx) < 1.2 && wSpeed < 1 && grounded && world.time - lastHopT > 1.2 && world.time > puffedUntil) {
                leap(Math.sign(dx || 1) * 1.5, 4.0, true);
                md.pounces++;
                md.pouncedAt = world.time;
            }
            // a pounce that lands right on top earns a pretend nom
            if (md.pouncedAt && grounded && world.time - md.pouncedAt > 0.3 && s.dWisp < 0.6) {
                md.pouncedAt = 0;
                nomUntil = world.time + 0.45;
                puffedUntil = world.time + 1.5;
            }
            if (md.pounces >= 3 || modeT > 18) {
                cheerUntil = world.time + 1.6; // good game
                playCooldownUntil = world.time + 35;
                decide(world, s);
            }
            break;
        }
        case 'watch': {
            if (!s.pelvis) { decide(world, s); break; }
            facing = Math.sign(s.pelvis.pos[0] - x) || facing;
            if (s.dPelvis < 1.8) { setMode('flee', { clearT: 0 }); break; } // too close for comfort
            if (s.dPelvis < 2.4) { move(x + Math.sign(x - s.pelvis.pos[0]) * 2, 1.6, 0.55); md.settled = 0; }
            else if (s.dPelvis > 5.2) { move(s.pelvis.pos[0], 1.6, 0.55); md.settled = 0; }
            else md.settled += dt;
            // applaud the show when the blade really moves
            if (s.sword && world.time - lastApplause > 3) {
                const swSpeed = Math.hypot(s.sword.vel[0], s.sword.vel[2]);
                if (swSpeed > 5 && s.dPelvis < 5.5) {
                    lastApplause = world.time;
                    surpriseUntil = world.time + 0.4;
                    cheerUntil = world.time + 1.4;
                }
            }
            if (modeT > 22 || (modeT > 6 && s.pelvisSpeed < 0.3)) decide(world, s); // show's over
            break;
        }
        case 'greet': {
            const target = world.bodies.get(md.bodyId);
            if (!target || modeT > 12) { decide(world, s); break; }
            const d = Math.hypot(target.pos[0] - x, target.pos[2] - z);
            if (d > 1.1) move(target.pos[0], d > 3 ? 3.0 : 1.6, d > 3 ? 1.2 : 0.55);
            else {
                facing = Math.sign(target.pos[0] - x) || facing;
                if (!md.sent) {
                    md.sent = true;
                    buddy.bus.broadcast('kirby.greet', { to: md.owner, at: [x, z] });
                }
                if (grounded && world.time - lastHopT > 0.5 && md.hops < 2) { leap(0, 2.2); md.hops++; }
                cheerUntil = world.time + 0.6;
                if (md.hops >= 2 && grounded) decide(world, s);
            }
            break;
        }
        case 'investigate': {
            if (Math.abs(md.x - x) > 0.4) move(md.x, 2.8, 1.1);
            else {
                md.lookT += dt;
                if (md.lookT > (md.nextGlance || 0.7)) { facing = -facing; md.nextGlance = md.lookT + 0.8; } // peer around
                if (md.lookT > 2.4) decide(world, s);
            }
            if (modeT > 10) decide(world, s);
            break;
        }
        case 'nap': {
            // disturbances: pokes, nearby commotion, the cursor hovering close
            let disturbed = md.disturbed;
            if (dCursor < 1.1) disturbed = true;
            for (const [id, b] of world.bodies) {
                if (id.startsWith(buddy.id + '/') || id === 'sys/target') continue;
                if (Math.hypot(b.pos[0] - x, b.pos[2] - z) < 1.0 &&
                    Math.hypot(b.vel[0], b.vel[2]) > 2.5) { disturbed = true; break; }
            }
            if (disturbed) {
                energy = Math.max(energy, 0.5); // adrenaline counts for something
                surpriseUntil = world.time + 0.6;
                if (grounded) leap(0, 2.4);
                decide(world, s);
                break;
            }
            if (md.phase === 'drowsy' && modeT > 2) md.phase = 'doze';
            else if (md.phase === 'doze' && anim === 'doze' && animDone()) md.phase = 'sleep';
            else if (md.phase === 'sleep' && energy > 0.95) {
                md.phase = 'waking';
                md.wakeT = world.time + 0.9;
            } else if (md.phase === 'waking' && world.time > md.wakeT) decide(world, s);
            break;
        }
    }

    // keep on screen
    if (Math.abs(x) > halfW - 0.5) ball.force([-Math.sign(x) * 3, 0, 0]);

    // -- pick animation ----------------------------------------------------------
    if (mode === 'held') setAnim('held');
    else if (mode === 'tumble') setAnim('tumble');
    else if (mode === 'nap') {
        if (md.phase === 'drowsy') setAnim('drowsy');
        else if (md.phase === 'doze') setAnim('doze');
        else if (md.phase === 'waking') setAnim('wake');
        else setAnim('sleep');
    }
    else if (!grounded && airTime > 0.12) {
        if (airFlip) {
            setAnim('flip');
            if (animDone()) airFlip = false; // somersault plays once, then jump/fall poses
        }
        else if (vz > 0.4) setAnim('jump');
        else setAnim('fall');
    }
    else if (world.time < landUntil) setAnim('land');
    else if (world.time < nomUntil) setAnim('inhale');
    else if (world.time < puffedUntil) setAnim('puffed');
    else if (world.time < surpriseUntil) setAnim('surprise');
    else if (world.time < cheerUntil) setAnim('cheer');
    else if (mode === 'travel' && speed > 2.6) setAnim('roll', Math.max(0.8, speed / 3.2));
    else if (speed > 2.3) setAnim('run', Math.max(0.8, Math.min(1.5, speed / 2.8)));
    else if (speed > 0.35) setAnim('walk', Math.max(0.7, Math.min(1.6, speed / 1.3)));
    else if (mode === 'watch' && md.settled > 1) setAnim('sit');
    else if (mode === 'idle' && world.time < md.blinkUntil) setAnim('blink');
    else if (energy < 0.32) setAnim('drowsy');
    else setAnim('idle');

    tickAnim(dt);
});

buddy.log('kirby online, poyo');
