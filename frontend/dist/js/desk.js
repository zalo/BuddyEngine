// Desk maps between desktop pixels (physical, from Go) and world meters, and
// mirrors window / desktop-icon rectangles into PhysX static colliders.

export class Desk {
    // screenW/H and workBottom are physical pixels; ppm = pixels per meter.
    constructor(sim, { screenW, screenH, workBottom, ppm }) {
        this.sim = sim;
        this.screenW = screenW;
        this.screenH = screenH;
        this.groundPy = workBottom; // taskbar top = world z 0
        this.ppm = ppm || 140;
        this.windowKeys = new Set();
        this.iconKeys = new Set();
    }

    toWorld(px, py) {
        return {
            x: (px - this.screenW / 2) / this.ppm,
            z: (this.groundPy - py) / this.ppm,
        };
    }

    toScreen(wx, wz) {
        return {
            x: wx * this.ppm + this.screenW / 2,
            y: this.groundPy - wz * this.ppm,
        };
    }

    // CSS pixels (WebView coordinates) from physical pixels.
    physToCss(px, py) {
        const dpr = window.devicePixelRatio || 1;
        return { x: px / dpr, y: py / dpr };
    }

    createStaticEnvironment() {
        const halfW = this.screenW / 2 / this.ppm;
        // Ground: top face at z=0 (taskbar top). Deep in Y and 10m thick so
        // hard throws can't tunnel through it or slip past it sideways.
        this.sim.addStaticBox('ground', 0, 0, -5, halfW * 2 + 40, 60, 5);
        // Screen edge walls (2m thick, inner face at the screen edge).
        this.sim.addStaticBox('wall_l', -halfW - 2, 0, 25, 2, 60, 30);
        this.sim.addStaticBox('wall_r', halfW + 2, 0, 25, 2, 60, 30);
        // Invisible depth slabs keep everything in the desktop plane
        // (|y| < ~3.5) — bodies knocked "into the screen" bounce back.
        this.sim.addStaticBox('wall_back', 0, -4.5, 25, halfW * 2 + 40, 1, 35);
        this.sim.addStaticBox('wall_front', 0, 4.5, 25, halfW * 2 + 40, 1, 35);
        for (const k of ['wall_l', 'wall_r', 'wall_back', 'wall_front']) {
            const entry = this.sim.staticActors.get(k);
            if (entry) entry.box.wall = true;
        }
        for (const k of ['wall_back', 'wall_front']) {
            const entry = this.sim.staticActors.get(k);
            if (entry) entry.box.debugHide = true; // would fill the whole view
        }
    }

    rectToBox(r) {
        const c = this.toWorld(r.x + r.w / 2, r.y + r.h / 2);
        return {
            cx: c.x, cz: c.z,
            hx: r.w / 2 / this.ppm,
            hz: r.h / 2 / this.ppm,
        };
    }

    // Reconcile colliders with the latest snapshot from Go.
    // Windows become platform strips along their top edge (souptoys-style:
    // the buddy stands on and bumps into window tops). Solid interiors would
    // entomb the buddy on a busy desktop.
    // Exposed x-intervals of a window's top edge: the full edge minus every
    // higher-z window rect that covers that edge line. `above` is the list
    // of windows in front of this one (the tracker sends topmost-first).
    static exposedTopSegments(w, above) {
        let segs = [[w.x, w.x + w.w]];
        for (const h of above) {
            if (h.y > w.y || w.y > h.y + h.h) continue; // doesn't cover the edge line
            const hx0 = h.x, hx1 = h.x + h.w;
            const out = [];
            for (const [a, b] of segs) {
                if (hx1 <= a || hx0 >= b) { out.push([a, b]); continue; }
                if (hx0 > a) out.push([a, hx0]);
                if (hx1 < b) out.push([hx1, b]);
            }
            segs = out;
            if (!segs.length) break;
        }
        return segs.filter(([a, b]) => b - a >= 60); // ignore slivers < 60px
    }

    updateWindows(windows) {
        const STRIP_HZ = 0.12; // half-thickness of the platform, meters
        const seen = new Set();
        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            // Platform strips exist only where the top edge is actually
            // visible — occluded stretches are trimmed away.
            const segs = Desk.exposedTopSegments(w, windows.slice(0, i));
            for (let j = 0; j < segs.length; j++) {
                const [x0, x1] = segs[j];
                const key = `win:${w.hwnd}:${j}`;
                seen.add(key);
                const top = this.toWorld((x0 + x1) / 2, w.y);
                const b = {
                    cx: top.x,
                    cz: top.z - STRIP_HZ,
                    hx: (x1 - x0) / 2 / this.ppm,
                    hz: STRIP_HZ,
                };
                const existing = this.sim.staticActors.get(key);
                if (existing) {
                    if (Math.abs(existing.box.hx - b.hx) < 0.01) {
                        // Same size: sweep the kinematic collider so the
                        // buddy gets shoved with the window's velocity.
                        this.sim.setKinematicGoal(key, b.cx, b.cz);
                        continue;
                    }
                    this.sim.removeStatic(key); // resized/re-trimmed: rebuild
                }
                this.sim.addKinematicBox(key, b.cx, 0, b.cz, b.hx, 6.0, b.hz);
            }
        }
        for (const key of this.windowKeys) {
            if (!seen.has(key)) this.sim.removeStatic(key);
        }
        this.windowKeys = seen;
    }

    updateIcons(icons) {
        const seen = new Set();
        icons = icons || [];
        for (let i = 0; i < icons.length; i++) {
            const r = icons[i];
            const key = 'icon:' + i;
            seen.add(key);
            const b = this.rectToBox(r);
            const existing = this.sim.staticActors.get(key);
            if (existing) {
                if (Math.abs(existing.box.hx - b.hx) < 0.01 &&
                    Math.abs(existing.box.hz - b.hz) < 0.01) {
                    // Icons teleport: occlusion changes reshuffle which icon
                    // each key maps to, and a velocity sweep there would
                    // knock the buddy over.
                    this.sim.setKinematicPose(key, b.cx, b.cz);
                    continue;
                }
                this.sim.removeStatic(key);
            }
            this.sim.addKinematicBox(key, b.cx, 0, b.cz, b.hx, 6.0, b.hz);
        }
        for (const key of this.iconKeys) {
            if (!seen.has(key)) this.sim.removeStatic(key);
        }
        this.iconKeys = seen;
    }
}
