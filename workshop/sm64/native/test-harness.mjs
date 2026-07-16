// Headless harness for the sm64 buddy pack: stubs the Buddy SDK, feeds
// synthetic world frames, and asserts on the buddy's observable behavior.
import fs from 'fs';
import path from 'path';

const PACK = '/home/agent-untrusted/Desktop/BuddyEngine/workshop/sm64';

// ---- stub cell environment -------------------------------------------------
const logs = [];
const broadcasts = [];
const bodies = new Map();   // harness-owned dynamic bodies
const spawned = new Map();  // id -> {pos, vel}

const buddy = {
    id: 'b1',
    screen: { wPx: 1920, hPx: 1080, ppm: 120, groundPy: 1000 },
    log: (...a) => { logs.push(a.join(' ')); },
    onFrame(cb) { buddy._frameCb = cb; },
    phys: {
        spawn(id, desc) {
            spawned.set(id, { pos: [...(desc.pos || [0, 0, 0])], vel: [0, 0, 0] });
            return buddy.phys.body(id);
        },
        body(id) {
            return {
                id,
                get state() {
                    const s = spawned.get(id);
                    return s && { pos: [...s.pos], quat: [0, 0, 0, 1], vel: [...s.vel], angvel: [0, 0, 0] };
                },
                velocity(v) { const s = spawned.get(id); if (s) s.vel = [...v]; },
                force() {}, impulse() {}, kinematicTarget() {},
                remove() { spawned.delete(id); },
            };
        },
    },
    gfx: {
        geometry: () => 'g', material: () => 'm', texture: () => 't',
        mesh: () => ({ set() { return this; }, attach() { return this; }, remove() {} }),
        sprite: () => ({ set() { return this; }, attach() { return this; }, remove() {} }),
        group: () => ({ set() { return this; }, attach() { return this; }, remove() {} }),
        gltf: () => ({ set() { return this; }, attach() { return this; }, anim() { return this; }, remove() {} }),
        node: () => ({ set() { return this; }, attach() { return this; }, remove() {} }),
    },
    assets: {
        async bytes(p) {
            const buf = fs.readFileSync(path.join(PACK, p));
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        async module(p) { return import(path.join(PACK, p)); },
    },
    bus: {
        broadcast(topic, data) { broadcasts.push({ topic, data }); },
        send() {},
        on(topic, cb) { (buddy._busCbs ??= new Map()).set(topic, cb); },
    },
    publishCanvas() {},
};

globalThis.Buddy = { ready: async () => buddy };
globalThis.OffscreenCanvas = class { constructor() {} getContext() { return null; } };

// ---- world simulation --------------------------------------------------------
let T = 0;
const DT = 1 / 60;
const cursor = { px: 0, py: 0, wx: -4, wz: 3, l: 0, r: 0 };
let events = [];
// Collider shapes mirror desk.js exactly: ground/walls are static and huge,
// windows are thin platform strips (hz=0.12) along their top edge, and the
// depth slabs (wall_back/front) arrive as screen-covering 2D boxes — the
// pack must ignore those or Mario gets "depenetrated" to a screen edge.
const GROUND = { id: 'sys/ground', cx: 0, cz: -5, hx: 56, hz: 5, kinematic: false };
const WALL_L = { id: 'sys/wall_l', cx: -10, cz: 25, hx: 2, hz: 30, kinematic: false };
const WALL_R = { id: 'sys/wall_r', cx: 10, cz: 25, hx: 2, hz: 30, kinematic: false };
const SLAB_B = { id: 'sys/wall_back', cx: 0, cz: 25, hx: 56, hz: 35, kinematic: false };
const SLAB_F = { id: 'sys/wall_front', cx: 0, cz: 25, hx: 56, hz: 35, kinematic: false };
const WIN = { id: 'sys/win:42:0', cx: 5.5, cz: 0.88, hx: 1.5, hz: 0.12, kinematic: true };
const BASE = [GROUND, WALL_L, WALL_R, SLAB_B, SLAB_F];
let colliders = [...BASE, WIN];

function frame() {
    T += DT;
    // integrate harness bodies
    for (const s of spawned.values()) {
        s.pos[0] += s.vel[0] * DT;
        s.pos[2] += s.vel[2] * DT;
    }
    const bodyMap = new Map(bodies);
    for (const [id, s] of spawned) {
        bodyMap.set('b1/' + id, { pos: [...s.pos], quat: [0, 0, 0, 1], vel: [...s.vel], angvel: [0, 0, 0] });
    }
    const world = {
        time: T, dt: DT,
        cursor: { ...cursor },
        bodies: bodyMap,
        colliders,
        events, arti: {},
    };
    events = [];
    return buddy._frameCb ? buddy._frameCb(world) : null;
}
async function run(seconds) { const n = Math.round(seconds / DT); for (let i = 0; i < n; i++) await frame(); }

const check = (name, cond) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!cond) process.exitCode = 1;
};
const proxyPos = () => spawned.get('mario')?.pos || [0, 0, 0];

// ---- go ----------------------------------------------------------------------
await import(path.join(PACK, 'main.js'));
console.log('pack loaded');

await run(1);
check('boots and spawns mario', logs.some(l => l.includes('mario spawned')));

// 0. regression: screen-covering depth slabs must not eject him sideways
await run(5);
check('not ejected by depth slabs (x=' + proxyPos()[0].toFixed(2) + ')',
    Math.abs(proxyPos()[0]) < 6);

// 1. wanders on its own (random idle pauses: poll until he strolls, 60s cap)
const x0 = proxyPos()[0];
let moved = 0;
for (let i = 0; i < 60 * 4 && moved < 0.5; i++) { await run(0.25); moved = Math.max(moved, Math.abs(proxyPos()[0] - x0)); }
check('wanders (moved ' + moved.toFixed(2) + 'm)', moved > 0.5);
check('stays on ground plane (z=' + proxyPos()[2].toFixed(2) + ')', Math.abs(proxyPos()[2] - 0.31) < 0.25);

// 2. moving platform: raise the ground under him — a surface object move
// (window removed so he can't coincidentally be standing on it; wait until
// he's settled on the ground so platform displacement applies)
colliders = [...BASE];
for (let i = 0; i < 40; i++) {
    await run(0.25);
    const m = globalThis.__mario;
    if (m.grounded && Math.abs(m.pos[1]) < 30 && (m.state === 'idle' || m.state === 'wander')) break;
}
GROUND.cz = -4; // top now at 1.0m
colliders = [...BASE];
await run(3);
check('rides a moving collider up (z=' + proxyPos()[2].toFixed(2) + ')', proxyPos()[2] > 1.0);
GROUND.cz = -5;
colliders = [...BASE];
await run(3);
check('falls back down (z=' + proxyPos()[2].toFixed(2) + ')', proxyPos()[2] < 0.8);
colliders = [...BASE, WIN];

// 3. high-speed body -> damage
broadcasts.length = 0;
const mp = proxyPos();
bodies.set('b9/ball', { pos: [mp[0] - 0.35, 0, mp[2]], quat: [0, 0, 0, 1], vel: [9, 0, 0], angvel: [0, 0, 0] });
await run(0.5);
bodies.delete('b9/ball');
check('high-speed body causes damage', broadcasts.some(b => b.topic === 'mario.ouch'));
await run(2);

// 4. grab and hurl into the wall -> slam damage
broadcasts.length = 0;
events.push({ type: 'pointerdown', id: 'b1/mario', wx: mp[0], wz: mp[2] });
cursor.l = 1;
await run(0.1);
// drag him up-left over a second
for (let i = 0; i < 60; i++) {
    const s = spawned.get('mario');
    s.pos = [s.pos[0] - 0.02, 0, Math.min(s.pos[2] + 0.03, 3)];
    s.vel = [-18, 0, 1];
    await frame();
}
events.push({ type: 'pointerup', id: 'b1/mario', wx: cursor.wx, wz: cursor.wz });
cursor.l = 0;
await run(3);
check('thrown into wall causes slam damage', broadcasts.some(b => b.topic === 'mario.ouch'));

// 5. beat him down -> death + respawn
broadcasts.length = 0;
for (let hit = 0; hit < 12 && !broadcasts.some(b => b.topic === 'mario.dead'); hit++) {
    const p = proxyPos();
    bodies.set('b9/ball', { pos: [p[0] + 0.3, 0, p[2]], quat: [0, 0, 0, 1], vel: [-13, 0, 0], angvel: [0, 0, 0] });
    await run(0.4);
    bodies.delete('b9/ball');
    await run(0.8);
}
check('dies from repeated high-speed hits', broadcasts.some(b => b.topic === 'mario.dead'));
await run(5);
const px = proxyPos();
check('respawns near home (' + px[0].toFixed(2) + ',' + px[2].toFixed(2) + ')',
    Math.abs(px[0] - 1.0) < 1.5 && px[2] < 1.5);

// 6. still alive and behaving after all that
const x1 = proxyPos()[0];
let moved2 = 0;
for (let i = 0; i < 60 * 4 && moved2 < 0.4; i++) { await run(0.25); moved2 = Math.max(moved2, Math.abs(proxyPos()[0] - x1)); }
check('still wandering after abuse (moved ' + moved2.toFixed(2) + 'm)', moved2 > 0.4);

console.log('\nlogs:'); for (const l of logs) console.log('  ' + l);
console.log('broadcast topics:', [...new Set(broadcasts.map(b => b.topic))].join(', ') || '(none)');
