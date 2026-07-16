// Kirby — sprite-actor buddy from a Kirby: Squeak Squad spritesheet.
// The sheet is auto-segmented in-cell (blank-band scanning + background
// color-key), frames become textures, and a flip-book shader quad rides a
// rotation-locked physics ball. Kirby wanders, chases the wisp, keeps a
// respectful distance from the swordfighter's blade, tumbles when hit,
// and squeaks about it on the bus.

export const meta = {
    name: 'Kirby',
    author: 'BuddyEngine',
    version: '1',
    description: 'A round pink friend. Chases wisps, dodges swords, tumbles well. Sprites: Kirby Squeak Squad (Nintendo/HAL, ripped by Jackster).',
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
// Frame -> texture publishing (color-keyed, pixel-crisp)
// ---------------------------------------------------------------------------
let texCount = 0;
function publishFrame(f) {
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
    return { id, w: f.w, h: f.h };
}

// Animation clips: row index + frame indices (calibrated to this sheet).
function clip(row, indices, fps, loop = true) {
    const frames = indices
        .filter(i => allRows[row] && allRows[row][i])
        .map(i => publishFrame(allRows[row][i]));
    return { frames, fps, loop };
}

const ANIM = {
    idle:    clip(0, [0, 1], 3),
    walk:    clip(7, [0, 1, 2, 3, 4, 5, 6, 7], 10),
    run:     clip(8, [0, 1, 2, 3, 4, 5, 6, 7], 14),
    jump:    clip(9, [0], 8, false),
    tumble:  clip(9, [2, 3, 4, 5], 12),
    squish:  clip(2, [0, 1], 8),
    inhale:  clip(1, [0, 1, 2], 8),
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
const ball = buddy.phys.spawn('body', {
    shape: { type: 'sphere', r: R },
    pos: [-3.5, 0, 1.0],
    mass: 0.35,
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
// Animation player
// ---------------------------------------------------------------------------
let anim = 'idle', animT = 0, frameIdx = 0, facing = 1;
function setAnim(name) {
    if (anim === name) return;
    anim = name;
    animT = 0;
    frameIdx = 0;
}
let lastFrameH = -1;
function tickAnim(dt) {
    const a = ANIM[anim];
    animT += dt;
    const step = 1 / a.fps;
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
// Behavior
// ---------------------------------------------------------------------------
const HOME_X = -3.5;
let mode = 'wander';   // wander | chase | flee | tumble | held
let modeT = 0;
let wanderTarget = HOME_X;
let tumbleUntil = 0;
let heldUntil = 0;
let lastGround = 0;
let lastHopT = 0;
let lastSqueak = 0;

function findBody(world, suffix, excludeSelf = true) {
    for (const [id, b] of world.bodies) {
        if (excludeSelf && id.startsWith(buddy.id + '/')) continue;
        if (id.endsWith(suffix)) return { id, b };
    }
    return null;
}

buddy.bus.on('wisp.startled', (data) => {
    // A startled wisp is entertainment: hop with excitement.
    ball.impulse([0, 0, 1.4]);
});

buddy.bus.on('sys.reset', () => setAnim('idle'));

buddy.onFrame((world) => {
    const me = world.bodies.get(buddy.id + '/body');
    if (!me) return;
    const dt = world.dt;
    modeT += dt;
    const [x, , z] = me.pos;
    const [vx, , vz] = me.vel;
    const speed = Math.hypot(vx, vz);
    const support = supportHeight(world.colliders, x, z);
    const grounded = z - R < support + 0.06;
    if (grounded) lastGround = world.time;

    // -- perception --------------------------------------------------------
    const wisp = findBody(world, '/ball');
    const sword = findBody(world, '.sword');
    const pelvis = findBody(world, '.pelvis');

    let swordThreat = 0;
    if (sword) {
        const d = Math.hypot(sword.b.pos[0] - x, sword.b.pos[2] - z);
        const swSpeed = Math.hypot(sword.b.vel[0], sword.b.vel[2]);
        if (d < 1.4 && swSpeed > 3) swordThreat = 1;
        else if (d < 0.8) swordThreat = 0.6;
    }

    // -- events -------------------------------------------------------------
    for (const ev of world.events) {
        if (ev.type === 'pointerdown') {
            setAnim('inhale');
            ball.impulse([0, 0, 1.0]);
        }
        if (ev.type === 'pointerenter') facing = Math.sign(world.cursor.wx - x) || facing;
    }

    // Hard hit -> tumble + squeak.
    if (speed > 6 && world.time > tumbleUntil) {
        tumbleUntil = world.time + 1.2;
        if (world.time - lastSqueak > 2) {
            lastSqueak = world.time;
            buddy.bus.broadcast('kirby.poyo', { at: [x, z], oomph: speed });
        }
    }
    // Held by the mouse (fast + off the ground + cursor close).
    const dCursor = Math.hypot(world.cursor.wx - x, world.cursor.wz - z);
    if (dCursor < 0.6 && world.cursor.l) heldUntil = world.time + 0.15;

    // -- mode select ---------------------------------------------------------
    if (world.time < heldUntil) mode = 'held';
    else if (world.time < tumbleUntil) mode = 'tumble';
    else if (swordThreat > 0) mode = 'flee';
    else if (wisp && Math.hypot(wisp.b.pos[0] - x, wisp.b.pos[2] - z) < 4.0) mode = 'chase';
    else mode = 'wander';

    // -- act -----------------------------------------------------------------
    let ax = 0;
    let wantRun = false;
    if (mode === 'flee' && sword) {
        ax = Math.sign(x - sword.b.pos[0]) * 5.0;
        wantRun = true;
        if (grounded && world.time - lastHopT > 0.5 && swordThreat >= 1) {
            ball.impulse([Math.sign(ax) * 0.5, 0, 1.6]);
            lastHopT = world.time;
        }
    } else if (mode === 'chase' && wisp) {
        const dx = wisp.b.pos[0] - x;
        if (Math.abs(dx) > 0.5) ax = Math.sign(dx) * 2.6;
        // pounce when close and the wisp sits still
        const wSpeed = Math.hypot(wisp.b.vel[0], wisp.b.vel[2]);
        if (Math.abs(dx) < 1.2 && wSpeed < 1 && grounded && world.time - lastHopT > 1.2) {
            ball.impulse([Math.sign(dx) * 1.2, 0, 1.8]);
            lastHopT = world.time;
        }
    } else if (mode === 'wander') {
        // keep polite distance from the swordfighter, drift around home
        if (pelvis && Math.abs(pelvis.b.pos[0] - x) < 1.2) {
            wanderTarget = x + Math.sign(x - pelvis.b.pos[0]) * 2.0;
        } else if (modeT % 6 < dt) {
            wanderTarget = HOME_X + (Math.random() * 6 - 3);
        }
        const dx = wanderTarget - x;
        if (Math.abs(dx) > 0.3) ax = Math.sign(dx) * 1.4;
        // hop onto low platforms occasionally
        if (grounded && Math.random() < dt * 0.08) {
            ball.impulse([0, 0, 1.5]);
            lastHopT = world.time;
        }
    }
    if (ax !== 0) {
        const maxSpd = wantRun ? 3.4 : 1.7;
        if (Math.sign(ax) * vx < maxSpd) ball.force([ax * 0.35, 0, 0]);
        facing = Math.sign(ax);
    }

    // keep on screen
    const halfW = buddy.screen.wPx / 2 / buddy.screen.ppm;
    if (Math.abs(x) > halfW - 0.5) ball.force([-Math.sign(x) * 3, 0, 0]);

    // -- pick animation -------------------------------------------------------
    if (mode === 'held') setAnim('inhale');
    else if (mode === 'tumble') setAnim('tumble');
    else if (!grounded && world.time - lastGround > 0.15) setAnim('jump');
    else if (speed > 2.2) setAnim('run');
    else if (speed > 0.4) setAnim('walk');
    else if (mode === 'chase' && wisp && Math.hypot(wisp.b.pos[0]-x, wisp.b.pos[2]-z) < 1.0) setAnim('inhale');
    else setAnim('idle');

    tickAnim(dt);
});

function supportHeight(colliders, x, z) {
    let best = 0;
    for (const c of colliders) {
        if (c.id.startsWith('sys/wall')) continue;
        const top = c.cz + c.hz;
        if (x >= c.cx - c.hx && x <= c.cx + c.hx && top <= z && top > best) best = top;
    }
    return best;
}

buddy.log('kirby online, poyo');
