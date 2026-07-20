// BuddyEngine buddies on any page. The heavy lifting (PhysX, three.js,
// sandboxed buddy cells) runs inside overlay.html on the hosted demo site —
// injected here as a fullscreen, transparent, click-through iframe. Running
// it remotely keeps this extension trivial AND dodges extension-page CSP,
// which forbids the blob:/inline scripts the sandboxed buddy cells need.
//
// Input model (same as the native Win32 overlay): while click-through, we
// forward pointer positions into the iframe; when the engine reports the
// cursor is over a buddy, we flip the iframe's pointer-events on so it can
// take the drag/menu natively, and off again when the hover ends.

(() => {
    'use strict';
    if (window !== window.top) return;
    if (document.getElementById('__buddyengine_overlay')) return;

    const SITE = 'https://zalo.github.io';
    const OVERLAY_URL = SITE + '/BuddyEngine/overlay.html';

    // ?page=WxH tells the overlay the full page viewport: the engine's
    // world spans the page even while the iframe itself is form-fitted to
    // the buddies' bounding box (be.viewport messages below).
    const iframe = document.createElement('iframe');
    iframe.id = '__buddyengine_overlay';
    iframe.src = OVERLAY_URL + '?page=' + innerWidth + 'x' + innerHeight;
    iframe.setAttribute('aria-hidden', 'true');
    // Delegate the power-governor signal (main.js caps to 30fps under CPU
    // pressure); harmless where the page's own policy denies it.
    iframe.setAttribute('allow', 'compute-pressure');
    const baseStyle =
        'position:fixed; border:none; background:transparent;' +
        'pointer-events:none; z-index:2147483646; color-scheme:normal;';
    iframe.style.cssText = baseStyle + 'inset:0; width:100vw; height:100vh;';
    document.documentElement.appendChild(iframe);

    // Real page resizes (rotation, window resize) rebuild the world.
    const bootW = innerWidth, bootH = innerHeight;
    let reloadTimer = 0;
    window.addEventListener('resize', () => {
        if (Math.abs(innerWidth - bootW) < 80 && Math.abs(innerHeight - bootH) < 160) return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => location.reload(), 800);
    });

    const post = (msg) => {
        try { iframe.contentWindow && iframe.contentWindow.postMessage(msg, SITE); } catch (e) {}
    };

    // ---- cursor forwarding (page -> overlay, used while click-through) ----
    const fwd = (e) => post({
        t: 'be.cursor',
        x: e.clientX, y: e.clientY,
        l: (e.buttons & 1) !== 0, r: (e.buttons & 2) !== 0,
    });
    for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
        window.addEventListener(type, fwd, { passive: true, capture: true });
    }

    // ---- overlay -> page: click-through toggle + form-fit rect -----------
    window.addEventListener('message', (e) => {
        if (e.origin !== SITE || !e.data) return;
        if (e.data.t === 'be.clickthrough') {
            iframe.style.pointerEvents = e.data.enabled ? 'none' : 'auto';
        } else if (e.data.t === 'be.viewport') {
            // Shrink the iframe to the buddies' bounding box — most of the
            // page stops paying compositor fillrate for empty transparency.
            const n = (v, max) => Math.max(0, Math.min(Math.round(+v) || 0, max));
            iframe.style.inset = 'auto'; // shorthand resets left/top — clear it first
            iframe.style.left = n(e.data.x, innerWidth) + 'px';
            iframe.style.top = n(e.data.y, innerHeight) + 'px';
            iframe.style.width = n(e.data.w, innerWidth) + 'px';
            iframe.style.height = n(e.data.h, innerHeight) + 'px';
        }
    });

    // ---- page platforms: big visible elements become physics ledges -------
    let nextId = 1;
    const elIds = new WeakMap();
    function platformRects() {
        const found = [];
        const els = document.querySelectorAll('img, video, canvas, header, nav, footer, aside, table, iframe:not(#__buddyengine_overlay)');
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.height < 40) continue;              // slivers
            if (r.bottom < 0 || r.top > innerHeight * 0.95) continue;  // offscreen
            if (r.width > innerWidth * 0.98 && r.top < 8) continue;    // page-wide wrappers
            if (!elIds.has(el)) elIds.set(el, nextId++);
            found.push({ id: elIds.get(el), x: r.x, y: r.y, w: r.width, h: r.height, area: r.width * r.height });
        }
        // A dozen biggest is plenty; tiny ledge spam just jitters the sim.
        found.sort((a, b) => b.area - a.area);
        return found.slice(0, 12).map(({ area, ...r }) => r);
    }

    let scanQueued = false;
    function scan() {
        if (scanQueued) return;
        scanQueued = true;
        requestAnimationFrame(() => {
            scanQueued = false;
            post({ t: 'be.platforms', rects: platformRects() });
        });
    }
    window.addEventListener('scroll', scan, { passive: true, capture: true });
    window.addEventListener('resize', scan, { passive: true });
    setInterval(scan, 1500); // layout drift, lazy-loaded images, ...
    iframe.addEventListener('load', () => setTimeout(scan, 500));
})();
