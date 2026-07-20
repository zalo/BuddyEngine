// Form-fit: keep the host window hugging the buddies' bounding box
// (+ margin) instead of spanning the whole desktop/page, so empty
// transparent area stops paying compositor fillrate. Shared by the
// WebExtension overlay (content script resizes our iframe) and the native
// Windows overlay (Go moves the borderless window via SetWindowPos).
//
// Fit: every body and articulation link contributes its actual bounding
// radius (sim.hoverTargets) plus a small margin — not a flat per-body pad —
// so the union tracks the buddies tightly. With debug colliders on, each
// contributing box is drawn (cyan) so an outlier is easy to spot.
//
// Transition order (window hosts apply our rect asynchronously):
//   frame N:   resize canvas + shift camera to the NEW rect, and CSS-shift
//              the canvas by the rect delta so the world stays glued to the
//              desktop inside the still-old window;
//   frame N+1: ask the host to move/resize the window;
//   adoption:  when our resize event shows the new size (or the next frame,
//              for translation-only moves that fire no resize), drop the
//              CSS shift and re-anchor the DOM-view cell iframes.
// Camera first, window after — the scene never lags the window.

export function startFormFit({
    sim, desk, renderer, interact,
    pageW, pageH,                 // full desktop/page size, CSS px
    requestRect,                  // (rectCss) => ask the host to move/resize the window
    onRect = () => {},            // notified after a rect is fully adopted
    marginM = 0.45,               // meters beyond each body's bounding radius
    grid = 64,                    // quantize so resizes are rare
    minW = 320, minH = 280,       // menu + a buddy always fit
    intervalMs = 150,
}) {
    const DPR = window.devicePixelRatio || 1;
    const canvasEl = renderer.renderer.domElement;
    const cur = { x: 0, y: 0, w: pageW, h: pageH };
    let pending = null;
    let pendingAt = 0;

    function fitRect() {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        const boxes = [];
        for (const t of sim.hoverTargets()) {
            if (t.id.startsWith('sys/')) continue;
            let px, pz;
            try {
                const p = t.actor.getGlobalPose().get_p();
                px = p.get_x(); pz = p.get_z();
            } catch (e) { continue; }
            const r = (t.radius || 0.1) + marginM;
            boxes.push({ x0: px - r, z0: pz - r, x1: px + r, z1: pz + r });
            x0 = Math.min(x0, px - r); x1 = Math.max(x1, px + r);
            z0 = Math.min(z0, pz - r); z1 = Math.max(z1, pz + r);
        }
        renderer.setDebugFitBoxes(renderer.debugGroup.visible ? boxes : []);
        if (!boxes.length) return { x: 0, y: 0, w: pageW, h: pageH };
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

    // Phase 1: camera + canvas now, glued into the still-old window.
    function beginTransition(r) {
        renderer.setViewportRect(r.x * DPR, r.y * DPR, r.w * DPR, r.h * DPR);
        canvasEl.style.transform = `translate(${r.x - cur.x}px, ${r.y - cur.y}px)`;
    }

    // Phase 2 complete: the window is at r.
    function finalize(r) {
        cur.x = r.x; cur.y = r.y; cur.w = r.w; cur.h = r.h;
        canvasEl.style.transform = '';
        offsetCellIframes();
        onRect({ ...cur });
        pending = null;
    }

    // The host never applied the rect: put the camera back.
    function rollback() {
        renderer.setViewportRect(cur.x * DPR, cur.y * DPR, cur.w * DPR, cur.h * DPR);
        canvasEl.style.transform = '';
        pending = null;
    }

    const onResize = () => {
        if (pending && Math.abs(innerWidth - pending.w) <= 2 && Math.abs(innerHeight - pending.h) <= 2) {
            finalize(pending);
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
            // No resize event arrived. Either the window was already at this
            // size (native frontend reload into a fitted overlay) — adopt —
            // or the host missed the request — roll the camera back.
            if (Math.abs(innerWidth - pending.w) <= 2 && Math.abs(innerHeight - pending.h) <= 2) {
                finalize(pending);
            } else {
                rollback();
            }
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
        beginTransition(r);
        requestAnimationFrame(() => {
            if (pending !== r) return;
            try { requestRect(r); } catch (e) { rollback(); return; }
            if (sameSize) {
                // Translation-only: no resize event will ever fire; the host
                // applies within a frame.
                requestAnimationFrame(() => { if (pending === r) finalize(r); });
            }
        });
    }, intervalMs);

    return {
        rect: cur,
        stop() {
            clearInterval(timer);
            window.removeEventListener('resize', onResize);
            renderer.setDebugFitBoxes([]);
        },
    };
}
