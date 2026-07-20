// Form-fit: keep the host window hugging the buddies' bounding box
// (+ padding) instead of spanning the whole desktop/page, so empty
// transparent area stops paying compositor fillrate. Shared by the
// WebExtension overlay (content script resizes our iframe) and the native
// Windows overlay (Go moves the borderless window via SetWindowPos).
//
// The engine's world stays in full desktop/page coordinates; only the
// rendered window moves. Because styling the window and this document
// observing the new viewport are not synchronous, the camera/canvas (and
// the DOM-view cell iframe counter-offsets) are applied from OUR resize
// event — the same visual frame the new viewport appears in.

export function startFormFit({
    sim, desk, renderer, interact,
    pageW, pageH,                 // full desktop/page size, CSS px
    requestRect,                  // (rectCss) => ask the host to move/resize the window
    onRect = () => {},            // notified after a rect is actually applied
    padM = 1.3,                   // meters around each body (view canvases, bubbles)
    grid = 64,                    // quantize so resizes are rare
    minW = 320, minH = 280,       // menu + a buddy always fit
    intervalMs = 150,
}) {
    const DPR = window.devicePixelRatio || 1;
    const cur = { x: 0, y: 0, w: pageW, h: pageH };
    let pending = null;
    let pendingAt = 0;

    function fitRect() {
        const snap = sim.snapshotBodies();
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, n = 0;
        snap.ids.forEach((id, i) => {
            if (id === 'sys/target') return; // tracks the cursor, not a buddy
            const x = snap.buf[i * 13], z = snap.buf[i * 13 + 2];
            x0 = Math.min(x0, x - padM); x1 = Math.max(x1, x + padM);
            z0 = Math.min(z0, z - padM); z1 = Math.max(z1, z + padM);
            n++;
        });
        if (!n) return { x: 0, y: 0, w: pageW, h: pageH };
        // world -> CSS px (y flips: high z = small y)
        const tl = desk.toScreen(x0, z1), br = desk.toScreen(x1, z0);
        let rx = tl.x / DPR, ry = tl.y / DPR, rw = br.x / DPR - rx, rh = br.y / DPR - ry;
        rx = Math.floor(rx / grid) * grid;
        ry = Math.floor(ry / grid) * grid;
        rw = Math.ceil((rw + grid) / grid) * grid;
        rh = Math.ceil((rh + grid) / grid) * grid;
        rw = Math.max(rw, minW); rh = Math.max(rh, minH);
        rx = Math.max(0, Math.min(rx, pageW - rw));
        ry = Math.max(0, Math.min(ry, pageH - rh));
        rw = Math.min(rw, pageW - rx); rh = Math.min(rh, pageH - ry);
        return { x: rx, y: ry, w: rw, h: rh };
    }

    // DOM-view cells position content in desktop/page coords; counter-shift
    // their (page-sized) iframes so their pixels stay put.
    function offsetCellIframes() {
        for (const f of document.querySelectorAll('body > iframe')) {
            if (f.style.display === 'none') continue;
            const s = f.style;
            s.width = pageW + 'px';
            s.height = pageH + 'px';
            s.inset = 'auto'; // shorthand resets left/top — clear before setting
            s.left = -cur.x + 'px';
            s.top = -cur.y + 'px';
        }
    }

    function applyRect(r) {
        cur.x = r.x; cur.y = r.y; cur.w = r.w; cur.h = r.h;
        renderer.setViewportRect(r.x * DPR, r.y * DPR, r.w * DPR, r.h * DPR);
        offsetCellIframes();
        onRect({ ...cur });
    }

    const onResize = () => {
        if (pending && Math.abs(innerWidth - pending.w) <= 2 && Math.abs(innerHeight - pending.h) <= 2) {
            applyRect(pending);
            pending = null;
        }
    };
    window.addEventListener('resize', onResize);

    // The engine menu positions from full-space cursor coords; the menu DOM
    // lives in window space.
    const origRightClick = interact.onRightClick;
    if (origRightClick) {
        interact.onRightClick = (cssX, cssY) => origRightClick(cssX - cur.x, cssY - cur.y);
    }

    const timer = setInterval(() => {
        if (pending && performance.now() - pendingAt > 400) {
            // No resize event arrived. Either the host missed the request
            // (retry below), or the window was ALREADY at this size — e.g.
            // a native frontend reload into a still-fitted window — in
            // which case adopt it now.
            if (Math.abs(innerWidth - pending.w) <= 2 && Math.abs(innerHeight - pending.h) <= 2) {
                applyRect(pending);
            }
            pending = null;
        }
        if (pending) return;
        const r = fitRect();
        if (r.x === cur.x && r.y === cur.y && r.w === cur.w && r.h === cur.h) {
            offsetCellIframes(); // a late view.show may have reset styles
            return;
        }
        const sameSize = r.w === cur.w && r.h === cur.h;
        pending = r;
        pendingAt = performance.now();
        try { requestRect(r); } catch (e) { pending = null; return; }
        if (sameSize) {
            // Pure translation: the viewport dimensions don't change, so no
            // resize event will ever fire — apply immediately (the padding
            // hides the sub-frame skew between window move and camera pan).
            applyRect(r);
            pending = null;
        }
    }, intervalMs);

    return {
        rect: cur,
        stop() {
            clearInterval(timer);
            window.removeEventListener('resize', onResize);
        },
    };
}
