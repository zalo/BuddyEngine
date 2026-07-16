// BuddyEngine frontend bootstrap + main loop.

import { SimWorld, DT, POLICY_SUBSTEPS } from './sim.js';
import { parseMJCF } from './mjcf.js';
import { Policy, loadModelBuffers } from './policy.js';
import { Renderer } from './render.js';
import { Desk } from './desk.js';
import { Interact } from './interact.js';
import { initProtocol } from './api/protocol.js';
import { CartridgeManager } from './api/cartridges.js';
import * as packcat from '../vendor/packcat.js';

const IDLE_AFTER_S = 8;        // cursor idle -> ASE latent (idle animations)
const IDLE_NEW_SKILL_S = 5;    // pick a new idle latent target every N sec
const RESET_GRACE = 90;

let sim, desk, renderer, interact, policy, cartMgr;
let humanoidData = {};
let running = false;
let currentAction = null;
let prevTargetPos = null;
let resetGraceFrames = 60;
let physStepCount = 0;
let simAccum = 0;
let lastSimTimestamp = 0;
let lastIdleSkill = 0;
let mode = 'strike';
let iconColliders = false; // off by default; toggle in the buddy menu
let escapeCheck = 0;

function setStatus(msg) {
    const el = document.getElementById('loadStatus');
    if (el) el.textContent = msg;
}

// Crash telemetry + watchdog heartbeat. A dead page in a transparent overlay
// is invisible, so errors are logged through Go (%TEMP%\buddyengine.log) and
// the backend reloads the frontend when heartbeats stop.
function logToBackend(msg) {
    try { window.go.main.App.LogError(String(msg)); } catch (e) {}
}
window.addEventListener('error', e => {
    logToBackend('js error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', e => {
    logToBackend('unhandled rejection: ' + (e.reason && e.reason.stack || e.reason));
});
setInterval(() => {
    try { window.go.main.App.Heartbeat(); } catch (e) {}
}, 1000);

async function boot() {
    setStatus('Connecting to backend...');
    const bootstrap = await window.go.main.App.GetBootstrap();

    setStatus('Loading policy models...');
    // Use the first workshop pack if present, else the built-in buddy.
    const packs = bootstrap.packs || [];
    const hasLLC = (p) => {
        try {
            const m = typeof p.manifest === 'string' ? JSON.parse(p.manifest) : p.manifest;
            return m && m.llc;
        } catch (e) { return false; }
    };
    const modelPack = packs.find(hasLLC) || null;
    let buffers;
    let manifest = null;
    if (modelPack) {
        try {
            buffers = await loadModelBuffers(modelPack);
            manifest = buffers.manifest;
            console.log('Loaded workshop pack:', modelPack.name);
        } catch (e) {
            console.warn('Workshop pack failed, using built-in buddy:', e);
            buffers = await loadModelBuffers(null);
        }
    } else {
        buffers = await loadModelBuffers(null);
    }

    policy = new Policy();
    setStatus('Initializing PhysX...');
    sim = new SimWorld();
    await Promise.all([sim.init(), policy.load(buffers)]);

    const meta = policy.meta;
    if (!meta) throw new Error('No mimickit_config metadata in LLC ONNX');
    const fields = ['obs_dim','act_dim','latent_dim','obs_mean','obs_std','a_mean','a_std',
                    'init_dof_pos','init_root_pos','init_root_rot_quat','action_low','action_high',
                    'key_body_ids','global_obs','pelvis_z','tpose_pelvis_z'];
    for (const f of fields) {
        if (meta[f] !== undefined) humanoidData[f] = meta[f];
    }
    if (meta.mjcf_xml) {
        Object.assign(humanoidData, parseMJCF(meta.mjcf_xml));
    }
    if (!humanoidData.bodies) throw new Error('No character data in ONNX metadata');

    // Fix up spherical joint axis maps (matches the reference demo).
    if (humanoidData.kinematicJoints) {
        for (const kj of humanoidData.kinematicJoints) {
            if (kj.type !== 'SPHERICAL') continue;
            for (let d = 0; d < 3; d++)
                humanoidData.dofInfo[kj.dof_idx + d].physx_axis = d;
        }
        for (const jdata of humanoidData.joints) {
            if (jdata.jointType === 'spherical' && jdata.axisMap)
                jdata.axisMap = [0, 1, 2];
        }
    }

    setStatus('Building world...');
    const ppm = (manifest && manifest.pixelsPerMeter) || 140;
    desk = new Desk(sim, {
        screenW: bootstrap.screenW,
        screenH: bootstrap.screenH,
        workBottom: bootstrap.workBottom,
        ppm,
    });
    desk.createStaticEnvironment();
    sim.createTarget();

    // Spawn slightly left of center, on the ground.
    sim.buildArticulation(humanoidData, { x: -1.5 });

    renderer = new Renderer(desk);
    renderer.buildBodyMeshes(sim.links, humanoidData.bodies);

    interact = new Interact(sim, desk, renderer);
    setupMenu();

    // Buddy API: spawn a sandboxed cell for every pack with a main script.
    initProtocol(packcat);
    cartMgr = new CartridgeManager(sim, desk, renderer, (msg) => {
        console.log('[buddy-api]', msg);
        try { window.go.main.App.LogError('[buddy-api] ' + msg); } catch (e) {}
    });
    interact.cartMgr = cartMgr;
    for (const p of packs) {
        try {
            const m = typeof p.manifest === 'string' ? JSON.parse(p.manifest) : p.manifest;
            if (m && m.main) cartMgr.spawn(p, m);
        } catch (e) {
            console.warn('pack manifest error:', p.name, e);
        }
    }

    // Backend event streams.
    window.runtime.EventsOn('cursor', c => interact.updateCursor(c));
    window.runtime.EventsOn('desktop', d => {
        desk.updateWindows(d.windows || []);
        const icons = d.icons || [];
        desk.updateIcons(iconColliders ? icons : []);
        // With icon collision off, still show icon rects in the debug view.
        renderer.setGhostBoxes(iconColliders ? [] : icons.map(r => desk.rectToBox(r)));
    });

    document.getElementById('overlay').style.display = 'none';
    running = true;
    lastSimTimestamp = performance.now();
    requestAnimationFrame(mainLoop);
    console.log('BuddyEngine running');
}

function resetBuddy() {
    renderer.removeBodyMeshes(sim.links);
    sim.removeArticulation();
    sim.buildArticulation(humanoidData, { x: 0 });
    renderer.buildBodyMeshes(sim.links, humanoidData.bodies);
    currentAction = null;
    resetGraceFrames = RESET_GRACE;
}

async function mainLoop(timestamp) {
    if (!running) return;

    const realDT = Math.min((timestamp - lastSimTimestamp) / 1000, 0.1);
    lastSimTimestamp = timestamp;
    simAccum += realDT;

    interact.update();

    // Behavior mode: strike at the mouse; drift into idle skills when the
    // cursor hasn't moved in a while.
    const idle = interact.idleSeconds();
    if (idle > IDLE_AFTER_S) {
        if (mode !== 'idle') { mode = 'idle'; policy.randomLatent(); }
        if (timestamp - lastIdleSkill > IDLE_NEW_SKILL_S * 1000) {
            policy.newLatentTarget();
            lastIdleSkill = timestamp;
        }
    } else if (mode !== 'strike') {
        mode = 'strike';
    }

    if (cartMgr) cartMgr.applyPendingPhysics();

    const maxSubstepsPerFrame = 8;
    let stepsThisFrame = 0;
    while (simAccum >= DT && stepsThisFrame < maxSubstepsPerFrame) {
        simAccum -= DT;
        stepsThisFrame++;
        physStepCount++;

        // The kinematic cursor body tracks the mouse at full sim rate.
        sim.moveTarget(interact.targetWorld(), DT);

        if (physStepCount >= POLICY_SUBSTEPS) {
            physStepCount = 0;

            try {
                const root = sim.rootPose();
                const supportZ = sim.supportHeightAt(root.pos[0], root.pos[2]);
                const obs = sim.buildObservation(supportZ);
                if (mode === 'strike') {
                    const taskObs = sim.buildTaskObs(supportZ);
                    currentAction = await policy.runStrike(obs, taskObs, humanoidData.obs_dim);
                } else {
                    policy.slerpLatent();
                    currentAction = await policy.runLatent(obs, humanoidData.obs_dim);
                }
                if (currentAction) sim.applyActions(currentAction);
            } catch (e) {
                console.error('Policy error:', e.message);
            }
        }

        interact.applyDragForce();
        sim.updateKinematics(DT); // sweep window/icon colliders with velocity
        sim.step();
    }

    // Auto-reset if the sim explodes or the buddy leaves the play volume,
    // and rescue any stray Buddy-API bodies (wisp & co).
    try {
        const halfW = desk.screenW / 2 / desk.ppm;
        const root = sim.rootPose();
        const rz = root.pos[2], rx = root.pos[0], ry = root.pos[1];
        if (resetGraceFrames > 0) resetGraceFrames--;
        else if (!isFinite(rz) || rz < -3 || rz > 90 || Math.abs(ry) > 6 ||
                 Math.abs(rx) > halfW + 3) {
            resetBuddy();
        }
        if (escapeCheck++ % 30 === 0) sim.rescueStrayBodies(halfW);
    } catch (e) {}

    renderer.updateMeshes(sim.links);
    if (cartMgr) {
        cartMgr.updateMirrors();
        const cw = interact.cursorWorld();
        cartMgr.pumpFrames(timestamp / 1000, realDT, {
            px: interact.cursor.x, py: interact.cursor.y,
            wx: cw.x, wz: cw.z,
            l: interact.cursor.l, r: interact.cursor.r,
        });
        if ((frameCounter = (frameCounter + 1) % 120) === 0) cartMgr.checkHealth();
    }
    renderer.syncDebug(sim.staticActors, sim.targetState.pos);
    renderer.render();
    requestAnimationFrame(mainLoop);
}
let frameCounter = 0;

// ---------------------------------------------------------------------------
// Context menu (right-click on the buddy)
// ---------------------------------------------------------------------------
function setupMenu() {
    const menu = document.getElementById('menu');

    interact.onRightClick = (cssX, cssY) => {
        menu.style.left = Math.min(cssX, window.innerWidth - 160) + 'px';
        menu.style.top = Math.min(cssY, window.innerHeight - 140) + 'px';
        menu.style.display = 'block';
        interact.menuOpen = true;
        interact.syncClickThrough();
    };

    const closeMenu = () => {
        menu.style.display = 'none';
        interact.menuOpen = false;
    };

    document.getElementById('menu-reset').addEventListener('click', () => {
        resetBuddy();
        closeMenu();
    });
    const iconsBtn = document.getElementById('menu-icons');
    const toggleIconColliders = () => {
        iconColliders = !iconColliders;
        if (!iconColliders) desk.updateIcons([]);
        iconsBtn.textContent = iconColliders ? 'Icon colliders: on' : 'Icon colliders: off';
    };
    iconsBtn.addEventListener('click', () => { toggleIconColliders(); closeMenu(); });
    const debugBtn = document.getElementById('menu-debug');
    const toggleDebug = () => {
        const v = !renderer.debugGroup.visible;
        renderer.setDebugVisible(v);
        debugBtn.textContent = v ? 'Debug colliders: on' : 'Debug colliders: off';
    };
    debugBtn.addEventListener('click', () => { toggleDebug(); closeMenu(); });

    // Tray menu commands from the backend.
    window.runtime.EventsOn('tray', (id) => {
        if (id === 'reset') resetBuddy();
        else if (id === 'debug') toggleDebug();
        else if (id === 'icons') toggleIconColliders();
    });
    document.getElementById('menu-quit').addEventListener('click', () => {
        window.go.main.App.Quit();
    });
    document.getElementById('menu-packs').addEventListener('click', async () => {
        const packs = await window.go.main.App.RefreshPacks();
        console.log('Workshop packs:', packs);
        alert(packs.length
            ? 'Workshop packs:\n' + packs.map(p => `- ${p.name} (${p.source})`).join('\n')
            : 'No workshop packs installed.\nDrop packs into the "workshop" folder next to BuddyEngine.exe or subscribe on Steam.');
        closeMenu();
    });
    document.getElementById('menu-close').addEventListener('click', closeMenu);

    // Clicking anywhere else closes the menu.
    document.addEventListener('mousedown', (e) => {
        if (interact.menuOpen && !menu.contains(e.target)) closeMenu();
    });
}

boot().catch(err => {
    setStatus('Error: ' + err.message);
    console.error(err);
});
