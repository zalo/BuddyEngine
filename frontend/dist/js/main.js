// BuddyEngine host bootstrap + main loop. The host is a pure engine:
// PhysX world, desktop colliders, transparent renderer, input routing and
// the Buddy API runtime. Characters (including the default swordfighter)
// are workshop packs running in sandboxed cells.

import { SimWorld, DT } from './sim.js';
import { Renderer } from './render.js';
import { Desk } from './desk.js';
import { Interact } from './interact.js';
import { initProtocol } from './api/protocol.js';
import { CartridgeManager } from './api/cartridges.js';
import * as packcat from '../vendor/packcat.js';

let sim, desk, renderer, interact, cartMgr;
let running = false;
let simAccum = 0;
let lastSimTimestamp = 0;
let iconColliders = false; // off by default; toggle in the buddy/tray menu
let escapeCheck = 0;
let frameCounter = 0;

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
// Beat only while the main loop is actually ticking — if the sim dies (e.g.
// a WASM abort), beats stop and the Go watchdog reloads the frontend.
let lastLoopTs = performance.now();
setInterval(() => {
    if (performance.now() - lastLoopTs > 4000) return;
    try { window.go.main.App.Heartbeat(); } catch (e) {}
}, 1000);

async function boot() {
    setStatus('Connecting to backend...');
    const bootstrap = await window.go.main.App.GetBootstrap();

    setStatus('Initializing PhysX...');
    sim = new SimWorld();
    await sim.init();

    setStatus('Building world...');
    desk = new Desk(sim, {
        screenW: bootstrap.screenW,
        screenH: bootstrap.screenH,
        workBottom: bootstrap.workBottom,
        ppm: bootstrap.ppm || 140,
    });
    desk.createStaticEnvironment();
    sim.createTarget();

    renderer = new Renderer(desk);
    if (bootstrap.debugOff) renderer.setDebugVisible(false);
    interact = new Interact(sim, desk, renderer);
    setupMenu();

    // Buddy API: spawn a sandboxed cell for every pack with a main script.
    initProtocol(packcat);
    cartMgr = new CartridgeManager(sim, desk, renderer, (msg) => {
        console.log('[buddy-api]', msg);
        logToBackend('[buddy-api] ' + msg);
    });
    interact.cartMgr = cartMgr;

    // Every discovered pack is a folder with a main.js — spawn them all,
    // one at a time: cells share the main thread, so booting every pack at
    // once compounds their load work into one long freeze. Each spawn waits
    // for the previous cell to finish evaluating (harness 'booted' signal)
    // or a timeout, while the world keeps running.
    const packs = bootstrap.packs || [];
    (async () => {
        for (const p of packs) {
            try {
                const id = await cartMgr.spawn(p);
                const t0 = performance.now();
                while (performance.now() - t0 < 8000) {
                    const cell = cartMgr.cells.get(id);
                    if (!cell || cell.booted) break;
                    await new Promise(r => setTimeout(r, 120));
                }
            } catch (e) {
                logToBackend('spawn ' + p.id + ' failed: ' + e.message);
            }
        }
    })();
    if (packs.length === 0) {
        logToBackend('no packs found — drop pack folders (containing main.js) into the workshop folder');
    }

    // Backend event streams.
    window.runtime.EventsOn('cursor', c => interact.updateCursor(c));
    window.runtime.EventsOn('desktop', d => {
        desk.updateWindows(d.windows || []);
        const icons = d.icons || [];
        desk.updateIcons(iconColliders ? icons : []);
        renderer.setGhostBoxes(iconColliders ? [] : icons.map(r => desk.rectToBox(r)));
    });

    // Host-page debug handle (no pack code ever runs in this context).
    window.buddyDebug = { sim, desk, renderer, interact, cartMgr };

    document.getElementById('overlay').style.display = 'none';
    running = true;
    lastSimTimestamp = performance.now();
    requestAnimationFrame(mainLoop);
    console.log('BuddyEngine host running,', packs.length, 'buddy cell(s) spawning');
}

function mainLoop(timestamp) {
    if (!running) return;
    lastLoopTs = performance.now();

    const realDT = Math.min((timestamp - lastSimTimestamp) / 1000, 0.1);
    lastSimTimestamp = timestamp;
    simAccum += realDT;

    interact.update();
    if (cartMgr) cartMgr.applyPendingPhysics();

    const maxSubstepsPerFrame = 8;
    let stepsThisFrame = 0;
    while (simAccum >= DT && stepsThisFrame < maxSubstepsPerFrame) {
        simAccum -= DT;
        stepsThisFrame++;

        // The kinematic cursor body tracks the mouse at full sim rate.
        sim.moveTarget(interact.targetWorld(), DT);

        interact.applyDragForce();
        sim.updateKinematics(DT); // sweep window/icon colliders with velocity
        sim.step();
    }

    // Escape net for articulations and buddy bodies.
    if (escapeCheck++ % 30 === 0) {
        try {
            const rescued = sim.rescueStrays(desk.screenW / 2 / desk.ppm);
            if (rescued > 0) console.log('rescued', rescued, 'stray bodies');
        } catch (e) {}
    }

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

// ---------------------------------------------------------------------------
// Context menu (right-click on a buddy) + tray commands
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

    const resetBuddies = () => { if (cartMgr) cartMgr.resetArticulations(); };

    document.getElementById('menu-reset').addEventListener('click', () => {
        resetBuddies();
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

    window.runtime.EventsOn('tray', (id) => {
        if (id === 'reset') resetBuddies();
        else if (id === 'debug') toggleDebug();
        else if (id === 'icons') toggleIconColliders();
    });

    document.getElementById('menu-packs').addEventListener('click', async () => {
        const packs = await window.go.main.App.RefreshPacks();
        alert(packs.length
            ? 'Workshop packs:\n' + packs.map(p => `- ${p.name} (${p.source})`).join('\n')
            : 'No workshop packs installed.\nDrop packs into the "workshop" folder next to BuddyEngine.exe or subscribe on Steam.');
        closeMenu();
    });
    document.getElementById('menu-quit').addEventListener('click', () => {
        window.go.main.App.Quit();
    });
    document.getElementById('menu-close').addEventListener('click', closeMenu);

    document.addEventListener('mousedown', (e) => {
        if (interact.menuOpen && !menu.contains(e.target)) closeMenu();
    });
}

boot().catch(err => {
    setStatus('Error: ' + err.message);
    logToBackend('boot error: ' + (err.stack || err.message));
    console.error(err);
});
