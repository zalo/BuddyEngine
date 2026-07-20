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

// Embedded form-fit mode: the content script passes the page viewport via
// ?page=WxH and then keeps our iframe resized to the buddies' bounding box
// (be.viewport messages we send it). The engine's world stays in full-page
// coordinates; only the rendered window moves. Standalone (no parent /
// no param) stays fullscreen.
const pageParam = /^(\d+)x(\d+)$/.exec(new URLSearchParams(location.search).get('page') || '');
const EMBEDDED = window.parent !== window && !!pageParam;
const PAGE_W = EMBEDDED ? +pageParam[1] : innerWidth;   // CSS px
const PAGE_H = EMBEDDED ? +pageParam[2] : innerHeight;
// Where our window currently sits on the page (CSS px, page coords).
const curRect = { x: 0, y: 0, w: PAGE_W, h: PAGE_H };

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
            screenW: Math.round(PAGE_W * DPR),
            screenH: Math.round(PAGE_H * DPR),
            workBottom: Math.round(PAGE_H * DPR), // ground = viewport bottom
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
// Our own DOM events are window-local; the engine works in page coords.
const ownCursor = (e) =>
    pushCursor(e.clientX + curRect.x, e.clientY + curRect.y, !!(e.buttons & 1), !!(e.buttons & 2));
window.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#menu')) return;
    ownCursor(e);
});
window.addEventListener('pointermove', ownCursor);
window.addEventListener('pointerup', ownCursor);
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

// Standalone only: rebuild on real viewport changes (rotation, window
// resize). Embedded windows resize constantly by design — the content
// script owns page-rotation reloads there.
if (!EMBEDDED) {
    const bootW = innerWidth, bootH = innerHeight;
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        if (Math.abs(innerWidth - bootW) < 80 && Math.abs(innerHeight - bootH) < 160) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => location.reload(), 600);
    });
}

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

// Form-fit (shared logic in formfit.js): keep the iframe hugging the
// buddies instead of covering the page; the parent applies be.viewport
// rects, and the module applies camera + cell-iframe offsets on our own
// resize event. Started once the engine handles exist.
if (EMBEDDED) {
    const { startFormFit } = await import('./formfit.js');
    const waitBoot = setInterval(() => {
        const dbg = window.buddyDebug;
        if (!dbg) return;
        clearInterval(waitBoot);
        startFormFit({
            sim: dbg.sim,
            desk: dbg.desk,
            renderer: dbg.renderer,
            interact: dbg.interact,
            pageW: PAGE_W,
            pageH: PAGE_H,
            requestRect: (r) => parent.postMessage({ t: 'be.viewport', ...r }, '*'),
            onRect: (r) => { curRect.x = r.x; curRect.y = r.y; curRect.w = r.w; curRect.h = r.h; },
        });
    }, 200);
}
