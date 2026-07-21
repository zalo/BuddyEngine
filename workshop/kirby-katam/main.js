// Kirby (KatAM) — the authentic buddy-Kirby from Kirby & The Amazing Mirror.
//
// Brain and body are the game's own decompiled code compiled to WASM
// (kirby-katam.wasm; sources in katam/buddy/): the CPU-buddy AI synthesizes
// GBA button words, the movement/animation state machine consumes them.
// All instances in this cell share ONE sim world (gKirbys slots 1..3, like
// the game's yellow/red/green buddies; a 4th+ instance starts another world).
// The leader (slot 0) is your cursor. Desktop colliders become the game's
// tile map; wisps become "items" the AI's target-acquisition code chases;
// fast-moving sword links deal contact damage; grab a Kirby to carry him,
// fling to see the game's tumble/bounce chain.

export const meta = {
    name: 'Kirby (KatAM)',
    author: 'BuddyEngine',
    version: '2',
    description: "Kirby & The Amazing Mirror's real buddy AI + movement state machine (decomp → WASM). Follows your cursor, flies, brawls, noms wisps, takes damage. Sprites/logic: Nintendo/HAL (katam decomp).",
};

const buddy = await Buddy.ready();
buddy.log('kirby-katam cell online BUILD 2026-07-21b (powers+enemies+sfx)');

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const META = await buddy.assets.json('kirby-sprites.json');
const WASM_BYTES = await buddy.assets.bytes('kirby-katam.wasm');

const sheetBmps = {};
async function sheetFor(color) {
    if (!sheetBmps[color]) {
        const bytes = await buddy.assets.bytes(`kirby-sprites-${color}.png`);
        sheetBmps[color] = await createImageBitmap(new Blob([bytes]));
    }
    return sheetBmps[color];
}

const M_PER_PX = 0.55 / 24; // one game pixel on screen; Kirby is ~24px tall

// foreign bodies the AI treats as chase/inhale targets ("items"): the wisp
// pack names its body 'ball' (fqid like 'b2/ball')
const TARGET_RE = /\bwisp|\/ball\b/;

// in-world enemy spawn mix (kind ids from enemies.c): waddle dee
// walker/hopper/parasol(13), bronto bouncer (5) & stalker (6), sword
// knight (7), waddle doo (10, beam), sir kibble (11, cutter), hot head
// (12, fire). Kinds 8/9/14/15/16 are stars & projectiles — sim-spawned.
let ENEMY_KINDS = [0, 2, 5, 6, 7, 10, 11, 12, 13];

const texCache = new Map();
const texPending = new Set();
let texCount = 0;
// Synchronous lookup for the render hot path: NEVER await inside onFrame —
// awaited node.set calls can apply out of order across host frames (a slow
// cache-miss frame lands after a fast cache-hit one and steps the animation
// backwards). On a miss we start the async publish and render the previous
// frame for one more tick.
function frameTexSync(color, fi) {
    const key = color + ':' + fi;
    const hit = texCache.get(key);
    if (hit) return hit;
    if (!texPending.has(key)) {
        texPending.add(key);
        frameTex(color, fi).finally(() => texPending.delete(key));
    }
    return null;
}
async function frameTex(color, fi) {
    const key = color + ':' + fi;
    if (texCache.has(key)) return texCache.get(key);
    const f = META.frames[fi];
    const sheet = await sheetFor(color);
    const c = new OffscreenCanvas(f.w, f.h);
    c.getContext('2d').drawImage(sheet, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    const id = 'kf' + (texCount++);
    buddy.publishCanvas(id, c, { nearest: true });
    const out = { id, w: f.w, h: f.h, ox: f.ox, oy: f.oy };
    texCache.set(key, out);
    return out;
}

// ---------------------------------------------------------------------------
// Coordinate mapping (meters, Z-up  <->  game px, y-down)
// ---------------------------------------------------------------------------

const scr = buddy.screen;
const halfWm = scr.wPx / 2 / scr.ppm;
const skyM = (scr.hPx ? scr.hPx : 2160) / scr.ppm;
const ROOM_W = Math.min(65000, Math.ceil((2 * halfWm) / M_PER_PX));
// Ground surface sits INSIDE the room with a margin below it: the AI's 5x5
// terrain grid must read the floor as SOLID tiles, not "outside the room"
// (0xFF), or it never believes ground is near and just keeps flying.
// Snapped to the 16px tile grid: collision is tile-granular, so a mid-tile
// ground line would make Kirby stand on the tile top, floating up to 15px
// above the visual floor (the taskbar).
const GROUND_Y_PX = Math.ceil(skyM / M_PER_PX / 16) * 16;
const ROOM_H = Math.min(65000, GROUND_Y_PX + 128);
const toPxX = (wx) => (wx + halfWm) / M_PER_PX;
const toPxY = (wz) => GROUND_Y_PX - wz / M_PER_PX;
const toWx = (px) => px * M_PER_PX - halfWm;
const toWz = (py) => (GROUND_Y_PX - py) * M_PER_PX;
const clampPx = (v, hi) => Math.max(0, Math.min(hi - 1, Math.round(v)));
// snap world meters to device pixels: keeps nearest-filtered texels stable
// without quantizing motion to whole game pixels (which reads as jerky)
const snapM = (v) => Math.round(v * scr.ppm) / scr.ppm;

// ---------------------------------------------------------------------------
// Shared sim worlds: one module hosts up to 3 buddies (slots 1..3)
// ---------------------------------------------------------------------------

const simPool = [];

async function makeSim() {
    const wasi = { proc_exit() {}, fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 };
    const { instance } = await WebAssembly.instantiate(WASM_BYTES.slice(0), {
        wasi_snapshot_preview1: wasi,
        env: { emscripten_notify_memory_growth() {} },
    });
    const S = instance.exports;
    if (S._initialize) S._initialize();
    S.kb_init((Math.random() * 0xFFFF) | 1, ROOM_W, ROOM_H);
    // feed the game's real animation script durations (summed per anim) so
    // the sim's anim-finished timing matches what we render exactly
    if (S.kb_set_anim_dur) {
        const feed = (ability, table) => {
            for (const [idx, a] of Object.entries(table)) {
                const total = a.seq.reduce((s, st) => s + st.dur, 0);
                if (total > 0) S.kb_set_anim_dur(ability, Number(idx), total);
            }
        };
        feed(0, META.anims);
        if (META.abilities) for (const [ab, t] of Object.entries(META.abilities)) feed(Number(ab), t);
        if (META.mouthful) feed(0x80, META.mouthful); // mouthful overlay row
    }
    return {
        S,
        slotOwner: [null, null, null, null], // iid per slot
        master: null,                        // iid that ticks this world
        acc: 0, lastTicks: 0,
        colliderSig: '',
        lastCx: 0, lastCz: 0, haveCursor: false,
    };
}

async function claimSlot(iid) {
    for (const ctl of simPool) {
        for (let s = 1; s <= 3; s++) {
            if (ctl.slotOwner[s] === null) { ctl.slotOwner[s] = iid; return { ctl, slot: s }; }
        }
    }
    const ctl = await makeSim();
    simPool.push(ctl);
    ctl.slotOwner[1] = iid;
    return { ctl, slot: 1 };
}

// Master duties, once per host frame per world: world inputs + fixed-step tick.
function masterTick(ctl, world) {
    const S = ctl.S;

    const sig = world.colliders.map(k => `${k.id}:${k.cx.toFixed(2)},${k.cz.toFixed(2)},${k.hx.toFixed(2)},${k.hz.toFixed(2)}`).join('|');
    if (sig !== ctl.colliderSig) {
        ctl.colliderSig = sig;
        if (!ctl.loggedColliders) {
            ctl.loggedColliders = true;
            buddy.log('colliders: ' + world.colliders.map(k => `${k.id}@${k.cx.toFixed(1)},${k.cz.toFixed(1)}±${k.hx.toFixed(1)},${k.hz.toFixed(1)}`).join(' '));
        }
        S.kb_reset_boxes();
        for (const k of world.colliders) {
            // front/back walls bound the DEPTH axis (y) — rasterizing them
            // into the 2D tile plane would mark the whole room solid.
            if (/wall_front|wall_back/.test(k.id)) continue;
            const x0 = toPxX(k.cx - k.hx), x1 = toPxX(k.cx + k.hx);
            let y0 = toPxY(k.cz + k.hz);
            let y1 = toPxY(k.cz - k.hz);
            const semi = /win:|icon:/.test(k.id) ? 1 : 0;
            // Tile-align platform tops so feet rest on the visual edge (the
            // game's collision is 16px-tile granular and snaps to tile tops),
            // and keep thin bars at least one tile thick so they don't vanish.
            if (semi) {
                y0 = Math.round(y0 / 16) * 16;
                y1 = Math.max(y1, y0 + 16);
            }
            S.kb_add_box(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), semi);
        }
    }

    // cursor = leader (slot 0)
    const cx = world.cursor.wx, cz = Math.max(0, world.cursor.wz);
    const vxPx = ctl.haveCursor ? (cx - ctl.lastCx) / M_PER_PX / Math.max(world.dt * 60, 1e-3) : 0;
    const vzPx = ctl.haveCursor ? (cz - ctl.lastCz) / M_PER_PX / Math.max(world.dt * 60, 1e-3) : 0;
    ctl.haveCursor = true;
    // clamp the leader to just above the ground surface — a target below the
    // floor is unreachable and keeps the AI hovering forever
    S.kb_leader(clampPx(toPxX(cx), ROOM_W), clampPx(Math.min(toPxY(cz), GROUND_Y_PX - 8), ROOM_H),
        Math.round(vxPx * 256), Math.round(-vzPx * 256),
        cz < 0.25 ? 1 : 0, vxPx < -0.5 ? 1 : 0);
    ctl.lastCx = cx; ctl.lastCz = cz;

    // items/targets for the AI's acquisition lists: wisps (kind 1, nommable)
    // and swordfighter pelvises (kind 2, nom = copy the sword ability).
    // Swordfighter rigs are recognized by having an '<prefix>.sword' link.
    const swordPrefixes = new Set();
    for (const id of world.bodies.keys()) {
        if (id.endsWith('.sword') && !id.startsWith(buddy.id + '/'))
            swordPrefixes.add(id.slice(0, -'.sword'.length));
    }
    ctl.targets = [];
    for (const [id, b] of world.bodies) {
        if (id.startsWith(buddy.id + '/')) continue;
        if (TARGET_RE.test(id))
            ctl.targets.push({ id, wx: b.pos[0], wz: b.pos[2], kind: 1 });
        else if (id.endsWith('.pelvis') && swordPrefixes.has(id.slice(0, -'.pelvis'.length)))
            ctl.targets.push({ id, wx: b.pos[0], wz: b.pos[2], kind: 2 });
    }
    // enemy population maintenance (in-world Waddle Dees)
    if (S.kb_spawn_enemy) {
        let alive = 0;
        const n = S.kb_enemy_count();
        for (let i = 0; i < n; i++) if (S.kb_enemy_alive(i)) alive++;
        if (alive < opts.enemies && world.time - (ctl.lastEnemySpawn || 0) > 1.5) {
            ctl.lastEnemySpawn = world.time;
            const kind = ENEMY_KINDS[(Math.random() * ENEMY_KINDS.length) | 0];
            S.kb_spawn_enemy(kind, 40 + Math.round(Math.random() * (ROOM_W - 80)), GROUND_Y_PX - 64);
        }
        // in-world enemies also feed the buddies' acquisition lists (kind 3)
        for (let i = 0; i < n; i++) {
            if (S.kb_enemy_alive(i) !== 1 || S.kb_enemy_hp(i) <= 0) continue;
            const tk = S.kb_enemy_kind ? S.kb_enemy_kind(i) : 0;
            if (tk === 9 || tk >= 14) continue; // projectiles aren't prey
            const ex = S.kb_enemy_x(i) / 256, ey = S.kb_enemy_y(i) / 256;
            ctl.targets.push({ id: 'sim-enemy-' + i, wx: toWx(ex), wz: toWz(ey), kind: 3, slot: i });
        }
    }
    if (S.kb_reset_targets) {
        S.kb_reset_targets();
        for (const t of ctl.targets)
            S.kb_add_target(clampPx(toPxX(t.wx), ROOM_W), clampPx(toPxY(t.wz), ROOM_H), t.kind);
    }

    // drain queued sound effects (sim pushes at the game's PlaySfx sites).
    // NOTE: wasm i32 returns arrive SIGNED in JS — coerce with >>> 0 or the
    // 0xFFFFFFFF empty sentinel never matches and this loop spins forever.
    if (S.kb_sfx_pop) {
        let se, guard = 32;
        while ((se = S.kb_sfx_pop() >>> 0) !== 0xFFFFFFFF && guard-- > 0) playSe(se);
    }

    ctl.acc += world.dt;
    let steps = 0;
    while (ctl.acc >= 1 / 60 && steps < 4) {
        // snapshot poses before the last tick for inter-tick interpolation
        ctl.prevK = ctl.prevK || {};
        ctl.prevE = ctl.prevE || {};
        for (let s = 1; s <= 3; s++) ctl.prevK[s] = [S.kb_x(s), S.kb_y(s)];
        if (S.kb_enemy_count) {
            const n = S.kb_enemy_count();
            for (let i = 0; i < n; i++) ctl.prevE[i] = [S.kb_enemy_x(i), S.kb_enemy_y(i)];
        }
        S.kb_tick(); ctl.acc -= 1 / 60; steps++;
    }
    ctl.lastTicks = steps;
    ctl.alpha = Math.min(ctl.acc * 60, 1);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const opts = { color: -1, enemies: 2, sounds: false };

// SFX playback: dumped SE audio (sfx/manifest.json), gated by the option
let sfxManifest = null, sfxCtx = null;
const sfxBuffers = new Map();
try { sfxManifest = await buddy.assets.json('sfx/manifest.json'); } catch (e) { /* no sfx dump yet */ }
async function playSe(seId) {
    if (!opts.sounds || !sfxManifest) return;
    const entry = sfxManifest[String(seId)];
    if (!entry) return;
    if (!sfxCtx) sfxCtx = new AudioContext();
    let buf = sfxBuffers.get(seId);
    if (buf === undefined) {
        sfxBuffers.set(seId, null); // fetch once
        const bytes = await buddy.assets.bytes('sfx/' + entry.file);
        buf = await sfxCtx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        sfxBuffers.set(seId, buf);
    }
    if (!buf) return; // fetch in flight
    const src = sfxCtx.createBufferSource();
    src.buffer = buf;
    src.connect(sfxCtx.destination);
    src.start();
}
buddy.options({
    color: {
        label: 'Color', type: 'select', value: -1,
        choices: [
            { value: -1, label: 'Buddy (yellow/red/green)' },
            { value: 0, label: 'Pink' }, { value: 1, label: 'Yellow' },
            { value: 2, label: 'Red' }, { value: 3, label: 'Green' },
        ],
    },
    enemies: { label: 'Enemies', type: 'range', value: 2, min: 0, max: 6, step: 1 },
    sounds: { label: 'Sound effects', type: 'checkbox', value: false },
}, (key, value) => { opts[key] = Number(value); });

// cross-pack combat: other packs can broadcast katam.hit to damage us
const pendingHits = [];
buddy.bus.on('katam.hit', (data) => { if (data && data.at) pendingHits.push(data); });

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

Buddy.instances(async (inst) => {
    const { ctl, slot } = await claimSlot(inst.iid);
    const S = ctl.S;
    if (ctl.master === null) ctl.master = inst.iid;

    const myColor = () => (opts.color >= 0 ? opts.color : slot - 1); // first = pink, then yellow/red like the game
    let color = myColor();

    const sx = inst.spawn.x !== undefined ? inst.spawn.x : -2 + slot * 1.2;
    const sz = inst.spawn.z !== undefined ? inst.spawn.z : 1.2;
    S.kb_spawn(slot, color, clampPx(toPxX(sx), ROOM_W), clampPx(toPxY(sz), ROOM_H));

    const R = 0.18;
    const body = inst.phys.spawn('body', {
        shape: { type: 'sphere', r: R },
        pos: [sx, 0, sz],
        kinematic: true,
        planar2D: true,
    });

    const firstFrame = (META.anims['0'] || Object.values(META.anims)[0]).seq[0].frame;
    const bootTex = await frameTex(color, firstFrame);

    inst.gfx.geometry('quad', { type: 'plane', params: { w: 1, h: 1 } });
    inst.gfx.material('sprite', {
        type: 'shader',
        transparent: true,
        depthWrite: false,
        uniforms: { uTex: bootTex.id, uFlipX: 0, uFlipYTex: 0, uWhite: 0 },
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
            uniform float uFlipYTex;
            uniform float uWhite;
            void main() {
                float vy = uFlipYTex > 0.5 ? vUv.y : 1.0 - vUv.y;
                vec2 uv = vec2(uFlipX > 0.5 ? 1.0 - vUv.x : vUv.x, vy);
                vec4 c = texture2D(uTex, uv);
                if (c.a < 0.05) discard;
                gl_FragColor = vec4(mix(c.rgb, vec3(1.0), uWhite), c.a);
            }`,
    });
    const node = inst.gfx.mesh('sprite', { geo: 'quad', mat: 'sprite' });

    // Overlay layers (ability composites, e.g. Sword Kirby's green cap and
    // blade/swing-arc). Own materials: matParams mutate the material, so
    // sharing one across nodes would sync their textures.
    const overlayNodes = {};
    for (const [layer, depth] of [['hat', -0.012], ['weapon', -0.014]]) {
        inst.gfx.material('m_' + layer, {
            type: 'shader', transparent: true, depthWrite: false,
            uniforms: { uTex: bootTex.id, uFlipX: 0, uFlipYTex: 0, uWhite: 0 },
            vertexShader: `
                varying vec2 vUv;
                void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform sampler2D uTex; uniform float uFlipX; uniform float uFlipYTex; uniform float uWhite;
                void main() {
                    float vy = uFlipYTex > 0.5 ? vUv.y : 1.0 - vUv.y;
                    vec2 uv = vec2(uFlipX > 0.5 ? 1.0 - vUv.x : vUv.x, vy);
                    vec4 c = texture2D(uTex, uv);
                    if (c.a < 0.05) discard;
                    gl_FragColor = vec4(mix(c.rgb, vec3(1.0), uWhite), c.a);
                }`,
        });
        const n = inst.gfx.mesh('n_' + layer, { geo: 'quad', mat: 'm_' + layer });
        overlayNodes[layer] = { node: n, depth, key: '', seqIdx: 0, tickAcc: 0, visible: false };
    }

    // animation playback
    // Anim layer precedence: mouthful (flags&0x80, stuffed sprites) →
    // ability (e.g. sword hat + slashes) → base.
    function animFor(animIndex, ability, mouthful) {
        if (mouthful && META.mouthful) {
            const m = META.mouthful[String(animIndex)];
            if (m) return m;
        }
        const layer = META.abilities && META.abilities[String(ability)];
        return (layer && layer[String(animIndex)]) || META.anims[String(animIndex)];
    }
    let curAnim = -1, curAbility = -1, curMouthful = false, seqIdx = 0, tickAcc = 0;
    function animStep(animIndex, ability, mouthful, restart, ticks) {
        const a = animFor(animIndex, ability, mouthful);
        if (!a) return animFor(curAnim, curAbility, curMouthful) ? curAnim : 0;
        if (animIndex !== curAnim || ability !== curAbility || mouthful !== curMouthful) {
            curAnim = animIndex; curAbility = ability; curMouthful = mouthful;
            seqIdx = 0; tickAcc = 0;
        }
        tickAcc += ticks;
        let guard = a.seq.length * 8;
        while (tickAcc >= a.seq[seqIdx].dur && guard-- > 0) {
            tickAcc -= a.seq[seqIdx].dur;
            if (seqIdx + 1 < a.seq.length) { seqIdx++; continue; }
            // End of script: freeze on the last frame unless the state wants
            // a loop (game flags&4) or the script itself loops — restarting
            // one-shots (sword swings) reads as frames out of order.
            if (a.loop || restart) { seqIdx = 0; continue; }
            tickAcc = 0; break;
        }
        if (guard <= 0) tickAcc = 0;
        return curAnim;
    }

    // grab / damage state
    let held = false;
    const cursTrail = []; // recent cursor world positions for throw velocity
    let lastHurtAt = -10;
    let hurtFlash = 0;
    let nomTimer = 0;
    let lastCopyAt = -10; // transform cooldown: the game's transform hold
                          // briefly reads ability=NORMAL, so gate re-noms
    let lastNomAt = -10;
    let prevAnimIdx = -1;
    let lastBodyT = null;
    let funnelNode = null, funnelOn = false, funnelBlink = 0;
    let mfLogT = -10;
    let dbgT = -10;
    const INHALE_ANIMS = new Set([26, 27, 106, 107]);
    const SLASH_SET = new Set([52, 53, 54, 66, 104, 106, 107, 108, 109, 110, 111, 112]);
    const enemyVis = new Map(); // master-only: slot -> {body, node, key, seqIdx, tickAcc}
    const impactCd = new Map(); // "<srcId>|<victim>" -> time
    let lastBusHitT = 0;

    // fast foreign dynamic bodies deal contact damage (thrown toys, sword
    // links, flung buddies from other packs)
    function scanImpacts(world, victims) {
        for (const [id, b] of world.bodies) {
            if (id.startsWith(buddy.id + '/')) continue;
            const speed = Math.hypot(b.vel[0], b.vel[2]);
            if (speed < 3) continue;
            for (const v of victims) {
                const dx = b.pos[0] - v.x, dz = b.pos[2] - v.z;
                if (dx * dx + dz * dz > 0.33 * 0.33) continue;
                const k = id + '|' + v.key;
                if (world.time - (impactCd.get(k) || -9) < 0.7) continue;
                impactCd.set(k, world.time);
                v.hurt(b.pos[0] < v.x ? 1 : 0);
            }
        }
        for (const h of pendingHits) {
            if (h.src === buddy.id || h.t <= lastBusHitT) continue;
            for (const v of victims) {
                const dx = h.at[0] - v.x, dz = h.at[1] - v.z;
                const r = h.r || 0.5;
                if (dx * dx + dz * dz < r * r) v.hurt(h.at[0] < v.x ? 1 : 0);
            }
        }
    }

    inst.onFrame(async (world) => {
        const c = myColor();
        if (c !== color) { color = c; }

        if (ctl.master === inst.iid) masterTick(ctl, world);

        // grab: pointer events on our body. IMPORTANT: once the sim is told
        // held=1 it stays pinned until it gets a held=0 call — every path out
        // of the held state must go through releaseNow().
        cursTrail.push({ x: world.cursor.wx, z: Math.max(0, world.cursor.wz), t: world.time });
        while (cursTrail.length > 6) cursTrail.shift();
        const releaseNow = () => {
            held = false;
            const last = cursTrail[cursTrail.length - 1];
            const first = cursTrail[0];
            const dt = Math.max(last.t - first.t, 1 / 120);
            const vx = (last.x - first.x) / dt / M_PER_PX / 60;
            const vz = (last.z - first.z) / dt / M_PER_PX / 60;
            S.kb_place(slot, clampPx(toPxX(last.x), ROOM_W), clampPx(toPxY(last.z), ROOM_H),
                Math.round(vx * 256), Math.round(-vz * 256), 0);
        };
        for (const ev of world.events) {
            if (ev.id !== inst.bodyId('body')) continue;
            if (ev.type === 'pointerdown') held = true;
            if (ev.type === 'pointerup' && held) releaseNow();
        }
        if (held) {
            if (world.cursor.l === false && cursTrail.length >= 2) {
                releaseNow();
            } else {
                const last = cursTrail[cursTrail.length - 1];
                S.kb_place(slot, clampPx(toPxX(last.x), ROOM_W), clampPx(toPxY(last.z), ROOM_H), 0, 0, 1);
            }
        }

        // pose out
        const gx = S.kb_x(slot) / 256, gy = S.kb_y(slot) / 256;
        const wx = toWx(gx), wz = toWz(gy);
        const facingLeft = S.kb_facing(slot) === 1;
        body.kinematicTarget([wx, 0, Math.max(wz + R, R)], [0, 0, 0, 1]);

        const myAbility = S.kb_ability ? S.kb_ability(slot) : 0;

        // impact damage: fast foreign bodies (incl. sword links) + bus hits
        if (!held)
            scanImpacts(world, [{ x: wx, z: wz + 0.2, key: 'k' + slot, hurt: (fl) => S.kb_hurt(slot, fl) }]);

        // broadcast our sword swings so other packs can react (our own
        // in-world enemies take slash damage inside the sim already)
        if (myAbility === 18) {
            const ai = S.kb_anim(slot);
            if (SLASH_SET.has(ai) && !SLASH_SET.has(prevAnimIdx)) {
                buddy.bus.broadcast('katam.hit', {
                    t: world.time, src: buddy.id, dmg: 1, r: 0.55,
                    at: [wx + (facingLeft ? -0.35 : 0.35), wz + 0.15],
                });
            }
            prevAnimIdx = ai;
        } else prevAnimIdx = -1;

        // nom: the AI approaches and holds B (inhale) from up to 48px out; in
        // the game suction pulls the item in. Foreign bodies can't be pulled,
        // so B-held near a target for 0.5s counts as swallowed. Only normal
        // Kirby can inhale — an ability Kirby's B is an attack, not a nom.
        let nearTarget = null;
        if (myAbility === 0 && (S.kb_buttons(slot) & 2) && ctl.targets) {
            let best = Infinity;
            for (const t of ctl.targets) {
                // ability-granting targets (kind 2, e.g. the swordfighter)
                // are always worth eating and beat any snack in range;
                // snacks respect the 4s digestion break
                const grants = t.kind === 2;
                if (!grants && world.time - lastNomAt < 2) continue;
                // in-world enemies are handled by the sim's authentic
                // suction -> mouthful pipeline, not the JS nom shim
                if (t.kind === 3) continue;
                const range = 48 * M_PER_PX;
                const dx = t.wx - wx, dz = t.wz - (wz + 0.15);
                const d2 = dx * dx + dz * dz;
                if (d2 > range * range) continue;
                const score = d2 - (grants ? 1e6 : 0);
                if (score < best) { best = score; nearTarget = t; }
            }
        }
        nomTimer = nearTarget ? nomTimer + world.dt : 0;
        const nomHold = nearTarget && nearTarget.kind === 3 ? 0.9 : 0.5;

        // events from the sim
        const ev = S.kb_events(slot);
        if ((ev & 1 && myAbility === 0 && world.time - lastNomAt > 2) || nomTimer > nomHold) {
            lastNomAt = world.time;
            nomTimer = 0;
            if (nearTarget && nearTarget.kind === 2 && S.kb_set_ability && world.time - lastCopyAt > 2.5) {
                lastCopyAt = world.time;
                // swallowed the swordfighter: copy the sword ability!
                S.kb_set_ability(slot, 18); // KIRBY_ABILITY_SWORD
                hurtFlash = 1; // white transform flash
                buddy.log(`kirby ${slot} nommed the swordfighter -> SWORD ability`);
                buddy.bus.broadcast('kirby.copy', { ability: 'sword', at: [wx, wz], by: inst.iid });
            } else if (nearTarget && nearTarget.kind === 3) {
                // swallowed an in-world enemy: some grant a copy ability
                // (e.g. Sword Knight -> SWORD), the rest are just a snack
                const grantAb = S.kb_enemy_ability ? S.kb_enemy_ability(nearTarget.slot) : 0;
                S.kb_enemy_despawn(nearTarget.slot);
                if (grantAb && S.kb_set_ability && world.time - lastCopyAt > 2.5) {
                    lastCopyAt = world.time;
                    S.kb_set_ability(slot, grantAb);
                    hurtFlash = 1;
                    buddy.log(`kirby ${slot} swallowed an enemy -> ability ${grantAb}`);
                    buddy.bus.broadcast('kirby.copy', { ability: grantAb, at: [wx, wz], by: inst.iid });
                } else {
                    S.kb_heal(slot, 1);
                    buddy.log(`kirby ${slot} nommed an enemy`);
                    buddy.bus.broadcast('kirby.nom', { at: [wx, wz], by: inst.iid });
                }
            } else {
                S.kb_heal(slot, 1);
                buddy.bus.broadcast('kirby.nom', { at: [wx, wz], by: inst.iid });
                buddy.bus.broadcast('wisp.startled', { at: [wx, wz] });
            }
        }
        if (ev & 2) { hurtFlash = 1; buddy.log(`kirby ${slot} hurt (hp=${S.kb_hp(slot)})`); }
        if (ev & 0x10) buddy.log(`kirby ${slot} caught something in his mouth`);
        if (ev & 0x20) { hurtFlash = 0.6; buddy.log(`kirby ${slot} swallowed it (ability=${S.kb_ability ? S.kb_ability(slot) : '?'})`); }
        if (ev & 0x40) buddy.log(`kirby ${slot} spat a star`);
        if (ev & 4) buddy.log(`kirby ${slot} respawned`);
        hurtFlash = Math.max(0, hurtFlash - world.dt * 4);

        // sprite
        const simFlags = S.kb_flags ? S.kb_flags(slot) : 0;
        const isMouthful = (simFlags & 0x80) !== 0;
        const animIndex = animStep(S.kb_anim(slot), myAbility, isMouthful, (simFlags & 4) !== 0, ctl.lastTicks);
        const a = animFor(animIndex, myAbility, isMouthful);
        if (a) {
            const st = a.seq[Math.min(seqIdx, a.seq.length - 1)];
            const t = frameTexSync(color, st.frame) || lastBodyT;
            if (t) lastBodyT = t;
            if (!t) return;
            // Facing-left mirrors the frame box around the origin; a step's
            // baked hflip mirrors pixels only. vflip (sub_081564D8): box top
            // = y - (h - offsetY), pixels mirrored vertically. The GBA draws
            // at integer pixels, so snap the box's top-left to the game-pixel
            // grid — otherwise crop-box changes between frames shimmer.
            const texFlip = facingLeft !== !!st.hflip;
            const boxLeft = gx + (facingLeft ? -(t.ox + t.w) : t.ox);
            const boxTop = gy + (st.vflip ? -(t.oy + t.h) : t.oy);
            const cxPx = boxLeft + t.w / 2;
            const czPy = boxTop + t.h / 2;
            node.set({
                pos: [snapM(toWx(cxPx)), -0.01, snapM(toWz(czPy))],
                quat: [0.7071, 0, 0, 0.7071],
                scale: [t.w * M_PER_PX, t.h * M_PER_PX, 1],
                matParams: { uTex: t.id, uFlipX: texFlip ? 1 : 0, uFlipYTex: st.vflip ? 1 : 0, uWhite: hurtFlash > 0 ? 0.7 : 0 },
                visible: true,
            });
        }

        // suction funnel: persistent blinking sprite while inhaling
        {
            const fla = META.objects && META.objects['19:0'];
            const inhaling = fla && INHALE_ANIMS.has(animIndex);
            funnelBlink += ctl.lastTicks;
            if (inhaling) {
                const ft = frameTexSync(color, fla.seq[0].frame);
                if (ft) {
                    if (!funnelNode) {
                        inst.gfx.material('funm', {
                            type: 'shader', transparent: true, depthWrite: false,
                            uniforms: { uTex: ft.id, uFlipX: 0 },
                            vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
                            fragmentShader: `varying vec2 vUv; uniform sampler2D uTex; uniform float uFlipX;
                                void main(){ vec2 uv=vec2(uFlipX>0.5?1.0-vUv.x:vUv.x,1.0-vUv.y); vec4 c=texture2D(uTex,uv);
                                if(c.a<0.05) discard; gl_FragColor=c; }`,
                        });
                        funnelNode = inst.gfx.mesh('funn', { geo: 'quad', mat: 'funm' });
                    }
                    const anchor = gx + (facingLeft ? -4 : 4);
                    const fLeft = anchor + (facingLeft ? -(ft.ox + ft.w) : ft.ox);
                    const fTop = gy + ft.oy;
                    funnelNode.set({
                        pos: [snapM(toWx(fLeft + ft.w / 2)), -0.006, snapM(toWz(fTop + ft.h / 2))],
                        quat: [0.7071, 0, 0, 0.7071],
                        scale: [ft.w * M_PER_PX, ft.h * M_PER_PX, 1],
                        matParams: { uTex: ft.id, uFlipX: facingLeft ? 1 : 0 },
                        visible: (funnelBlink & 1) === 0, // game blinks it every other frame
                    });
                    funnelOn = true;
                }
            } else if (funnelOn) { funnelNode.set({ visible: false }); funnelOn = false; }
        }

        // overlay layers (hat/weapon) run their own anim scripts keyed by the
        // same animationIndex; flips are baked in their pixels, so only the
        // facing (box mirror + texture mirror) applies.
        const layerSet = (META.overlays && META.overlays[String(myAbility)]) || null;
        for (const layer of ['hat', 'weapon']) {
            const ov = overlayNodes[layer];
            const la = layerSet && layerSet[layer] && layerSet[layer][String(animIndex)];
            if (!la) {
                if (ov.visible) { ov.node.set({ visible: false }); ov.visible = false; }
                continue;
            }
            const key = myAbility + ':' + animIndex;
            if (ov.key !== key) { ov.key = key; ov.seqIdx = 0; ov.tickAcc = 0; }
            ov.tickAcc += ctl.lastTicks;
            let ovGuard = la.seq.length * 8;
            while (ov.tickAcc >= la.seq[ov.seqIdx].dur && ovGuard-- > 0) {
                ov.tickAcc -= la.seq[ov.seqIdx].dur;
                if (ov.seqIdx + 1 < la.seq.length) { ov.seqIdx++; continue; }
                if (la.loop || (simFlags & 4)) { ov.seqIdx = 0; continue; }
                ov.tickAcc = 0; break;
            }
            if (ovGuard <= 0) ov.tickAcc = 0;
            const ost = la.seq[Math.min(ov.seqIdx, la.seq.length - 1)];
            const ot = frameTexSync(color, ost.frame) || ov.lastT;
            if (ot) ov.lastT = ot;
            if (!ot) continue;
            const oLeft = gx + (facingLeft ? -(ot.ox + ot.w) : ot.ox);
            const oTop = gy + ot.oy;
            ov.node.set({
                pos: [snapM(toWx(oLeft + ot.w / 2)), ov.depth, snapM(toWz(oTop + ot.h / 2))],
                quat: [0.7071, 0, 0, 0.7071],
                scale: [ot.w * M_PER_PX, ot.h * M_PER_PX, 1],
                matParams: { uTex: ot.id, uFlipX: facingLeft ? 1 : 0, uWhite: hurtFlash > 0 ? 0.7 : 0 },
                visible: true,
            });
            ov.visible = true;
        }

        // ---- master-only: enemy visuals, presence bodies, enemy impacts ----
        if (ctl.master === inst.iid && S.kb_enemy_count) {
            const n = S.kb_enemy_count();
            const victims = [];
            for (let i = 0; i < n; i++) {
                const isAlive = S.kb_enemy_alive(i) === 1;
                let vis = enemyVis.get(i);
                if (!isAlive) {
                    if (vis) {
                        vis.node.set({ visible: false }); vis.body.remove(); vis.node.remove();
                        if (vis.pNode) vis.pNode.remove();
                        enemyVis.delete(i);
                    }
                    continue;
                }
                const pe = (ctl.prevE && ctl.prevE[i]) || [S.kb_enemy_x(i), S.kb_enemy_y(i)];
                const eal = ctl.alpha !== undefined ? ctl.alpha : 1;
                const egx = (pe[0] + (S.kb_enemy_x(i) - pe[0]) * eal) / 256;
                const egy = (pe[1] + (S.kb_enemy_y(i) - pe[1]) * eal) / 256;
                const ex = toWx(egx), ez = toWz(egy);
                if (!vis) {
                    const b = inst.phys.spawn('en' + i, {
                        shape: { type: 'sphere', r: 0.13 }, pos: [ex, 0, ez + 0.13],
                        kinematic: true, planar2D: true,
                    });
                    inst.gfx.material('enm' + i, {
                        type: 'shader', transparent: true, depthWrite: false,
                        uniforms: { uTex: bootTex.id, uFlipX: 0, uFlipYTex: 0, uWhite: 0 },
                        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
                        fragmentShader: `varying vec2 vUv; uniform sampler2D uTex; uniform float uFlipX; uniform float uFlipYTex; uniform float uWhite;
                            void main(){ float vy=uFlipYTex>0.5?vUv.y:1.0-vUv.y; vec2 uv=vec2(uFlipX>0.5?1.0-vUv.x:vUv.x,vy); vec4 c=texture2D(uTex,uv);
                            if(c.a<0.05) discard; gl_FragColor=vec4(mix(c.rgb,vec3(1.0),uWhite),c.a); }`,
                    });
                    vis = { body: b, node: inst.gfx.mesh('enn' + i, { geo: 'quad', mat: 'enm' + i }), key: '', seqIdx: 0, tickAcc: 0, flash: 0 };
                    enemyVis.set(i, vis);
                }
                vis.body.kinematicTarget([ex, 0, Math.max(ez + 0.13, 0.13)], [0, 0, 0, 1]);
                const eev = S.kb_enemy_events(i);
                if (eev & 2) vis.flash = 1;
                vis.flash = Math.max(0, vis.flash - world.dt * 4);
                const ekind = S.kb_enemy_kind ? S.kb_enemy_kind(i) : 0;
                if (S.kb_enemy_hp(i) > 0 && ekind !== 8 && ekind !== 9 && ekind < 14)
                    victims.push({ x: ex, z: ez + 0.15, key: 'e' + i, hurt: (fl) => S.kb_enemy_hurt(i, fl, 1) });

                // sprite from the generic-object anim layer
                const av = S.kb_enemy_anim(i);
                const la = META.objects && META.objects[(av >> 8) + ':' + (av & 0xFF)];
                if (!la) { vis.node.set({ visible: false }); continue; }
                const key = String(av);
                if (vis.key !== key) { vis.key = key; vis.seqIdx = 0; vis.tickAcc = 0; }
                vis.tickAcc += ctl.lastTicks;
                let enGuard = la.seq.length * 8;
                while (vis.tickAcc >= la.seq[vis.seqIdx].dur && enGuard-- > 0) {
                    vis.tickAcc -= la.seq[vis.seqIdx].dur;
                    vis.seqIdx = (vis.seqIdx + 1) % la.seq.length;
                }
                if (enGuard <= 0) vis.tickAcc = 0;
                const est = la.seq[vis.seqIdx];
                const et = frameTexSync(color, est.frame) || vis.lastT;
                if (et) vis.lastT = et;
                if (!et) continue;
                // object.c:478 — enemy art natively faces LEFT: hflip is SET
                // when facing right (inverse of Kirby's convention)
                const eMirror = S.kb_enemy_facing(i) === 0;
                const eLeft = egx + (eMirror ? -(et.ox + et.w) : et.ox);
                const eTop = egy + et.oy;
                vis.node.set({
                    pos: [snapM(toWx(eLeft + et.w / 2)), -0.008, snapM(toWz(eTop + et.h / 2))],
                    quat: [0.7071, 0, 0, 0.7071],
                    scale: [et.w * M_PER_PX, et.h * M_PER_PX, 1],
                    matParams: { uTex: et.id, uFlipX: (eMirror !== !!est.hflip) ? 1 : 0, uWhite: vis.flash > 0 ? 0.7 : 0 },
                    visible: true,
                });

                // parasol attachment: the umbrella is a separate object
                // sprite in-game (parasol.c anchors it at holder x±1px);
                // drawn while the dee holds it (kb_enemy_ability == 5)
                const holdsParasol = ekind === 13 && S.kb_enemy_ability && S.kb_enemy_ability(i) === 5;
                // 817:1 = open canopy; parasol.c anchors it 18px above the
                // holder while drifting (anim variant != 0), ~16px + the
                // facing x-shift while walking/landed
                const pDrifting = (av & 0xFF) !== 0;
                const pla = holdsParasol && META.objects && META.objects['817:1'];
                if (pla) {
                    const pt = frameTexSync(color, pla.seq[0].frame) || vis.pLastT;
                    if (pt) vis.pLastT = pt;
                    if (pt) {
                        if (!vis.pNode) {
                            inst.gfx.material('enp' + i, {
                                type: 'shader', transparent: true, depthWrite: false,
                                uniforms: { uTex: pt.id, uFlipX: 0 },
                                vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
                                fragmentShader: `varying vec2 vUv; uniform sampler2D uTex; uniform float uFlipX;
                                    void main(){ vec2 uv=vec2(uFlipX>0.5?1.0-vUv.x:vUv.x,1.0-vUv.y); vec4 c=texture2D(uTex,uv);
                                    if(c.a<0.05) discard; gl_FragColor=c; }`,
                            });
                            vis.pNode = inst.gfx.mesh('enpn' + i, { geo: 'quad', mat: 'enp' + i });
                        }
                        const pAnchor = pDrifting ? egx : egx + (eMirror ? 1 : -1);
                        const pLeft = pAnchor + (eMirror ? -(pt.ox + pt.w) : pt.ox);
                        const pTop = egy - (pDrifting ? 18 : 16) + pt.oy;
                        vis.pNode.set({
                            pos: [snapM(toWx(pLeft + pt.w / 2)), -0.009, snapM(toWz(pTop + pt.h / 2))],
                            quat: [0.7071, 0, 0, 0.7071],
                            scale: [pt.w * M_PER_PX, pt.h * M_PER_PX, 1],
                            matParams: { uTex: pt.id, uFlipX: eMirror ? 1 : 0 },
                            visible: true,
                        });
                        vis.pOn = true;
                    }
                } else if (vis.pOn) { vis.pNode.set({ visible: false }); vis.pOn = false; }
            }
            if (victims.length) scanImpacts(world, victims);

            // one-shot VFX from the sim's KatamFx channel
            if (S.kb_fx_count) {
                const fn = S.kb_fx_count();
                ctl.fxVis = ctl.fxVis || new Map();
                for (let i = 0; i < fn; i++) {
                    let fv = ctl.fxVis.get(i);
                    if (!S.kb_fx_live(i)) {
                        if (fv) { fv.node.set({ visible: false }); fv.node.remove(); ctl.fxVis.delete(i); }
                        continue;
                    }
                    const fa = S.kb_fx_anim(i);
                    const fla = META.objects && META.objects[(fa >> 8) + ':' + (fa & 0xFF)];
                    if (!fla) { S.kb_fx_expire(i); continue; }
                    if (!fv) {
                        inst.gfx.material('fxm' + i, {
                            type: 'shader', transparent: true, depthWrite: false,
                            uniforms: { uTex: bootTex.id, uFlipX: 0 },
                            vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
                            fragmentShader: `varying vec2 vUv; uniform sampler2D uTex; uniform float uFlipX;
                                void main(){ vec2 uv=vec2(uFlipX>0.5?1.0-vUv.x:vUv.x,1.0-vUv.y); vec4 c=texture2D(uTex,uv);
                                if(c.a<0.05) discard; gl_FragColor=c; }`,
                        });
                        fv = { node: inst.gfx.mesh('fxn' + i, { geo: 'quad', mat: 'fxm' + i }), stamp: -1, seqIdx: 0, tickAcc: 0, lastT: null };
                        ctl.fxVis.set(i, fv);
                    }
                    // new effect occupies the slot when age resets below our stamp
                    const age = S.kb_fx_age(i);
                    if (age < fv.stamp) { fv.seqIdx = 0; fv.tickAcc = 0; }
                    fv.stamp = age;
                    fv.tickAcc += ctl.lastTicks;
                    let done = false;
                    let fg = fla.seq.length * 8;
                    while (fv.tickAcc >= fla.seq[fv.seqIdx].dur && fg-- > 0) {
                        fv.tickAcc -= fla.seq[fv.seqIdx].dur;
                        if (fv.seqIdx + 1 < fla.seq.length) { fv.seqIdx++; continue; }
                        if (fla.loop) { fv.seqIdx = 0; continue; }
                        done = true; break;
                    }
                    if (done || fg <= 0) { S.kb_fx_expire(i); fv.node.set({ visible: false }); continue; }
                    const fst = fla.seq[fv.seqIdx];
                    const ft = frameTexSync(color, fst.frame) || fv.lastT;
                    if (ft) fv.lastT = ft;
                    if (!ft) continue;
                    const fFlip = S.kb_fx_flip(i) === 1;
                    const fgx = S.kb_fx_x(i) / 256, fgy = S.kb_fx_y(i) / 256;
                    const fLeft = fgx + (fFlip ? -(ft.ox + ft.w) : ft.ox);
                    const fTop = fgy + ft.oy;
                    fv.node.set({
                        pos: [snapM(toWx(fLeft + ft.w / 2)), -0.006, snapM(toWz(fTop + ft.h / 2))],
                        quat: [0.7071, 0, 0, 0.7071],
                        scale: [ft.w * M_PER_PX, ft.h * M_PER_PX, 1],
                        matParams: { uTex: ft.id, uFlipX: (fFlip !== !!fst.hflip) ? 1 : 0 },
                        visible: true,
                    });
                }
            }
            // prune processed bus hits
            lastBusHitT = world.time;
            while (pendingHits.length && world.time - pendingHits[0].t > 1) pendingHits.shift();
        } else {
            lastBusHitT = world.time;
        }
    });

    return {
        dispose() {
            node.remove();
            if (funnelNode) funnelNode.remove();
            overlayNodes.hat.node.remove();
            overlayNodes.weapon.node.remove();
            for (const [, vis] of enemyVis) { vis.body.remove(); vis.node.remove(); }
            enemyVis.clear();
            body.remove();
            S.kb_despawn(slot);
            ctl.slotOwner[slot] = null;
            if (ctl.master === inst.iid) {
                const next = ctl.slotOwner.find(o => o !== null);
                ctl.master = next !== undefined && next !== null ? next : null;
            }
        },
    };
});
