// Swordfighter — MimicKit RL humanoid as a Buddy API pack, instanced.
//
// Everything character-specific lives here in the cell: ONNX runtime +
// policies, MJCF parsing, observation building and behavior. The host only
// sees engine-agnostic rigs (phys.articulation), retained-mode meshes, and
// per-frame drive targets.
//
// Instancing: ONE onnxruntime + ONE session pair serves every fighter.
// A cell-level 30Hz control tick gathers observations from all instances,
// stacks them into [N, obs] tensors and runs the policies BATCHED (probed
// at boot; falls back to sequential through the same shared sessions if the
// export has a fixed batch dim). Fighters prefer to fight each other: any
// other sword-bearing rig (sibling instance or foreign cell) outranks the
// cursor and lesser prey.

export const meta = {
    name: 'Swordfighter',
    author: 'BuddyEngine',
    version: '3',
    description: 'MimicKit sword & shield humanoid. Duels other swordfighters on sight, otherwise chases and strikes the mouse cursor; does idle skills when left alone.',
};

const LLC_FILE = 'llc_sword_shield.onnx';
const HLC_FILE = 'hlc_strike.onnx';

const buddy = await Buddy.ready();
const mk = await buddy.assets.module('mimickit.js');
const M = mk;

buddy.log('swordfighter cell booting');

// ---------------------------------------------------------------------------
// ONNX runtime + shared sessions (one of each for ALL fighters)
// ---------------------------------------------------------------------------
await buddy.assets.script('sys:vendor/ort.wasm.min.js');
const ortMjs = await buddy.assets.bytes('sys:vendor/ort-wasm-simd-threaded.mjs');
const ortWasm = await buddy.assets.bytes('sys:vendor/ort-wasm-simd-threaded.wasm');
ort.env.wasm.wasmPaths = {
    mjs: URL.createObjectURL(new Blob([ortMjs], { type: 'text/javascript' })),
    wasm: URL.createObjectURL(new Blob([ortWasm], { type: 'application/wasm' })),
};
ort.env.wasm.numThreads = 1;

const llcBuf = await buddy.assets.bytes(LLC_FILE);
const llc = await ort.InferenceSession.create(llcBuf, { executionProviders: ['wasm'] });
let hlc = null;
try {
    hlc = await ort.InferenceSession.create(
        await buddy.assets.bytes(HLC_FILE), { executionProviders: ['wasm'] });
} catch (e) {
    buddy.log('no HLC, running latent-only:', e.message);
}

const data = mk.prepareHumanoidData(mk.extractOnnxMetadata(llcBuf));
const LATENT_DIM = data.latent_dim || 64;
const OBS_DIM = data.obs_dim;
buddy.log('rig:', data.bodies.length, 'bodies,', data.dofInfo.length, 'dofs');

// Can the exports take a batch dimension > 1? Probe once.
let BATCH_OK = false;
try {
    const o2 = new ort.Tensor('float32', new Float32Array(2 * OBS_DIM), [2, OBS_DIM]);
    const z2 = new ort.Tensor('float32', new Float32Array(2 * LATENT_DIM), [2, LATENT_DIM]);
    const out = await llc.run({ obs: o2, latent: z2 });
    BATCH_OK = out.action.dims[0] === 2;
    if (BATCH_OK && hlc) {
        const t2 = new ort.Tensor('float32', new Float32Array(2 * 15), [2, 15]);
        const hout = await hlc.run({ obs: o2, task_obs: t2 });
        BATCH_OK = hout.z.dims[0] === 2;
    }
} catch (e) {
    BATCH_OK = false;
}
buddy.log('policy batching:', BATCH_OK ? 'dynamic (single run per tick)' : 'fixed (sequential, shared session)');

// ---------------------------------------------------------------------------
// Shared visual prototypes ('$'-ids): geometry + materials per rig link,
// defined once; every instance's meshes reference them.
// ---------------------------------------------------------------------------
const BODY_COLORS = {
    pelvis: 0x5577aa, torso: 0x5577aa, head: 0xcc8866,
    right_upper_arm: 0x77aa55, right_lower_arm: 0x77aa55, right_hand: 0xcc8866,
    sword: 0xcccccc,
    left_upper_arm: 0xaa7755, left_lower_arm: 0xaa7755, shield: 0x8888cc, left_hand: 0xcc8866,
    right_thigh: 0x5577aa, right_shin: 0x5577aa, right_foot: 0x555577,
    left_thigh: 0x5577aa, left_shin: 0x5577aa, left_foot: 0x555577,
};

function fromToPose(ft, alongY) {
    const p0 = [ft[0], ft[1], ft[2]], p1 = [ft[3], ft[4], ft[5]];
    const d = [p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]];
    const len = Math.hypot(...d);
    const mid = [(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2];
    const dir = len > 1e-4 ? d.map(v => v/len) : [0, 1, 0];
    return { mid, len, quat: M.quatFromTwoVec(alongY, dir) };
}

const geomPlacements = []; // {body, geoId, matId, pos, quat} for instance meshes
for (const body of data.bodies) {
    const matId = 'm_' + body.name;
    buddy.gfx.material(matId, {
        type: 'standard',
        params: { color: BODY_COLORS[body.name] || 0x888888, roughness: 0.6, metalness: 0.2 },
    });
    body.geoms.forEach((g, gi) => {
        const geoId = `geo_${body.name}_${gi}`;
        let placed = null;
        if (g.type === 'sphere') {
            buddy.gfx.geometry(geoId, { type: 'sphere', params: { r: g.radius } });
            placed = { pos: g.pos };
        } else if (g.type === 'capsule' && g.fromto) {
            const { mid, len, quat } = fromToPose(g.fromto, [0, 1, 0]);
            buddy.gfx.geometry(geoId, { type: 'capsule', params: { r: g.radius, l: len } });
            placed = { pos: mid, quat };
        } else if (g.type === 'box') {
            const he = g.halfExtents;
            buddy.gfx.geometry(geoId, { type: 'box', params: { w: he[0]*2, h: he[1]*2, d: he[2]*2 } });
            placed = { pos: g.pos };
        } else if (g.type === 'cylinder') {
            if (g.fromto) {
                const { mid, len, quat } = fromToPose(g.fromto, [0, 1, 0]);
                buddy.gfx.geometry(geoId, { type: 'cylinder', params: { rt: g.radius, rb: g.radius, h: Math.max(len, 0.01) } });
                placed = { pos: mid, quat };
            } else {
                buddy.gfx.geometry(geoId, { type: 'cylinder', params: { rt: g.radius, rb: g.radius, h: (g.halfHeight || 0.015) * 2 } });
                placed = { pos: g.pos || [0, 0, 0] };
            }
        }
        if (placed) geomPlacements.push({ body: body.name, gi, geoId, matId, ...placed });
    });
}

// ---------------------------------------------------------------------------
// Observation building (per fighter)
// ---------------------------------------------------------------------------
const keyIds = data.key_body_ids || [2, 5, 10, 13, 16, 6];

function supportHeightAt(colliders, x, z) {
    let best = 0;
    for (const c of colliders) {
        if (c.id.startsWith('sys/wall')) continue;
        const top = c.cz + c.hz;
        if (x >= c.cx - c.hx && x <= c.cx + c.hx && top <= z && top > best) best = top;
    }
    return best;
}

function buildObservation(F, world, supportZ) {
    const obs = new Float32Array(OBS_DIM);
    const js = world.arti[F.artiLocal];
    const root = world.bodies.get(F.rootBodyId);
    if (!js || !root) return null;

    const headingInv = M.calcHeadingQuatInv(root.quat);
    let idx = 0;

    obs[idx++] = root.pos[2] - supportZ;

    const tn = M.quatToTanNorm(M.quatMul(headingInv, root.quat));
    for (let i = 0; i < 6; i++) obs[idx++] = tn[i];

    const lv = M.quatRotateVec(headingInv, root.vel);
    obs[idx++] = lv[0]; obs[idx++] = lv[1]; obs[idx++] = lv[2];
    const lav = M.quatRotateVec(headingInv, root.angvel);
    obs[idx++] = lav[0]; obs[idx++] = lav[1]; obs[idx++] = lav[2];

    for (const kj of data.kinematicJoints) {
        let quat;
        if (kj.type === 'SPHERICAL') {
            quat = M.expMapToQuat(js.dofPos[kj.dof_idx], js.dofPos[kj.dof_idx + 1], js.dofPos[kj.dof_idx + 2]);
        } else if (kj.type === 'HINGE') {
            quat = M.axisAngleToQuat(kj.axis, js.dofPos[kj.dof_idx]);
        } else {
            quat = [0, 0, 0, 1];
        }
        const jtn = M.quatToTanNorm(quat);
        for (let k = 0; k < 6; k++) obs[idx++] = jtn[k];
    }

    for (let i = 0; i < data.dofInfo.length; i++) obs[idx++] = js.dofVel[i];

    for (const kid of F.keyBodyIds) {
        const b = world.bodies.get(kid);
        const rel = b
            ? [b.pos[0] - root.pos[0], b.pos[1] - root.pos[1], b.pos[2] - root.pos[2]]
            : [0, 0, 0];
        const lrel = M.quatRotateVec(headingInv, rel);
        obs[idx++] = lrel[0]; obs[idx++] = lrel[1]; obs[idx++] = lrel[2];
    }

    return obs;
}

// ---------------------------------------------------------------------------
// Target selection. Priority: other swordfighters (sibling instances or any
// foreign rig carrying a sword) — duels first — then the nearest of cursor
// proxy / other buddies, with hysteresis against twitchy switching.
// ---------------------------------------------------------------------------
function pickTarget(F, world, root) {
    const dist = (b) => Math.hypot(b.pos[0] - root.pos[0], b.pos[2] - root.pos[2]);

    // Rival fighters: any pelvis whose owner also owns a sword link, minus me.
    let bestFighter = null, bestFighterD = Infinity;
    for (const [id, b] of world.bodies) {
        if (!id.endsWith('.pelvis') || id === F.rootBodyId) continue;
        const rigPrefix = id.slice(0, -'.pelvis'.length);
        if (!world.bodies.has(rigPrefix + '.sword')) continue;
        const d = dist(b);
        if (d < bestFighterD) { bestFighterD = d; bestFighter = id; }
    }

    let bestId = 'sys/target', bestD = Infinity;
    F.nearestPreyDist = Infinity;
    if (bestFighter) {
        // A rival always outranks everything else.
        bestId = bestFighter;
        bestD = bestFighterD;
        F.nearestPreyDist = bestFighterD;
    } else {
        const cursorBody = world.bodies.get('sys/target');
        if (cursorBody) { bestId = 'sys/target'; bestD = dist(cursorBody); }
        const seen = new Set(['sys']);
        for (const [id, b] of world.bodies) {
            if (id.startsWith(buddy.id + '/')) continue; // no bullying siblings' props
            const owner = id.split('/')[0];
            if (seen.has(owner)) continue;
            seen.add(owner);
            const d = dist(b);
            if (d < F.nearestPreyDist) F.nearestPreyDist = d;
            if (d < bestD) { bestD = d; bestId = id; }
        }
    }

    const cur = world.bodies.get(F.targetId);
    const curIsFighter = F.targetId.endsWith('.pelvis');
    if (!cur || (bestFighter && !curIsFighter)) { F.targetId = bestId; return; }
    if (bestId !== F.targetId && bestD < dist(cur) * 0.75) {
        F.targetId = bestId;
    }
}

function buildTaskObs(F, world, supportZ) {
    const taskObs = new Float32Array(15);
    const root = world.bodies.get(F.rootBodyId);
    const tar = world.bodies.get(F.targetId) || world.bodies.get('sys/target');
    if (!root || !tar) return taskObs;

    const headingInv = M.calcHeadingQuatInv(root.quat);
    let idx = 0;

    const relZ = Math.min(Math.max(tar.pos[2] - supportZ, 0.2), 2.2);
    const localTarPos = M.quatRotateVec(headingInv, [
        tar.pos[0] - root.pos[0],
        tar.pos[1] - root.pos[1],
        relZ,
    ]);
    taskObs[idx++] = localTarPos[0];
    taskObs[idx++] = localTarPos[1];
    taskObs[idx++] = localTarPos[2];

    const tn = M.quatToTanNorm(M.quatMul(headingInv, [0, 0, 0, 1]));
    for (let i = 0; i < 6; i++) taskObs[idx++] = tn[i];

    const lv = M.quatRotateVec(headingInv, tar.vel);
    taskObs[idx++] = lv[0]; taskObs[idx++] = lv[1]; taskObs[idx++] = lv[2];
    taskObs[idx++] = 0; taskObs[idx++] = 0; taskObs[idx++] = 0;

    return taskObs;
}

// ---------------------------------------------------------------------------
// Latents
// ---------------------------------------------------------------------------
function sampleUnitLatent() {
    const v = new Float32Array(LATENT_DIM);
    let n = 0;
    for (let i = 0; i < v.length; i++) { v[i] = M.gaussianRandom(); n += v[i] * v[i]; }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
}

function slerpLatent(F) {
    let n = 0;
    for (let i = 0; i < F.latent.length; i++) {
        F.latent[i] += 0.05 * (F.latentTarget[i] - F.latent[i]);
        n += F.latent[i] * F.latent[i];
    }
    n = Math.sqrt(n);
    if (n > 1e-8) for (let i = 0; i < F.latent.length; i++) F.latent[i] /= n;
}

function clampActions(action, offset) {
    const lo = data.action_low, hi = data.action_high;
    const n = data.dofInfo.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        let a = action[offset + i];
        if (lo && hi) a = Math.max(lo[i], Math.min(hi[i], a));
        out[i] = a;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
const fighters = new Map(); // iid -> F

Buddy.instances((inst) => {
    const sx = inst.spawn.x !== undefined ? inst.spawn.x : -1.5 - (inst.iid - 1) * 1.2;
    const rig = inst.phys.articulation('avatar', data, { x: sx });

    // Meshes reference the shared '$' prototypes; groups track the rig links.
    for (const body of data.bodies) {
        inst.gfx.group('g_' + body.name).attach(rig.linkBody(body.name));
    }
    for (const p of geomPlacements) {
        inst.gfx.mesh(`n_${p.body}_${p.gi}`, {
            geo: '$' + p.geoId, mat: '$' + p.matId,
            parent: 'g_' + p.body, pos: p.pos, quat: p.quat,
        });
    }

    const F = {
        iid: inst.iid,
        rig,
        artiLocal: 'i' + inst.iid + '.avatar',
        rootBodyId: inst.bodyId('avatar.' + data.bodies[0].name),
        keyBodyIds: keyIds.map(i => inst.bodyId('avatar.' + data.bodies[i].name)),
        targetId: 'sys/target',
        nearestPreyDist: Infinity,
        mode: 'strike',
        latent: sampleUnitLatent(),
        latentTarget: null,
        lastIdleSkill: 0,
    };
    F.latentTarget = F.latent.slice();
    fighters.set(inst.iid, F);
    inst.log('fighter up at x=' + sx.toFixed(1));

    return {
        dispose() {
            fighters.delete(inst.iid);
        },
    };
});

buddy.bus.on('sys.reset', () => {
    for (const F of fighters.values()) {
        F.latent = sampleUnitLatent();
        F.latentTarget = F.latent.slice();
    }
    lastControl = 0;
});

// ---------------------------------------------------------------------------
// Cell-level control tick: gather everyone, batch the policies.
// ---------------------------------------------------------------------------
const CONTROL_DT = 1 / 30;
const IDLE_AFTER_S = 8;
const IDLE_NEW_SKILL_S = 5;

let lastControl = 0;
let lastCursor = { x: 0, y: 0 };
let lastCursorMove = 0;
let busy = false;

buddy.onFrame(async (world) => {
    if (world.cursor.px !== lastCursor.x || world.cursor.py !== lastCursor.y) {
        lastCursor = { x: world.cursor.px, y: world.cursor.py };
        lastCursorMove = world.time;
    }
    if (busy || fighters.size === 0 || world.time - lastControl < CONTROL_DT) return;
    lastControl = world.time;
    busy = true;
    try {
        // Gather per-fighter observations.
        const jobs = [];
        for (const F of fighters.values()) {
            const root = world.bodies.get(F.rootBodyId);
            if (!root) continue;
            pickTarget(F, world, root);

            // Idle only when the cursor rests AND nothing (rival included)
            // is worth chasing.
            if (world.time - lastCursorMove > IDLE_AFTER_S && F.nearestPreyDist > 5) {
                if (F.mode !== 'idle') {
                    F.mode = 'idle';
                    F.latent = sampleUnitLatent();
                    F.latentTarget = F.latent.slice();
                }
                if (world.time - F.lastIdleSkill > IDLE_NEW_SKILL_S) {
                    F.latentTarget = sampleUnitLatent();
                    F.lastIdleSkill = world.time;
                }
            } else {
                F.mode = 'strike';
            }

            const supportZ = supportHeightAt(world.colliders, root.pos[0], root.pos[2]);
            const obs = buildObservation(F, world, supportZ);
            if (!obs) continue;
            jobs.push({ F, obs, taskObs: F.mode === 'strike' ? buildTaskObs(F, world, supportZ) : null });
        }
        if (!jobs.length) return;

        if (BATCH_OK) {
            // One stacked run for the whole roster: hlc over strikers to get
            // their latents, then llc over everyone.
            const N = jobs.length;
            const latents = new Float32Array(N * LATENT_DIM);
            const strikers = jobs.map((j, i) => j.taskObs ? i : -1).filter(i => i >= 0);
            if (hlc && strikers.length) {
                const sObs = new Float32Array(strikers.length * OBS_DIM);
                const sTask = new Float32Array(strikers.length * 15);
                strikers.forEach((ji, k) => {
                    sObs.set(jobs[ji].obs, k * OBS_DIM);
                    sTask.set(jobs[ji].taskObs, k * 15);
                });
                const z = (await hlc.run({
                    obs: new ort.Tensor('float32', sObs, [strikers.length, OBS_DIM]),
                    task_obs: new ort.Tensor('float32', sTask, [strikers.length, 15]),
                })).z.data;
                strikers.forEach((ji, k) => {
                    latents.set(z.subarray(k * LATENT_DIM, (k + 1) * LATENT_DIM), ji * LATENT_DIM);
                });
            }
            jobs.forEach((j, i) => {
                if (!j.taskObs || !hlc) {
                    slerpLatent(j.F);
                    latents.set(j.F.latent, i * LATENT_DIM);
                }
            });
            const allObs = new Float32Array(N * OBS_DIM);
            jobs.forEach((j, i) => allObs.set(j.obs, i * OBS_DIM));
            const action = (await llc.run({
                obs: new ort.Tensor('float32', allObs, [N, OBS_DIM]),
                latent: new ort.Tensor('float32', latents, [N, LATENT_DIM]),
            })).action.data;
            const stride = action.length / N;
            jobs.forEach((j, i) => j.F.rig.drive(clampActions(action, i * stride)));
        } else {
            // Fixed-batch export: sequential, but still one shared session.
            for (const j of jobs) {
                const obsT = new ort.Tensor('float32', j.obs, [1, OBS_DIM]);
                let zData;
                if (j.taskObs && hlc) {
                    const taskT = new ort.Tensor('float32', j.taskObs, [1, 15]);
                    zData = (await hlc.run({ obs: obsT, task_obs: taskT })).z.data;
                } else {
                    slerpLatent(j.F);
                    zData = j.F.latent;
                }
                const zT = new ort.Tensor('float32', zData, [1, LATENT_DIM]);
                const action = (await llc.run({ obs: obsT, latent: zT })).action.data;
                j.F.rig.drive(clampActions(action, 0));
            }
        }
    } catch (e) {
        buddy.log('control error: ' + (e.stack || e.message));
    } finally {
        busy = false;
    }
});

buddy.log('swordfighter cell online');
