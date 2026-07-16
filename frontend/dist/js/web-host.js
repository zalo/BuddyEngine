// Browser stand-in for the Wails/Go backend, so the unmodified host
// (js/main.js) runs on a static site (GitHub Pages). Provides:
//   - window.go.main.App.*  (bootstrap, pack files over fetch, no-op shell)
//   - window.runtime.EventsOn with 'cursor' / 'desktop' streams synthesized
//     from DOM pointer events and the draggable XP windows
//   - the XP desktop chrome behavior (window dragging, start menu, clock)
// Works with mouse and touch; on coarse-pointer devices the world is scaled
// up and the default pack set trimmed.

const DPR = window.devicePixelRatio || 1;
const IS_MOBILE = matchMedia('(pointer: coarse)').matches;
const TASKBAR_CSS = IS_MOBILE ? 44 : 36;
const PPM = (IS_MOBILE ? 90 : 140) * DPR;

// Excluded by default (still available via ?packs=): sm64 needs a
// user-supplied ROM that never ships; stickman is a bit of a menace.
const WEB_EXCLUDED = new Set(['sm64', 'stickman']);
const FALLBACK_PACKS = ['swordfighter', 'kirby', 'wisp', 'live2d', 'interactive-buddy'];

async function packList() {
    const param = new URLSearchParams(location.search).get('packs');
    if (param !== null) {
        return param.split(',').map(s => s.trim()).filter(Boolean);
    }
    let ids = FALLBACK_PACKS;
    try {
        const r = await fetch('./packs-index.json');
        if (r.ok) ids = await r.json();
    } catch (e) { /* fall back */ }
    return ids.filter(id => !WEB_EXCLUDED.has(id));
}

// ---------------------------------------------------------------------------
// window.runtime — event streams
// ---------------------------------------------------------------------------
const listeners = new Map(); // event -> [cb]
window.runtime = {
    EventsOn(name, cb) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(cb);
    },
    EventsOff() {},
};
function emit(name, payload) {
    for (const cb of listeners.get(name) || []) cb(payload);
}

// ---------------------------------------------------------------------------
// window.go.main.App — backend API
// ---------------------------------------------------------------------------
const packs = (await packList()).map(id => ({ id, name: id, source: 'web' }));

function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
}

window.go = { main: { App: {
    async GetBootstrap() {
        return {
            screenW: Math.round(innerWidth * DPR),
            screenH: Math.round(innerHeight * DPR),
            workBottom: Math.round((innerHeight - TASKBAR_CSS) * DPR),
            ppm: PPM,
            debugOff: true,
            packs,
        };
    },
    async ReadPackFile(packId, rel) {
        const r = await fetch(`./packs/${packId}/${rel}`);
        if (!r.ok) throw new Error(`pack file missing: ${packId}/${rel}`);
        return bufToB64(await r.arrayBuffer());
    },
    // Binary fast path (cartridges prefers it): no base64 round-trip, no
    // main-thread stalls on multi-MB pack assets.
    async ReadPackBytes(packId, rel) {
        const r = await fetch(`./packs/${packId}/${rel}`);
        if (!r.ok) throw new Error(`pack file missing: ${packId}/${rel}`);
        return r.arrayBuffer();
    },
    async RefreshPacks() { return packs; },
    SetClickThrough() {},
    Heartbeat() {},
    LogError() {}, // host already mirrors everything to console.log
    Quit() { location.reload(); },
} } };

// ---------------------------------------------------------------------------
// Cursor stream from DOM pointer events (mouse + touch)
// ---------------------------------------------------------------------------
const cursor = { x: 0, y: 0, l: false, r: false };
let uiPointer = false; // pointer went down on chrome/UI — don't grab buddies

function isUiTarget(t) {
    return !!(t && t.closest && t.closest('.xp-titlebar, #xp-taskbar, #menu, #overlay'));
}
function pushCursor(e, buttons) {
    cursor.x = e.clientX * DPR;
    cursor.y = e.clientY * DPR;
    if (buttons !== undefined && !uiPointer) {
        cursor.l = !!(buttons & 1);
        cursor.r = !!(buttons & 2);
    }
    emit('cursor', { ...cursor });
}
window.addEventListener('pointerdown', (e) => {
    uiPointer = isUiTarget(e.target);
    pushCursor(e, e.buttons);
});
window.addEventListener('pointermove', (e) => pushCursor(e, e.buttons));
window.addEventListener('pointerup', (e) => {
    pushCursor(e, e.buttons);
    if (!e.buttons) uiPointer = false;
});
window.addEventListener('pointercancel', () => {
    cursor.l = false; cursor.r = false; uiPointer = false;
    emit('cursor', { ...cursor });
});
// The engine has its own right-click menu.
window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// XP chrome: draggable windows -> 'desktop' collider stream
// ---------------------------------------------------------------------------
const xpWindows = [...document.querySelectorAll('.xp-window')];

function placeInitialWindows() {
    const W = innerWidth, H = innerHeight - TASKBAR_CSS;
    const spots = IS_MOBILE
        ? [{ x: 0.06, y: 0.16, w: 0.88 }, { x: 0.12, y: 0.55, w: 0.7 }]
        : [{ x: 0.08, y: 0.18, w: 0.26 }, { x: 0.55, y: 0.42, w: 0.22 }];
    xpWindows.forEach((el, i) => {
        const s = spots[i % spots.length];
        el.style.left = Math.round(W * s.x) + 'px';
        el.style.top = Math.round(H * s.y) + 'px';
        el.style.width = Math.round(W * s.w) + 'px';
    });
    if (IS_MOBILE && xpWindows[1]) xpWindows[1].style.display = 'none';
}

function emitDesktop() {
    // Topmost-first, like the Win32 tracker (later-dragged = higher).
    const wins = xpWindows
        .filter(el => el.style.display !== 'none')
        .sort((a, b) => (+b.style.zIndex || 1) - (+a.style.zIndex || 1))
        .map(el => {
            const r = el.getBoundingClientRect();
            return {
                hwnd: +el.dataset.hwnd,
                x: r.x * DPR, y: r.y * DPR, w: r.width * DPR, h: r.height * DPR,
            };
        });
    emit('desktop', { windows: wins, icons: [] });
}

let topZ = 1;
for (const el of xpWindows) {
    const bar = el.querySelector('.xp-titlebar');
    bar.addEventListener('pointerdown', (e) => {
        el.style.zIndex = String(++topZ);
        const r = el.getBoundingClientRect();
        const off = { x: e.clientX - r.x, y: e.clientY - r.y };
        bar.setPointerCapture(e.pointerId);
        const move = (ev) => {
            el.style.left = Math.round(Math.min(Math.max(ev.clientX - off.x, -r.width * 0.6), innerWidth - 40)) + 'px';
            el.style.top = Math.round(Math.min(Math.max(ev.clientY - off.y, 0), innerHeight - TASKBAR_CSS - 20)) + 'px';
            emitDesktop();
        };
        const up = () => {
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', up);
            bar.removeEventListener('pointercancel', up);
            emitDesktop();
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
    });
}

// Start button toggles the engine menu (mobile-friendly path to it).
document.getElementById('xp-start').addEventListener('click', () => {
    const menu = document.getElementById('menu');
    const open = menu.style.display === 'block';
    menu.style.display = open ? 'none' : 'block';
    if (!open) {
        menu.style.left = '8px';
        menu.style.top = (innerHeight - TASKBAR_CSS - menu.offsetHeight - 8) + 'px';
    }
});

function tickClock() {
    const d = new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    document.getElementById('xp-clock').textContent =
        `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}
tickClock();
setInterval(tickClock, 30000);

document.documentElement.style.setProperty('--xp-taskbar-h', TASKBAR_CSS + 'px');
placeInitialWindows();

// The world is built once for the boot-time screen size; rebuild on real
// resizes (ignore mobile URL-bar jitter).
const bootW = innerWidth, bootH = innerHeight;
let resizeTimer = 0;
window.addEventListener('resize', () => {
    if (Math.abs(innerWidth - bootW) < 80 && Math.abs(innerHeight - bootH) < 160) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => location.reload(), 600);
});

// Boot-time responsiveness telemetry: log the worst main-thread stall while
// packs load, so asset-pipeline regressions show up in the console.
(() => {
    let last = performance.now(), worst = 0;
    const tick = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        if (now < 30000) requestAnimationFrame(tick);
        else console.log(`[web-host] worst main-thread stall during boot: ${worst.toFixed(0)}ms`);
    };
    requestAnimationFrame(tick);
})();

// ---------------------------------------------------------------------------
// Boot the unmodified host, then layer its canvas into the XP stack
// ---------------------------------------------------------------------------
await import('./main.js');

const layerCanvas = setInterval(() => {
    const cv = document.querySelector('body > canvas');
    if (!cv || !(listeners.get('desktop') || []).length) return;
    clearInterval(layerCanvas);
    cv.classList.add('buddy-engine-canvas');
    cv.style.pointerEvents = 'none'; // input is handled at window level
    emitDesktop(); // initial window platforms once listeners exist
}, 50);
