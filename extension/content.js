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

    const iframe = document.createElement('iframe');
    iframe.id = '__buddyengine_overlay';
    iframe.src = OVERLAY_URL;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
        'position:fixed; inset:0; width:100vw; height:100vh; border:none;' +
        'background:transparent; pointer-events:none; z-index:2147483646;' +
        'color-scheme:normal;';
    document.documentElement.appendChild(iframe);

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

    // ---- click-through toggle (overlay -> page) ---------------------------
    window.addEventListener('message', (e) => {
        if (e.origin !== SITE || !e.data) return;
        if (e.data.t === 'be.clickthrough') {
            iframe.style.pointerEvents = e.data.enabled ? 'none' : 'auto';
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
