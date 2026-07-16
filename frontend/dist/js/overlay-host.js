// Embedded overlay mode: the whole engine runs inside a transparent,
// pointer-events:none iframe that a WebExtension content script injects
// into arbitrary pages (see extension/). Same idea as web-host.js, minus
// the XP chrome — the host page IS the desktop:
//   - cursor: forwarded by the content script via postMessage while the
//     iframe is click-through; our own DOM listeners take over whenever
//     the extension flips the iframe interactive
//   - SetClickThrough: postMessage back to the content script, which
//     toggles the iframe's pointer-events (the Wails overlay model, ported)
//   - 'desktop' colliders: page element rects (images, headers, ...)
//     scanned and streamed in by the content script — buddies stand on
//     the page's content
// Messages are validated by shape only (t: 'be.*'); they carry input
// coordinates and rects, nothing sensitive, and act on nothing but physics.

const DPR = window.devicePixelRatio || 1;
const IS_MOBILE = matchMedia('(pointer: coarse)').matches;
const PPM = (IS_MOBILE ? 90 : 140) * DPR;

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
const listeners = new Map();
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
// window.go.main.App
// ---------------------------------------------------------------------------
const packs = (await packList()).map(id => ({ id, name: id, source: 'web' }));

window.go = { main: { App: {
    async GetBootstrap() {
        return {
            screenW: Math.round(innerWidth * DPR),
            screenH: Math.round(innerHeight * DPR),
            workBottom: Math.round(innerHeight * DPR), // ground = viewport bottom
            ppm: PPM,
            debugOff: true,
            packs,
        };
    },
    async ReadPackBytes(packId, rel) {
        const r = await fetch(`./packs/${packId}/${rel}`);
        if (!r.ok) throw new Error(`pack file missing: ${packId}/${rel}`);
        return r.arrayBuffer();
    },
    async RefreshPacks() { return packs; },
    // The one real backend call in overlay mode: interact's hover state
    // drives the content script's iframe pointer-events toggle, exactly
    // like the Win32 overlay's click-through.
    SetClickThrough(enabled) {
        try { parent.postMessage({ t: 'be.clickthrough', enabled: !!enabled }, '*'); } catch (e) {}
    },
    Heartbeat() {},
    LogError() {},
    Quit() { location.reload(); },
} } };

// ---------------------------------------------------------------------------
// Cursor: parent messages while click-through, own DOM events while
// interactive — both feed the same stream.
// ---------------------------------------------------------------------------
const cursor = { x: 0, y: 0, l: false, r: false };
function pushCursor(cssX, cssY, l, r) {
    cursor.x = cssX * DPR;
    cursor.y = cssY * DPR;
    if (l !== undefined) cursor.l = l;
    if (r !== undefined) cursor.r = r;
    emit('cursor', { ...cursor });
}
window.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#menu')) return;
    pushCursor(e.clientX, e.clientY, !!(e.buttons & 1), !!(e.buttons & 2));
});
window.addEventListener('pointermove', (e) => pushCursor(e.clientX, e.clientY, !!(e.buttons & 1), !!(e.buttons & 2)));
window.addEventListener('pointerup', (e) => pushCursor(e.clientX, e.clientY, !!(e.buttons & 1), !!(e.buttons & 2)));
window.addEventListener('pointercancel', () => pushCursor(cursor.x / DPR, cursor.y / DPR, false, false));
window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d.t !== 'string') return;
    if (d.t === 'be.cursor') {
        pushCursor(+d.x || 0, +d.y || 0, !!d.l, !!d.r);
    } else if (d.t === 'be.platforms' && Array.isArray(d.rects)) {
        emit('desktop', {
            windows: d.rects.slice(0, 12).map(r => ({
                hwnd: 'pg' + r.id,
                x: r.x * DPR, y: r.y * DPR, w: r.w * DPR, h: r.h * DPR,
            })),
            icons: [],
        });
        // Ack with the count so the content script (and anyone debugging an
        // install) can tell the platform stream is being consumed.
        try { parent.postMessage({ t: 'be.platforms.ack', n: d.rects.length }, '*'); } catch (err) {}
    }
});

// Rebuild on real viewport changes (rotation, window resize).
const bootW = innerWidth, bootH = innerHeight;
let resizeTimer = 0;
window.addEventListener('resize', () => {
    if (Math.abs(innerWidth - bootW) < 80 && Math.abs(innerHeight - bootH) < 160) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => location.reload(), 600);
});

// ---------------------------------------------------------------------------
// Boot the unmodified host
// ---------------------------------------------------------------------------
await import('./main.js');

const layerCanvas = setInterval(() => {
    const cv = document.querySelector('body > canvas');
    if (!cv) return;
    clearInterval(layerCanvas);
    cv.style.position = 'fixed';
    cv.style.inset = '0';
    cv.style.pointerEvents = 'none';
    // Tell the content script we're alive (it can hide any placeholder).
    try { parent.postMessage({ t: 'be.ready' }, '*'); } catch (e) {}
}, 50);
