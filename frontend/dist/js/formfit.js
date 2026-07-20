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
    marginM = 0.15,               // meters beyond each body's extents
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
        for (const t of sim.fitTargets()) {
            if (t.id.startsWith('sys/')) continue;
            let px, pz, hx = t.hx || 0.1, hz = t.hz || 0.1;
            try {
                const pose = t.actor.getGlobalPose();
                const p = pose.get_p();
                px = p.get_x(); pz = p.get_z();
                if (!t.round && hx !== hz) {
                    // Rotation-aware AABB of the shape's footprint (buddy
                    // bodies spin around the depth axis; exact for that,
                    // conservative enough for anything else).
                    const q = pose.get_q();
                    const th = 2 * Math.atan2(q.get_y(), q.get_w());
                    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
                    const ax = hx * c + hz * s, az = hx * s + hz * c;
                    hx = ax; hz = az;
                }
            } catch (e) { continue; }
            hx += marginM; hz += marginM;
            // Clamp each box at the ground: padding below a standing buddy's
            // feet would only drag the window down over the taskbar.
            const bz0 = Math.max(pz - hz, zFloor);
            boxes.push({ x0: px - hx, z0: bz0, x1: px + hx, z1: pz + hz });
            x0 = Math.min(x0, px - hx); x1 = Math.max(x1, px + hx);
            z0 = Math.min(z0, bz0); z1 = Math.max(z1, pz + hz);
        }
        renderer.setDebugFitBoxes(renderer.debugGroup.visible ? boxes : []);
        if (!boxes.length) return { x: 0, y: 0, w: pageW, h: maxY };
        // world -> CSS px (y flips: high z = small y)
        const tl = desk.toScreen(x0, z1), br = desk.toScreen(x1, z0);
        // Horizontal: each EDGE anchors to the absolute grid, so a drifting
        // bounding box changes one edge at a time — every window change is
        // then a resize, which hosts apply observably (resize event); pure
        // translations, whose apply-time we can't observe, stop happening.
        let rx = Math.floor(tl.x / DPR / grid) * grid;
        let rRight = Math.ceil(br.x / DPR / grid) * grid;
        rx = Math.max(0, rx);
        rRight = Math.min(pageW, Math.max(rRight, rx + minW));
        rx = Math.min(rx, rRight - minW);
        rx = Math.max(0, rx);
        // Vertical: the bottom hugs the content (fine-quantized so idle
        // bobbing doesn't churn; on the ground it clamps to the taskbar
        // line exactly); only the top edge uses the coarse grid, so slack
        // becomes jump headroom instead of dead space below the feet.
        const yBottom = Math.min(Math.ceil(br.y / DPR / 16) * 16, maxY);
        let ry = Math.floor(tl.y / DPR / grid) * grid;
        if (yBottom - ry < minH) ry = yBottom - minH;
        ry = Math.max(0, ry);
        return { x: rx, y: ry, w: rRight - rx, h: Math.max(1, Math.round(yBottom - ry)) };
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

    // Issue a rect through the two-phase transition. Callers guarantee the
    // size differs from cur (see the union-split in the tick), so adoption
    // always has an observable resize event to key on.
    function requestTransition(r) {
        pending = r;
        pendingAt = performance.now();
        beginTransition(r);
        requestAnimationFrame(() => {
            if (pending !== r) return;
            try { requestRect(r); } catch (e) { rollback(); }
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

        let r = fitRect();
        if (r.x === cur.x && r.y === cur.y && r.w === cur.w && r.h === cur.h) {
            offsetCellIframes(); // a late view.show may have reset styles
            return;
        }
        if (r.w === cur.w && r.h === cur.h) {
            // Same size, new origin (fast drift crossed grid lines on both
            // edges at once): split into a grow now — a resize, observable —
            // and let the next tick shrink to the tight rect.
            const x0 = Math.min(cur.x, r.x), y0 = Math.min(cur.y, r.y);
            r = {
                x: x0, y: y0,
                w: Math.max(cur.x + cur.w, r.x + r.w) - x0,
                h: Math.max(cur.y + cur.h, r.y + r.h) - y0,
            };
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
