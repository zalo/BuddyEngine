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
    probePos = null,              // optional () => ({x, y}) CSS: where the host says the window IS
    marginM = 0.45,               // meters beyond each body's bounding radius
    grid = 64,                    // quantize so resizes are rare
    minW = 160, minH = 100,       // content-scale floor; the menu gets its own boost
    intervalMs = 150,
}) {
    const DPR = window.devicePixelRatio || 1;
    const canvasEl = renderer.renderer.domElement;
    // Never extend past the ground line (taskbar top on the native desktop,
    // page bottom elsewhere) — buddies can't be below it, so window area
    // there is pure waste and would cover the taskbar.
    const maxY = Math.min(pageH, desk.groundPy / DPR);
    const zFloor = -0.05; // world ground, small tolerance for sprite feet
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
            // Clamp each box at the ground: padding below a standing buddy's
            // feet would only drag the window down over the taskbar.
            const bz0 = Math.max(pz - r, zFloor);
            boxes.push({ x0: px - r, z0: bz0, x1: px + r, z1: pz + r });
            x0 = Math.min(x0, px - r); x1 = Math.max(x1, px + r);
            z0 = Math.min(z0, bz0); z1 = Math.max(z1, pz + r);
        }
        renderer.setDebugFitBoxes(renderer.debugGroup.visible ? boxes : []);
        if (!boxes.length) return { x: 0, y: 0, w: pageW, h: maxY };
        // world -> CSS px (y flips: high z = small y)
        const tl = desk.toScreen(x0, z1), br = desk.toScreen(x1, z0);
        // Horizontal: quantize both edges outward.
        let rx = Math.floor(tl.x / DPR / grid) * grid;
        let rw = Math.ceil((br.x / DPR - tl.x / DPR + grid) / grid) * grid;
        rw = Math.max(rw, minW);
        rx = Math.max(0, Math.min(rx, pageW - rw));
        rw = Math.min(rw, pageW - rx);
        // Vertical: the bottom hugs the content exactly (usually the ground
        // line); only the top edge is quantized, so grid slack becomes jump
        // headroom instead of dead space below the buddies' feet.
        // Fine-quantized so idle bobbing doesn't churn resizes; standing on
        // the ground it clamps to the taskbar line exactly.
        const yBottom = Math.min(Math.ceil(br.y / DPR / 16) * 16, maxY);
        let ry = Math.floor(tl.y / DPR / grid) * grid;
        if (yBottom - ry < minH) ry = yBottom - minH;
        ry = Math.max(0, ry);
        return { x: rx, y: ry, w: rw, h: Math.max(1, Math.round(yBottom - ry)) };
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
        // An open menu is positioned in window coordinates — keep it pinned
        // to the same screen spot across the origin change (menu boost).
        if (interact.menuOpen) {
            const menu = document.getElementById('menu');
            if (menu && menu.style.display === 'block') {
                menu.style.left = (parseFloat(menu.style.left || '0') + (cur.x - r.x)) + 'px';
                menu.style.top = (parseFloat(menu.style.top || '0') + (cur.y - r.y)) + 'px';
            }
        }
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
    // lives in window space. Remember where it opened so the menu boost can
    // grow the window around it.
    let lastMenuAt = null;
    const origRightClick = interact.onRightClick;
    if (origRightClick) {
        interact.onRightClick = (cssX, cssY) => {
            lastMenuAt = { x: cssX, y: cssY };
            origRightClick(cssX - cur.x, cssY - cur.y);
        };
    }

    // Issue a rect through the two-phase transition.
    function requestTransition(r) {
        const sameSize = r.w === cur.w && r.h === cur.h;
        pending = r;
        pendingAt = performance.now();
        beginTransition(r);
        requestAnimationFrame(() => {
            if (pending !== r) return;
            try { requestRect(r); } catch (e) { rollback(); return; }
            if (sameSize) {
                if (probePos) {
                    const t0 = performance.now();
                    const poll = () => {
                        if (pending !== r) return;
                        let p = null;
                        try { p = probePos(); } catch (e) {}
                        if (p && Math.abs(p.x - r.x) <= 3 && Math.abs(p.y - r.y) <= 3) return finalize(r);
                        if (performance.now() - t0 > 500) return finalize(r);
                        requestAnimationFrame(poll);
                    };
                    requestAnimationFrame(poll);
                } else {
                    requestAnimationFrame(() => { if (pending === r) finalize(r); });
                }
            }
        });
    }

    let menuBoosted = false;
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

        // While the menu is open the window must not slide out from under
        // it. On open, grow once to guarantee the menu fits; then hold.
        if (interact.menuOpen) {
            if (!menuBoosted && lastMenuAt) {
                menuBoosted = true;
                const mw = 190, mh = 250; // menu + margin
                const mx = Math.max(0, Math.min(lastMenuAt.x - 10, pageW - mw));
                const my = Math.max(0, Math.min(lastMenuAt.y - 10, maxY - mh));
                const x0 = Math.min(cur.x, mx), y0 = Math.min(cur.y, my);
                const r = {
                    x: x0, y: y0,
                    w: Math.max(cur.x + cur.w, mx + mw) - x0,
                    h: Math.max(cur.y + cur.h, my + mh) - y0,
                };
                if (r.x !== cur.x || r.y !== cur.y || r.w !== cur.w || r.h !== cur.h) {
                    requestTransition(r);
                }
            }
            return;
        }
        menuBoosted = false;

        const r = fitRect();
        if (r.x === cur.x && r.y === cur.y && r.w === cur.w && r.h === cur.h) {
            offsetCellIframes(); // a late view.show may have reset styles
            return;
        }
        requestTransition(r);
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
