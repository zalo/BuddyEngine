// Interactive Buddy — a BuddyEngine port of the 2005 Shock Value / Eric Gurt
// Flash toy. Six-circle soft-spring ragdoll with the original constants
// (damp 0.225, slow 0.8, 35px rigid clamp, rotated rest pose), the emotion
// scalar, the cash-for-abuse economy, petting/tickling, knockouts, and the
// priority action queue — living on your desktop in the shared PhysX world.
//
// Ported from the decompiled game per SYSTEMS.md (frame_25/DoAction.as).
// Original units are px @36fps; V converts px/frame -> m/s.

export const meta = {
    name: 'Interactive Buddy',
    author: 'shiftmaker',
    version: '1',
    description: 'The classic gray ragdoll buddy: pet him, tickle him, throw him, knock him out. He remembers how you treat him.',
};

const buddy = await Buddy.ready();
const DEBUG = false; // set true to log a state heartbeat every ~5s
buddy.log('interactive buddy booting, instance', buddy.id);

// ---------------------------------------------------------------------------
// Units & constants (original game px @ 36 fps)
// ---------------------------------------------------------------------------
const FPS = 36, DT = 1 / FPS;
const SIZE = 1.35;                       // visual scale multiplier
const S = SIZE / buddy.screen.ppm;       // meters per game-px
const V = FPS * S;                       // (px/frame) -> (m/s)

const DAMP = 0.225;                      // spring gain
const SLOW = 0.8;                        // limb velocity damping per frame
const RIGID_CLAMP = 35;                  // px, max limb distance from rest point

// Part table: rest offset from torso (px, y-down like the original), mass,
// restitution, radius, spring constant K.
const PART_DEFS = {
    body: { off: [0, 0],           m: 1.0,  bounce: 0.5, rad: 25   },
    head: { off: [0, -39.2],       m: 0.2,  bounce: 0.2, rad: 13.5, k: 2.5 },
    lArm: { off: [-22.15, -10],    m: 0.1,  bounce: 0.4, rad: 10,   k: 1.5 },
    rArm: { off: [22.15, -10],     m: 0.1,  bounce: 0.4, rad: 10,   k: 1.5 },
    lLeg: { off: [-15.1, 32.15],   m: 0.15, bounce: 0.4, rad: 10,   k: 0.5 },
    rLeg: { off: [15.05, 32.15],   m: 0.15, bounce: 0.4, rad: 10,   k: 0.5 },
};
const LIMBS = ['head', 'lArm', 'rArm', 'lLeg', 'rLeg'];
const PART_NAMES = ['body', ...LIMBS];
// Polar form of the rest offsets (rotated by bodyRot each step, like initPhysics).
for (const p of Object.values(PART_DEFS)) {
    p.d = Math.hypot(p.off[0], p.off[1]);
    p.r = Math.atan2(p.off[1], p.off[0]);
}

// ---------------------------------------------------------------------------
// Physics bodies (shared world; 'world' filter = collide with windows/ground/
// avatars but never with our own overlapping parts — the original's shared
// "buddy" collision group)
// ---------------------------------------------------------------------------
const handles = {};

function spawnPart(name, pos) {
    const d = PART_DEFS[name];
    handles[name] = buddy.phys.spawn(name, {
        shape: { type: 'sphere', r: d.rad * S },
        pos,
        mass: d.m,
        friction: 0.55,
        restitution: d.bounce,
        planar2D: true,
        angularDamping: 0.9,
        collides: 'world',
        // The mouse is the fist: body/head/legs take cursor hits like the
        // original; arms stay cosmetic (non-colliding, they reach when petting).
        collidesCursor: name !== 'lArm' && name !== 'rArm',
    });
}

function spawnParts() {
    const groundZ = 0;
    const x0 = 1.2, z0 = groundZ + (32.15 + 12) * S + 0.35;
    for (const name of PART_NAMES) {
        const d = PART_DEFS[name];
        spawnPart(name, [x0 + d.off[0] * S, 0, z0 - d.off[1] * S]);
    }
}
spawnParts();

// ---------------------------------------------------------------------------
// Visuals: gray shaded spheres (per the original default skin) + face +
// speech bubble + cash tag + floating "$" particles.
// ---------------------------------------------------------------------------
buddy.gfx.material('skin', { type: 'standard', params: { color: 0xc4c9c0, roughness: 0.45, metalness: 0.1 } });
for (const name of PART_NAMES) {
    const d = PART_DEFS[name];
    buddy.gfx.geometry('geo_' + name, { type: 'sphere', params: { r: d.rad * S } });
    buddy.gfx.mesh('mesh_' + name, { geo: 'geo_' + name, mat: 'skin' }).attach(name);
}

// --- face (canvas sprite riding the head; camera sits on -Y) ---
const faceCanvas = new OffscreenCanvas(128, 128);
const faceCtx = faceCanvas.getContext('2d');
let faceKey = '';

function drawFace(mode /* normal|ko|sleep|scared */, blink, mouth /* -10..10 */) {
    const key = mode + '|' + blink + '|' + mouth;
    if (key === faceKey) return;
    faceKey = key;
    const c = faceCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, 128, 128);
    c.setTransform(1, 0, 0, -1, 0, 128); // pre-flip: ImageBitmap textures ignore flipY
    c.strokeStyle = c.fillStyle = '#2a2d28';
    c.lineWidth = 5;
    c.lineCap = 'round';
    const eyeY = 52, eyeX = [42, 86];
    if (mode === 'ko') {
        for (const x of eyeX) { // X eyes
            c.beginPath();
            c.moveTo(x - 8, eyeY - 8); c.lineTo(x + 8, eyeY + 8);
            c.moveTo(x + 8, eyeY - 8); c.lineTo(x - 8, eyeY + 8);
            c.stroke();
        }
    } else if (mode === 'sleep' || blink) {
        for (const x of eyeX) {
            c.beginPath(); c.moveTo(x - 8, eyeY); c.lineTo(x + 8, eyeY); c.stroke();
        }
    } else if (mode === 'scared') {
        for (const x of eyeX) { // wide eyes: hollow rings
            c.beginPath(); c.arc(x, eyeY, 9, 0, Math.PI * 2); c.stroke();
        }
    } else {
        for (const x of eyeX) {
            c.beginPath(); c.arc(x, eyeY, 7, 0, Math.PI * 2); c.fill();
        }
    }
    if (mode === 'scared' || mode === 'ko') {
        // little round "oh no" mouth
        c.beginPath(); c.arc(64, 92, mode === 'ko' ? 6 : 9, 0, Math.PI * 2); c.stroke();
    } else if (mode === 'sleep') {
        c.beginPath(); c.moveTo(52, 90); c.lineTo(76, 90); c.stroke();
    } else {
        // 20-step smile<->frown gradient, faceClip-style
        const curve = mouth / 10; // -1..1, positive = smile (U)
        c.beginPath();
        c.moveTo(40, 88 - curve * 8);
        c.quadraticCurveTo(64, 88 + curve * 16, 88, 88 - curve * 8);
        c.stroke();
    }
    buddy.publishCanvas('texFace', faceCanvas);
}
drawFace('normal', 0, 0);
buddy.gfx.material('matFace', { type: 'sprite', params: { map: 'texFace', transparent: true } });
// Offset purely along -Y (the spin axis): immune to hit-induced head spin.
buddy.gfx.sprite('face', { mat: 'matFace', scale: [26 * S, 26 * S, 1] })
    .attach('head', [0, -PART_DEFS.head.rad * S - 0.03, 0]);

// --- speech bubble ---
const bubCanvas = new OffscreenCanvas(512, 176);
const bubCtx = bubCanvas.getContext('2d');
let bubText = null, bubUntil = -1;

function drawBubble(text) {
    const c = bubCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, 512, 176);
    c.setTransform(1, 0, 0, -1, 0, 176); // pre-flip: ImageBitmap textures ignore flipY
    c.font = 'bold 40px "Comic Sans MS", sans-serif';
    const w = Math.min(480, Math.max(120, c.measureText(text).width + 56));
    const x0 = 8, y0 = 8, h = 116, rr = 26;
    c.fillStyle = '#f4f4f0';
    c.strokeStyle = '#5a5d58';
    c.lineWidth = 5;
    c.beginPath();
    c.roundRect(x0, y0, w, h, rr);
    c.fill(); c.stroke();
    // tail toward lower-left (the head)
    c.beginPath();
    c.moveTo(x0 + 34, y0 + h - 3);
    c.lineTo(x0 + 16, y0 + h + 44);
    c.lineTo(x0 + 72, y0 + h - 3);
    c.closePath();
    c.fillStyle = '#f4f4f0';
    c.fill();
    c.stroke();
    c.fillStyle = '#f4f4f0';
    c.fillRect(x0 + 36, y0 + h - 6, 34, 8); // hide the seam
    c.fillStyle = '#2a2d28';
    c.fillText(text, x0 + 28, y0 + 74);
    buddy.publishCanvas('texBubble', bubCanvas);
}
drawBubble('...');
buddy.gfx.material('matBubble', { type: 'sprite', params: { map: 'texBubble', transparent: true } });
// Not attached: attach offsets rotate with the body when he's struck, which
// sends the bubble orbiting. Positioned manually each step instead.
const bubbleNode = buddy.gfx.sprite('bubble', { mat: 'matBubble', scale: [170 * S, 58 * S, 1] });
bubbleNode.set({ visible: false });

// --- cash tag ---
const cashCanvas = new OffscreenCanvas(256, 64);
const cashCtx = cashCanvas.getContext('2d');
let cashShown = '';

function drawCash(str) {
    if (str === cashShown) return;
    cashShown = str;
    const c = cashCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, 256, 64);
    c.setTransform(1, 0, 0, -1, 0, 64); // pre-flip: ImageBitmap textures ignore flipY
    c.font = 'bold 44px Verdana, sans-serif';
    c.strokeStyle = '#1c3d1c';
    c.lineWidth = 7;
    c.fillStyle = '#7ddb7d';
    c.strokeText(str, 8, 48);
    c.fillText(str, 8, 48);
    buddy.publishCanvas('texCash', cashCanvas);
}
drawCash('$0');
buddy.gfx.material('matCash', { type: 'sprite', params: { map: 'texCash', transparent: true } });
const cashNode = buddy.gfx.sprite('cashtag', { mat: 'matCash', scale: [78 * S, 19.5 * S, 1] });
cashNode.set({ visible: false });

// --- floating "$" particles (fixed pool) ---
const dolCanvas = new OffscreenCanvas(64, 64);
{
    const c = dolCanvas.getContext('2d');
    c.setTransform(1, 0, 0, -1, 0, 64); // pre-flip: ImageBitmap textures ignore flipY
    c.font = 'bold 54px Verdana, sans-serif';
    c.strokeStyle = '#1c3d1c'; c.lineWidth = 6;
    c.fillStyle = '#7ddb7d';
    c.strokeText('$', 17, 52);
    c.fillText('$', 17, 52);
    buddy.publishCanvas('texDollar', dolCanvas);
}
const DOLLARS = 8;
const dollars = [];
for (let i = 0; i < DOLLARS; i++) {
    buddy.gfx.material('matDol' + i, { type: 'sprite', params: { map: 'texDollar', transparent: true, opacity: 1 } });
    const node = buddy.gfx.sprite('dol' + i, { mat: 'matDol' + i, scale: [0.1, 0.1, 1] });
    node.set({ visible: false });
    dollars.push({ node, life: 0, x: 0, z: 0, size: 0.1 });
}
let dolNext = 0;

function spawnDollar(x, z, amt) {
    const d = dollars[dolNext];
    dolNext = (dolNext + 1) % DOLLARS;
    d.life = 34;
    d.x = x + (Math.random() - 0.5) * 0.15;
    d.z = z + 0.1;
    d.size = (14 + Math.min(amt, 20) * 1.6) * S;
    d.node.set({ visible: true, pos: [d.x, -0.08, d.z], scale: [d.size, d.size, 1], matParams: { opacity: 1 } });
}

function tickDollars() {
    for (const d of dollars) {
        if (d.life <= 0) continue;
        d.life--;
        d.z += 1.6 * S;
        if (d.life === 0) d.node.set({ visible: false });
        else d.node.set({ pos: [d.x, -0.08, d.z], matParams: { opacity: Math.min(1, d.life / 20) } });
    }
}

// --- knockout stars ("stars circle the head" while out, per the original) ---
const starCanvas = new OffscreenCanvas(64, 64);
{
    const c = starCanvas.getContext('2d');
    c.setTransform(1, 0, 0, -1, 0, 64); // pre-flip: ImageBitmap textures ignore flipY
    c.translate(32, 32);
    c.beginPath();
    for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 26 : 11;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        c[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
    c.closePath();
    c.fillStyle = '#a8ada6';
    c.strokeStyle = '#5a5d58';
    c.lineWidth = 4;
    c.fill(); c.stroke();
    buddy.publishCanvas('texStar', starCanvas);
}
const STARS = 3;
const stars = [];
for (let i = 0; i < STARS; i++) {
    buddy.gfx.material('matStar' + i, { type: 'sprite', params: { map: 'texStar', transparent: true } });
    const node = buddy.gfx.sprite('star' + i, { mat: 'matStar' + i, scale: [0.08, 0.08, 1] });
    node.set({ visible: false });
    stars.push(node);
}
let starsShown = false;

function tickStars(headPos, out) {
    if (!out) {
        if (starsShown) { starsShown = false; for (const s of stars) s.set({ visible: false }); }
        return;
    }
    starsShown = true;
    for (let i = 0; i < STARS; i++) {
        const a = tick * 0.16 + i * (Math.PI * 2 / STARS);
        const size = (9 + 2.5 * Math.sin(tick * 0.3 + i * 2)) * S;
        stars[i].set({
            visible: true,
            pos: [headPos[0] + Math.cos(a) * 24 * S, -0.09,
                  headPos[2] + 18 * S + Math.sin(a) * 9 * S],
            scale: [size, size, 1],
        });
    }
}

// ---------------------------------------------------------------------------
// Speech (per-category cooldowns, like initSayings/say)
// ---------------------------------------------------------------------------
const SAYINGS = {
    idle:    ["I'm bored.", '*whistles*', 'So... nice weather?', '*yawn*', 'Hm hm hm~',
              'Do you ever blink?', "It's quiet... too quiet.", "What's a 'taskbar'?",
              'I live here now.', 'I can see your cursor from here.'],
    happy:   ['I feel great!', 'Best day ever!', "You're the best!", 'La la la~',
              'I could do this all day!', 'You and me, pal!', 'Today rules.'],
    sad:     ['Leave me alone...', 'Why me...', '*sigh*', "I've had better days.",
              "It's fine. Everything's fine.", '*stares into the distance*',
              'Nobody pets me anymore.'],
    scared:  ['AAAH!', 'Please stop!', 'Ow ow ow!', 'What did I do?!', 'Not again!',
              'MY SPLEEN!', 'Why though?!', 'I bruise easily!'],
    help:    ['A little help here?', "I'm stuck!", 'Hello? Anyone?'],
    thanks:  ['Thanks!', "You're alright.", 'Much obliged!', 'That feels nice.',
              'More please!', 'Heh. I needed that.'],
    tickle:  ['Hehehe!', 'S-stop it! Haha!', '*giggles*', 'NOT THE RIBS—'],
    grab:    ['Hey, put me down!', 'Whoa!', 'H-hey!', 'Airborne again?!',
              'Where are we going?'],
    thrown:  ['WAAAAH!', 'NOT AGAIN!', 'TELL MY STORY!'],
    flip:    ['Wheee!', 'Watch this!', 'Ta-daa!'],
    greet:   ['...'],
    wake:    ['Huh? Wha—?', "I wasn't sleeping!", '*snort* ...morning already?'],
    koWake:  ['Ugh... what happened?', '*sees stars*', 'Who am I? Who are YOU?',
              'Five more minutes...'],
    sleep:   ['Zzz...', 'Zzz... mmh... money...', '*snore*'],
    dance:   ['*busts a move*', '♪ ~ ♪', 'Dance break!'],
    wave:    ['Hi there!', 'Hello!', 'Hey! Over here!'],
    sneeze:  ['*ACHOO!*', '*achoo!* ...excuse me.'],
    wary:    ["Don't hurt me!", "We're cool, right?", '*flinches*'],
    forgive: ['...Okay. I forgive you.', "We're good now. No more throwing, deal?"],
    social:  ['Nice sword.', 'Hey, careful with that thing.', "We're buddies, right?"],
    visit:   ['Hey little guy!', '*pokes it*', 'Are you a lamp?'],
};
const SAY_COOLDOWN = {
    idle: 700, happy: 500, sad: 500, scared: 300, help: 400,
    thanks: 260, tickle: 150, grab: 250, thrown: 200, flip: 400, greet: 0,
    wake: 200, koWake: 200, sleep: 420, dance: 400, wave: 500, sneeze: 300,
    wary: 350, forgive: 600, social: 900, visit: 700,
};
const sayNext = {};

function say(cat, textOverride) {
    if (tick < (sayNext[cat] || 0)) return;
    sayNext[cat] = tick + SAY_COOLDOWN[cat];
    const lines = SAYINGS[cat];
    const text = textOverride || lines[Math.floor(Math.random() * lines.length)];
    if (text === bubText) { bubUntil = tick + 90; return; }
    bubText = text;
    bubUntil = tick + Math.min(140, 50 + text.length * 3);
    drawBubble(text);
    bubbleNode.set({ visible: true });
}

// ---------------------------------------------------------------------------
// Economy + emotion (addCash 1874 / addEmotion 287)
// ---------------------------------------------------------------------------
let cash = 0;
let cashFlashUntil = -1;

function addCash(amt, x, z) {
    if (amt <= 0) return;
    cash += amt;
    cashFlashUntil = tick + 110;
    if (amt >= 0.5 && x !== undefined) spawnDollar(x, z, amt);
}

const EMOTION_SCALE = 0.65;
let emotion = 0;
let emotionTick = -1;   // one application per frame (emotionFrame latch)

function addEmotion(x) {
    if (!awake() || emotionTick === tick) return;
    emotionTick = tick;
    emotion = Math.max(-100, Math.min(100, emotion + x * EMOTION_SCALE));
}

// ---------------------------------------------------------------------------
// Modifier + priority action queue (initQueue 3932)
// ---------------------------------------------------------------------------
let modifier = 'normal', modifierLeft = 0;

function setModifier(name, frames) { modifier = name; modifierLeft = frames; }
function awake() { return modifier !== 'out'; }

const queue = Array.from({ length: 9 }, () => []);

function putAction(pri, verb, arg, budget) {
    for (const a of queue[pri]) {
        if (a.verb === verb) { a.budget = Math.max(a.budget, budget); a.arg = arg; return; }
    }
    queue[pri].push({ verb, arg, budget });
}

function currentAction() {
    for (let p = 8; p >= 0; p--) {
        while (queue[p].length) {
            const a = queue[p][0];
            if (a.budget > 0) return a;
            queue[p].shift();
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Sim state
// ---------------------------------------------------------------------------
let tick = 0;
let acc = 0;
let bodyRot = 0, rv = 0;
let grabbed = null;            // part name currently held by the host grab
let onGround = false;
let stuckTimer = 0;
let idleTimer = 0;
let idleThreshold = 200 + Math.random() * 200;
let petTimer = 0, petting = false;
let noMoreThrows = false;      // trust-loss latch after a hard throw (grenade-style)
let petSinceThrow = 0;         // pet steps since the throw; enough of them earns forgiveness
let sinceInteraction = 0;      // steps since the user touched him (sleep timer)
let lastSocial = -9999;        // last time he socialized with another buddy
let grabbedLoose = 0;          // steps the "grabbed" flag survived with no button held
const farTimer = {};           // steps each limb has spent far outside the clamp
let flipState = null;          // {rot0, airborne}

// Any direct interaction: resets both the idle-personality and sleep timers.
function poke() { idleTimer = 0; sinceInteraction = 0; }
const hitTimer = { head: 0, body: 0 };
const vSet = {};               // part -> [vx, vz] commanded last step (m/s)
let lastCursor = { wx: 0, wz: 0, px: 0, py: 0 };
let cursorSpeed = 0;           // px/frame equivalent
let cursorMovedAt = 0;
let saidGreeting = false;

buddy.bus.on('sys.reset', () => {
    spawnParts();
    bodyRot = 0; rv = 0;
    setModifier('normal', 0);
    for (const q of queue) q.length = 0;
});

buddy.bus.on('wisp.startled', () => {
    if (awake() && modifier === 'normal') say('visit', 'Oops— sorry, little guy!');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function partState(world, name) {
    return world.bodies.get(buddy.id + '/' + name);
}

// Highest static surface under (x, z) — window tops, icons, ground.
function supportZAt(colliders, x, z) {
    let best = 0;
    for (const c of colliders) {
        if (c.id.startsWith('sys/wall')) continue;
        const top = c.cz + c.hz;
        if (x >= c.cx - c.hx && x <= c.cx + c.hx && top <= z + 0.02 && top > best) best = top;
    }
    return best;
}

function restTarget(name, bodyPos) {
    const d = PART_DEFS[name];
    const gx = d.d * Math.cos(d.r + bodyRot);
    const gy = d.d * Math.sin(d.r + bodyRot);
    return [bodyPos[0] + gx * S, bodyPos[2] - gy * S];
}

// ---------------------------------------------------------------------------
// The 36Hz step — doBodyPhysics + doAI + parseAction, ported
// ---------------------------------------------------------------------------
function step(world) {
    tick++;
    sinceInteraction++;
    if (modifierLeft > 0 && --modifierLeft === 0) {
        const was = modifier;
        setModifier('normal', 0);
        if (was === 'out') say('koWake');
    }
    if (hitTimer.head > 0) hitTimer.head--;
    if (hitTimer.body > 0) hitTimer.body--;

    const parts = {};
    for (const name of PART_NAMES) {
        const st = partState(world, name);
        if (!st) return; // not all spawned yet
        parts[name] = st;
    }
    const body = parts.body;

    // --- cursor bookkeeping ---
    const cdx = (world.cursor.wx - lastCursor.wx) / V, cdz = (world.cursor.wz - lastCursor.wz) / V;
    cursorSpeed = Math.hypot(cdx, cdz);
    if (cursorSpeed > 0.5) cursorMovedAt = tick;
    lastCursor = { wx: world.cursor.wx, wz: world.cursor.wz, px: world.cursor.px, py: world.cursor.py };

    // --- pointer events: host grab/throw ---
    for (const ev of world.events) {
        const id = ev.id.includes('/') ? ev.id.split('/').pop() : ev.id;
        if (ev.type === 'pointerdown' && PART_NAMES.includes(id)) {
            grabbed = id;
            poke();
            if (modifier === 'asleep') { setModifier('normal', 0); say('wake'); }
            if (awake()) {
                addEmotion(-0.5);
                if (emotion > 40) say('flip'); else say('grab');
            }
        } else if (ev.type === 'pointerup' && grabbed) {
            const g = parts[grabbed];
            const spd = Math.hypot(g.vel[0], g.vel[2]) / V;
            if (spd > 18 && awake()) { say('thrown'); setModifier('scared', 120); noMoreThrows = true; }
            grabbed = null;
        }
    }
    // Grab watchdog: if no mouse button is down, the host can't be holding
    // anything — a missed pointerup would otherwise leave the part unsteered
    // forever (it drifts off as a free body and drags the torso after it).
    if (grabbed && !world.cursor.l && !world.cursor.r) {
        if (++grabbedLoose > 3) {
            const g = parts[grabbed];
            const spd = Math.hypot(g.vel[0], g.vel[2]) / V;
            if (spd > 18 && awake()) { say('thrown'); setModifier('scared', 120); noMoreThrows = true; }
            grabbed = null;
            grabbedLoose = 0;
        }
    } else {
        grabbedLoose = 0;
    }

    // --- ground test (leg near a support or the floor) ---
    onGround = false;
    for (const leg of ['lLeg', 'rLeg']) {
        const p = parts[leg];
        const sup = supportZAt(world.colliders, p.pos[0], p.pos[2] - PART_DEFS[leg].rad * S);
        if (p.pos[2] - PART_DEFS[leg].rad * S - sup < 10 * S) { onGround = true; break; }
    }

    // --- hit detection: compare actual velocity to what we commanded ---
    // (collisions from thrown objects, the sword buddy, wall slams)
    for (const name of ['head', 'body']) {
        if (grabbed === name || !(name in vSet)) continue;
        const p = parts[name];
        const exp = vSet[name];
        const dvx = p.vel[0] - exp[0];
        const dvz = p.vel[2] - (exp[1] - 9.81 * DT);
        const vpf = Math.hypot(dvx, dvz) / V; // px/frame equivalent
        // Cursor adjacent to the part -> this was a mouse punch: the fist pays
        // its own (much smaller) table and knocks out only past speed 80.
        const dCur = Math.hypot(world.cursor.wx - p.pos[0], world.cursor.wz - p.pos[2]) / S;
        const punch = dCur < PART_DEFS[name].rad + 30;
        if (name === 'head' && vpf > (punch ? 20 : 18) && hitTimer.head === 0) {
            hitTimer.head = 60;
            if (punch) {
                addCash(Math.min(vpf * 0.002, 0.5), p.pos[0], p.pos[2]);
                addEmotion(-Math.min(vpf * 0.002, 0.5));
            } else {
                addCash(Math.min(Math.max(vpf * 0.02, 3), 10), p.pos[0], p.pos[2]);
                addEmotion(Math.max(Math.min(-vpf * 0.05, -2), -8));
            }
            rv += Math.max(-0.35, Math.min(0.35, (dvx / V) * 0.006));
            poke();
            const koThreshold = punch ? 55 : 30;
            if (vpf > koThreshold && awake()) { setModifier('out', 300); bubUntil = -1; bubbleNode.set({ visible: false }); }
            else { setModifier('scared', 90); say('scared'); }
        } else if (name === 'body' && vpf > (punch ? 25 : 7) && hitTimer.body === 0) {
            hitTimer.body = 60;
            if (punch) {
                addCash(Math.min(vpf * 0.002, 0.5), p.pos[0], p.pos[2]);
                addEmotion(-Math.min(vpf * 0.002, 0.35));
            } else {
                addCash(Math.min(vpf * 0.02, 2), p.pos[0], p.pos[2]);
                addEmotion(Math.max(Math.min(-vpf * 0.05, -2), -6));
            }
            poke();
            if (vpf > (punch ? 30 : 14)) { setModifier('scared', 70); say('scared'); }
        }
    }

    // --- petting & tickling (Open Hand / Tickle items folded into the cursor) ---
    const head = parts.head;
    const dHead = Math.hypot(world.cursor.wx - head.pos[0], world.cursor.wz - head.pos[2]) / S;
    const dBody = Math.hypot(world.cursor.wx - body.pos[0], world.cursor.wz - body.pos[2]) / S;
    petting = false;
    if (!grabbed && awake() && !world.cursor.l && !world.cursor.r) {
        if (dHead < 45 && cursorSpeed < 3) {
            petting = true;
            petTimer++;
            if (petTimer % 3 === 0) { addCash(0.075); addEmotion(0.15); }
            if (petTimer % 320 === 300) say('thanks');
            poke();
            // trust rebuild: enough petting after a hard throw earns forgiveness
            if (noMoreThrows && ++petSinceThrow > 500) {
                noMoreThrows = false;
                petSinceThrow = 0;
                say('forgive');
                addEmotion(2);
            }
        } else if (dBody < 40 && cursorSpeed > 8) {
            addCash(0.075);
            addEmotion(0.05);
            say('tickle');
            // body wiggles violently near the cursor
            for (const limb of ['lArm', 'rArm', 'lLeg', 'rLeg']) {
                parts[limb].vel[0] += (Math.random() - 0.5) * 4 * V;
                parts[limb].vel[2] += (Math.random() - 0.5) * 3 * V;
            }
            poke();
        } else {
            petTimer = 0;
        }
    } else {
        petTimer = 0;
    }

    // --- flavor states: sleep, wariness after a throw, random sneezes ---
    let flavorJump = 0;
    if (modifier === 'asleep') {
        // gentle pets don't wake him; grabs, clicks and fast waving nearby do
        if (grabbed || (Math.min(dHead, dBody) < 90 && (cursorSpeed > 4 || world.cursor.l))) {
            setModifier('normal', 0);
            say('wake');
            poke();
        } else {
            say('sleep'); // cooldown-gated "Zzz..."
        }
    } else if (awake() && modifier === 'normal') {
        if (sinceInteraction > 3200 && tick - cursorMovedAt > 600) {
            setModifier('asleep', 1e9);
            say('sleep');
        }
        if (noMoreThrows && dHead < 160 && cursorSpeed > 14) {
            setModifier('scared', 50);
            say('wary');
        }
        if (Math.random() < 1 / 4500) {
            say('sneeze');
            if (onGround) flavorJump = 4;
        }
    }

    // --- emotion decay + body rotation ---
    emotion *= 0.99995;
    rv *= 0.96 - (onGround ? 0.1 : 0);
    if (awake() && onGround) bodyRot *= 0.9;
    if (!awake() && onGround) {
        const target = (bodyRot >= 0 ? 1 : -1) * Math.PI / 2; // slump over
        bodyRot += (target - bodyRot) * 0.06;
    }
    bodyRot += rv;
    if (bodyRot > Math.PI) bodyRot -= 2 * Math.PI;
    if (bodyRot < -Math.PI) bodyRot += 2 * Math.PI;

    // --- AI: modifier reactions, stuck detection, idle personality ---
    if (awake() && modifier !== 'asleep') {
        if (modifier === 'scared') putAction(7, 'runFromMouse', 0, 20);
        if (Math.abs(bodyRot) > 2.4) stuckTimer++; else stuckTimer = 0;
        if (stuckTimer > 15 && onGround) { putAction(8, 'getUnStuck', 0, 40); say('help'); }
        // curiosity: wander toward a recently-moving cursor
        if (modifier === 'normal' && emotion > -80 && tick - cursorMovedAt < 90 && !petting) {
            const dx = Math.abs(world.cursor.wx - body.pos[0]) / S;
            if (dx > 90 && dx < 600) putAction(3, 'walkToMouse', 0, 12);
        }
        // socializing: wave at a nearby humanoid, or go visit a small stray
        // body (the wisp's ball, thrown things) that shares the desktop
        if (modifier === 'normal' && emotion > -40 &&
            tick - lastSocial > 1800 && tick % 300 === 0) {
            for (const [id, b] of world.bodies) {
                if (id.startsWith(buddy.id + '/') || id.startsWith('sys/')) continue;
                const dist = Math.hypot(b.pos[0] - body.pos[0], b.pos[2] - body.pos[2]) / S;
                if (id.endsWith('.pelvis') && dist < 320) {
                    lastSocial = tick;
                    putAction(2, 'wave', 0, 55);
                    say('social');
                    break;
                }
                if (!id.includes('.') && dist > 120 && dist < 700) {
                    lastSocial = tick;
                    putAction(2, 'visit', id, 160);
                    break;
                }
            }
        }
        idleTimer++;
        if (idleTimer > idleThreshold) {
            idleTimer = 0;
            idleThreshold = 200 + Math.random() * 200;
            idleAction();
        }
    }

    // --- execute the single highest-priority action ---
    const walkImpulse = { body: 0, gait: 0, jump: 0 };
    let armReach = null;   // {name, tx, tz, k}: overrides one arm's spring target
    let dancing = false;
    if (petting) {
        const arm = world.cursor.wx < body.pos[0] ? 'lArm' : 'rArm';
        armReach = { name: arm, tx: world.cursor.wx, tz: world.cursor.wz, k: 2.0 };
    }
    const act = awake() && modifier !== 'asleep' ? currentAction() : null;
    if (act) {
        act.budget--;
        switch (act.verb) {
            case 'walkToMouse': {
                const dx = world.cursor.wx - body.pos[0];
                if (Math.abs(dx) / S < 70) act.budget = 0;
                else { walkImpulse.body = Math.sign(dx) * 3; walkImpulse.gait = 1; }
                break;
            }
            case 'runFromMouse': {
                const dir = Math.sign(body.pos[0] - world.cursor.wx) || 1;
                walkImpulse.body = dir * 5; walkImpulse.gait = 1.6;
                if (onGround && Math.random() < 0.03) walkImpulse.jump = 6;
                break;
            }
            case 'getUnStuck': {
                if (onGround) walkImpulse.jump = 7;
                rv -= Math.sign(bodyRot) * 0.05;
                if (Math.abs(bodyRot) < 0.4) { act.budget = 0; stuckTimer = 0; }
                break;
            }
            case 'wave': {
                const dir = Math.sign(world.cursor.wx - body.pos[0]) || 1;
                const arm = dir < 0 ? 'lArm' : 'rArm';
                const [rx, rz] = restTarget(arm, body.pos);
                armReach = {
                    name: arm,
                    tx: rx + dir * 12 * S,
                    tz: rz + (34 + Math.sin(tick * 0.55) * 10) * S,
                    k: 2.2,
                };
                break;
            }
            case 'dance': {
                dancing = true;
                if (onGround && tick % 16 === 0) walkImpulse.jump = 3;
                break;
            }
            case 'visit': {
                const tb = world.bodies.get(act.arg);
                if (!tb) { act.budget = 0; break; }
                const dx = (tb.pos[0] - body.pos[0]) / S;
                if (Math.abs(dx) < 85) {
                    say('visit');
                    addEmotion(1.5);
                    act.budget = 0;
                } else {
                    walkImpulse.body = Math.sign(dx) * 3;
                    walkImpulse.gait = 1;
                }
                break;
            }
            case 'walkToPoint': {
                const dx = act.arg - body.pos[0];
                if (Math.abs(dx) / S < 40) act.budget = 0;
                else { walkImpulse.body = Math.sign(dx) * 3; walkImpulse.gait = 1; }
                break;
            }
            case 'flip': {
                if (!flipState && onGround) {
                    walkImpulse.jump = 11;
                    rv += (Math.random() < 0.5 ? 1 : -1) * 0.32;
                    flipState = { spun: 0 };
                    say('flip');
                }
                if (flipState) {
                    flipState.spun += Math.abs(rv);
                    if (onGround && flipState.spun > 3.5) {
                        addCash(15, body.pos[0], body.pos[2] + 0.3);
                        flipState = null; act.budget = 0;
                    } else if (onGround && flipState.spun <= 3.5 && act.budget < 30) {
                        flipState = null; act.budget = 0; // landed without spinning
                    }
                }
                break;
            }
        }
    }
    if (flavorJump) walkImpulse.jump = Math.max(walkImpulse.jump, flavorJump);

    // --- ragdoll solve (doBodyPhysics 7141) ---
    const newV = {};
    const gaitPhase = tick * (0.3 + 0.15 * (walkImpulse.gait > 1 ? 1 : 0));
    for (const name of LIMBS) {
        const d = PART_DEFS[name];
        const p = parts[name];
        const [tx, tz] = restTarget(name, body.pos);
        // Escape recovery: a limb flung past a window edge can't be pulled
        // back through the collider — snap it home instead of tug-of-warring.
        if (name !== grabbed) {
            const away = Math.hypot(p.pos[0] - tx, p.pos[2] - tz) / S;
            farTimer[name] = away > 120 ? (farTimer[name] || 0) + 1 : 0;
            if (away > 300 || farTimer[name] > 45) {
                farTimer[name] = 0;
                spawnPart(name, [tx, 0, tz]);
                vSet[name] = [0, 0];
                continue;
            }
        }
        // spring toward rotated rest point; PhysX supplies gravity between sets
        let vx = p.vel[0] + (tx - p.pos[0]) * DAMP * d.k * FPS;
        let vz = p.vel[2] + (tz - p.pos[2]) * DAMP * d.k * FPS;
        vx *= SLOW; vz *= SLOW;
        // walking gait: sinusoidal leg pumping (walk 4567)
        if (walkImpulse.gait > 0) {
            const ph = name === 'lLeg' ? gaitPhase : gaitPhase + Math.PI;
            if (name === 'lLeg' || name === 'rLeg') {
                vx += Math.sin(ph) * 2.4 * walkImpulse.gait * Math.sign(walkImpulse.body || 1) * V;
                vz += Math.max(0, Math.cos(ph)) * 2.0 * walkImpulse.gait * V;
            }
        }
        // arm override: petting reach (grabMouse-lite) or waving hello
        if (armReach && name === armReach.name) {
            vx = p.vel[0] + (armReach.tx - p.pos[0]) * DAMP * armReach.k * FPS;
            vz = p.vel[2] + (armReach.tz - p.pos[2]) * DAMP * armReach.k * FPS;
            vx *= SLOW; vz *= SLOW;
        }
        // dancing: arms pump on the beat
        if (dancing && (name === 'lArm' || name === 'rArm')) {
            vz += Math.sin(tick * 0.4 + (name === 'lArm' ? 0 : Math.PI)) * 2.6 * V;
        }
        // scared: arms and head tremble
        if (modifier === 'scared' && name !== 'lLeg' && name !== 'rLeg') {
            vx += (Math.random() - 0.5) * 1.6 * V;
            vz += (Math.random() - 0.5) * 1.2 * V;
        }
        // rigid clamp: never further than 35px from the rest point
        const ex = p.pos[0] - tx, ez = p.pos[2] - tz;
        const dist = Math.hypot(ex, ez);
        const maxD = RIGID_CLAMP * S;
        if (dist > maxD) {
            const over = (dist - maxD) / dist;
            vx -= ex * over * FPS * 0.5;
            vz -= ez * over * FPS * 0.5;
        }
        if (walkImpulse.jump && onGround) vz += walkImpulse.jump * (name.endsWith('Leg') ? 1.25 : 1) * V;
        newV[name] = [vx, vz];
    }

    // torso: weighted pull toward where the limbs say it should be
    {
        let ix = 0, iz = 0, sw = 0;
        const weights = { head: 2, lArm: 1, rArm: 1, lLeg: onGround ? 3 : 2, rLeg: onGround ? 3 : 2 };
        for (const name of LIMBS) {
            const d = PART_DEFS[name];
            const gx = d.d * Math.cos(d.r + bodyRot);
            const gy = d.d * Math.sin(d.r + bodyRot);
            const w = weights[name];
            // Cap each limb's pull so one runaway part can't drag the torso off.
            let cx = parts[name].pos[0] - gx * S;
            let cz = parts[name].pos[2] + gy * S;
            const ddx = cx - body.pos[0], ddz = cz - body.pos[2];
            const dd = Math.hypot(ddx, ddz);
            const lim = 60 * S;
            if (dd > lim) { cx = body.pos[0] + ddx / dd * lim; cz = body.pos[2] + ddz / dd * lim; }
            ix += cx * w;
            iz += cz * w;
            sw += w;
        }
        ix /= sw; iz /= sw;
        let vx = body.vel[0] + (ix - body.pos[0]) * DAMP * 1.75 * FPS;
        let vz = body.vel[2] + (iz - body.pos[2]) * DAMP * 1.75 * FPS;
        vx += walkImpulse.body * V;
        const cap = 12 * V;
        vx = Math.max(-cap, Math.min(cap, vx));
        if (walkImpulse.jump && onGround) vz += walkImpulse.jump * V;
        newV.body = [vx, vz];
    }

    // apply (skip whatever the user is holding — the host grab spring owns it)
    for (const name of PART_NAMES) {
        if (name === grabbed) { vSet[name] = [parts[name].vel[0], parts[name].vel[2]]; continue; }
        if (!newV[name]) continue; // limb respawned this step; vSet already zeroed
        handles[name].velocity([newV[name][0], 0, newV[name][1]]);
        vSet[name] = newV[name];
    }

    // --- presentation ---
    const faceMode = !awake() ? 'ko'
        : modifier === 'asleep' ? 'sleep'
        : modifier === 'scared' ? 'scared' : 'normal';
    const blink = faceMode === 'normal' && Math.floor(tick / 2) % 80 === 0 ? 1 : 0;
    drawFace(faceMode, blink, Math.round(Math.max(-100, Math.min(100, emotion)) / 10));
    tickStars(head.pos, !awake());

    if (bubUntil >= 0 && tick > bubUntil) { bubUntil = -1; bubText = null; bubbleNode.set({ visible: false }); }
    if (bubUntil >= 0) {
        bubbleNode.set({ pos: [head.pos[0] + 62 * S, -0.06, head.pos[2] + 52 * S] });
    }
    drawCash('$' + Math.floor(cash));
    const cashVisible = tick < cashFlashUntil;
    cashNode.set(cashVisible
        ? { visible: true, pos: [body.pos[0], -0.06, body.pos[2] + 92 * S] }
        : { visible: false });

    tickDollars();

    if (!saidGreeting && tick > 30) { saidGreeting = true; say('greet'); }

    if (DEBUG && tick % 180 === 0) {
        buddy.log(`t=${tick} body=(${body.pos[0].toFixed(2)},${body.pos[2].toFixed(2)})` +
            ` head=(${parts.head.pos[0].toFixed(2)},${parts.head.pos[2].toFixed(2)})` +
            ` rot=${bodyRot.toFixed(2)} ground=${onGround} mod=${modifier}` +
            ` emo=${emotion.toFixed(1)} cash=${cash.toFixed(2)} act=${act ? act.verb : '-'}`);
    }
}

// idleAction 3661: emotion bands drive personality when left alone
function idleAction() {
    const e = emotion;
    const r = Math.random();
    const halfW = buddy.screen.wPx / 2 / buddy.screen.ppm;
    if (e >= 80) {
        if (r < 0.5) say('happy');
        else if (r < 0.68) putAction(4, 'flip', 0, 60);
        else if (r < 0.86) { putAction(2, 'dance', 0, 140); say('dance'); }
        else {
            const gift = Math.floor(50 + Math.random() * 51);
            addCash(gift);
            say('happy', 'Here, take this! +$' + gift);
        }
    } else if (e <= -80) {
        say('sad');
    } else {
        const p = Math.abs(e) / 100;
        if (r < p * 0.7) say(e > 0 ? 'happy' : 'sad');
        else if (e > 30 && r < 0.3) putAction(4, 'flip', 0, 60);
        else if (e > 20 && r < 0.45) { putAction(2, 'dance', 0, 120); say('dance'); }
        else if (r < 0.6) { putAction(2, 'wave', 0, 50); say('wave'); }
        else if (r < 0.8) putAction(1, 'walkToPoint', (Math.random() * 2 - 1) * (halfW - 1), 220);
        else say('idle');
    }
}

// ---------------------------------------------------------------------------
// Frame pump: fixed 36Hz steps from the host frame stream
// ---------------------------------------------------------------------------
buddy.onFrame((world) => {
    acc = Math.min(acc + world.dt, DT * 2);
    if (acc >= DT) {
        acc -= DT;
        step(world);
    }
});

buddy.log('interactive buddy online');
