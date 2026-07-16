// Swordfighter — MimicKit RL humanoid as a Buddy API pack.
//
// Everything character-specific lives here in the cell: ONNX runtime +
// policies, MJCF parsing, observation building and behavior. The host only
// sees an engine-agnostic rig (phys.articulation), retained-mode meshes,
// and per-frame drive targets. Inference runs inside the frame callback so
// actions computed from this frame's observations are applied before the
// host's next physics step.

const buddy = await Buddy.ready();
const mk = await buddy.assets.module('mimickit.js');
const M = mk; // quat math lives alongside the parser

buddy.log('swordfighter booting');

// ---------------------------------------------------------------------------
// ONNX runtime, in-cell (runtime files shared by the host via sys: assets)
// ---------------------------------------------------------------------------
await buddy.assets.script('sys:vendor/ort.wasm.min.js');
const ortMjs = await buddy.assets.bytes('sys:vendor/ort-wasm-simd-threaded.mjs');
const ortWasm = await buddy.assets.bytes('sys:vendor/ort-wasm-simd-threaded.wasm');
ort.env.wasm.wasmPaths = {
    mjs: URL.createObjectURL(new Blob([ortMjs], { type: 'text/javascript' })),
    wasm: URL.createObjectURL(new Blob([ortWasm], { type: 'application/wasm' })),
};
ort.env.wasm.numThreads = 1;

const llcBuf = await buddy.assets.bytes(buddy.manifest.llc);
const llc = await ort.InferenceSession.create(llcBuf, { executionProviders: ['wasm'] });
let hlc = null;
try {
    hlc = await ort.InferenceSession.create(
        await buddy.assets.bytes(buddy.manifest.hlc_strike), { executionProviders: ['wasm'] });
} catch (e) {
    buddy.log('no HLC, running latent-only:', e.message);
}

const data = mk.prepareHumanoidData(mk.extractOnnxMetadata(llcBuf));
const LATENT_DIM = data.latent_dim || 64;
buddy.log('rig:', data.bodies.length, 'bodies,', data.dofInfo.length, 'dofs');

// ---------------------------------------------------------------------------
// Articulation + visuals through the Buddy API
// ---------------------------------------------------------------------------
const rig = buddy.phys.articulation('avatar', data, { x: -1.5 });

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

for (const body of data.bodies) {
    const color = BODY_COLORS[body.name] || 0x888888;
    const matId = 'm_' + body.name;
    buddy.gfx.material(matId, { type: 'standard', params: { color, roughness: 0.6, metalness: 0.2 } });
    const groupId = 'g_' + body.name;
    buddy.gfx.group(groupId).attach(rig.linkBody(body.name));

    body.geoms.forEach((g, gi) => {
        const geoId = `geo_${body.name}_${gi}`;
        const nodeId = `n_${body.name}_${gi}`;
        if (g.type === 'sphere') {
            buddy.gfx.geometry(geoId, { type: 'sphere', params: { r: g.radius } });
            buddy.gfx.mesh(nodeId, { geo: geoId, mat: matId, parent: groupId, pos: g.pos });
        } else if (g.type === 'capsule' && g.fromto) {
            const { mid, len, quat } = fromToPose(g.fromto, [0, 1, 0]);
            buddy.gfx.geometry(geoId, { type: 'capsule', params: { r: g.radius, l: len } });
            buddy.gfx.mesh(nodeId, { geo: geoId, mat: matId, parent: groupId, pos: mid, quat });
        } else if (g.type === 'box') {
            const he = g.halfExtents;
            buddy.gfx.geometry(geoId, { type: 'box', params: { w: he[0]*2, h: he[1]*2, d: he[2]*2 } });
            buddy.gfx.mesh(nodeId, { geo: geoId, mat: matId, parent: groupId, pos: g.pos });
        } else if (g.type === 'cylinder') {
            if (g.fromto) {
                const { mid, len, quat } = fromToPose(g.fromto, [0, 1, 0]);
                buddy.gfx.geometry(geoId, { type: 'cylinder', params: { rt: g.radius, rb: g.radius, h: Math.max(len, 0.01) } });
                buddy.gfx.mesh(nodeId, { geo: geoId, mat: matId, parent: groupId, pos: mid, quat });
            } else {
                buddy.gfx.geometry(geoId, { type: 'cylinder', params: { rt: g.radius, rb: g.radius, h: (g.halfHeight || 0.015) * 2 } });
                buddy.gfx.mesh(nodeId, { geo: geoId, mat: matId, parent: groupId, pos: g.pos || [0, 0, 0] });
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Observations (from the frame world view + articulation joint state)
// ---------------------------------------------------------------------------
const rootBodyId = buddy.id + '/' + rig.linkBody(data.bodies[0].name);
const keyIds = data.key_body_ids || [2, 5, 10, 13, 16, 6];
const keyBodyIds = keyIds.map(i => buddy.id + '/' + rig.linkBody(data.bodies[i].name));

function supportHeightAt(colliders, x, z) {
    let best = 0;
    for (const c of colliders) {
        if (c.id.startsWith('sys/wall')) continue;
        const top = c.cz + c.hz;
        if (x >= c.cx - c.hx && x <= c.cx + c.hx && top <= z && top > best) best = top;
    }
    return best;
}

function buildObservation(world, supportZ) {
    const obs = new Float32Array(data.obs_dim);
    const js = world.arti.avatar;
    const root = world.bodies.get(rootBodyId);
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

    for (const kid of keyBodyIds) {
        const b = world.bodies.get(kid);
        const rel = b
            ? [b.pos[0] - root.pos[0], b.pos[1] - root.pos[1], b.pos[2] - root.pos[2]]
            : [0, 0, 0];
        const lrel = M.quatRotateVec(headingInv, rel);
        obs[idx++] = lrel[0]; obs[idx++] = lrel[1]; obs[idx++] = lrel[2];
    }

    return obs;
}

// ASE strike task obs (15): the cursor's physics proxy is the target.
function buildTaskObs(world, supportZ) {
    const taskObs = new Float32Array(15);
    const root = world.bodies.get(rootBodyId);
    const tar = world.bodies.get('sys/target');
    if (!root || !tar) return taskObs;

    const headingInv = M.calcHeadingQuatInv(root.quat);
    let idx = 0;

    // Support-relative Z, clamped to the strike-reachable band from training.
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
// Policies
// ---------------------------------------------------------------------------
let latent = sampleUnitLatent();
let latentTarget = latent.slice();

function sampleUnitLatent() {
    const v = new Float32Array(LATENT_DIM);
    let n = 0;
    for (let i = 0; i < v.length; i++) { v[i] = M.gaussianRandom(); n += v[i] * v[i]; }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
}

function slerpLatent() {
    let n = 0;
    for (let i = 0; i < latent.length; i++) {
        latent[i] += 0.05 * (latentTarget[i] - latent[i]);
        n += latent[i] * latent[i];
    }
    n = Math.sqrt(n);
    if (n > 1e-8) for (let i = 0; i < latent.length; i++) latent[i] /= n;
}

async function runStrike(obs, taskObs) {
    const obsT = new ort.Tensor('float32', obs, [1, data.obs_dim]);
    if (hlc) {
        const taskT = new ort.Tensor('float32', taskObs, [1, 15]);
        const z = (await hlc.run({ obs: obsT, task_obs: taskT })).z.data;
        const zT = new ort.Tensor('float32', z, [1, LATENT_DIM]);
        return (await llc.run({ obs: obsT, latent: zT })).action.data;
    }
    const zT = new ort.Tensor('float32', latent, [1, LATENT_DIM]);
    return (await llc.run({ obs: obsT, latent: zT })).action.data;
}

async function runLatent(obs) {
    const obsT = new ort.Tensor('float32', obs, [1, data.obs_dim]);
    const zT = new ort.Tensor('float32', latent, [1, LATENT_DIM]);
    return (await llc.run({ obs: obsT, latent: zT })).action.data;
}

function clampActions(action) {
    const lo = data.action_low, hi = data.action_high;
    const out = new Array(action.length);
    for (let i = 0; i < action.length; i++) {
        let a = action[i];
        if (lo && hi) a = Math.max(lo[i], Math.min(hi[i], a));
        out[i] = a;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Behavior: strike at the mouse; idle skills when the cursor rests.
// ---------------------------------------------------------------------------
const CONTROL_DT = 1 / 30;
const IDLE_AFTER_S = 8;
const IDLE_NEW_SKILL_S = 5;

let mode = 'strike';
let lastControl = 0;
let lastCursor = { x: 0, y: 0 };
let lastCursorMove = 0;
let lastIdleSkill = 0;
let busy = false;

buddy.bus.on('sys.reset', () => {
    latent = sampleUnitLatent();
    latentTarget = latent.slice();
    lastControl = 0;
});

buddy.onFrame(async (world) => {
    if (world.cursor.px !== lastCursor.x || world.cursor.py !== lastCursor.y) {
        lastCursor = { x: world.cursor.px, y: world.cursor.py };
        lastCursorMove = world.time;
    }

    if (world.time - lastCursorMove > IDLE_AFTER_S) {
        if (mode !== 'idle') { mode = 'idle'; latent = sampleUnitLatent(); latentTarget = latent.slice(); }
        if (world.time - lastIdleSkill > IDLE_NEW_SKILL_S) {
            latentTarget = sampleUnitLatent();
            lastIdleSkill = world.time;
        }
    } else {
        mode = 'strike';
    }

    if (busy || world.time - lastControl < CONTROL_DT) return;
    lastControl = world.time;
    busy = true;
    try {
        const root = world.bodies.get(rootBodyId);
        if (!root) return;
        const supportZ = supportHeightAt(world.colliders, root.pos[0], root.pos[2]);
        const obs = buildObservation(world, supportZ);
        if (!obs) return;

        let action;
        if (mode === 'strike') {
            action = await runStrike(obs, buildTaskObs(world, supportZ));
        } else {
            slerpLatent();
            action = await runLatent(obs);
        }
        if (action) rig.drive(clampActions(action));
    } catch (e) {
        buddy.log('control error: ' + (e.stack || e.message));
    } finally {
        busy = false;
    }
});

buddy.log('swordfighter online');
