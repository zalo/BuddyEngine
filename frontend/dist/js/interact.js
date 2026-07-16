// Mouse interaction driven entirely by the Go global-cursor stream, so it
// works while the overlay is click-through and other windows have focus:
//   - hover hit-test against buddy links -> toggles OS click-through
//   - left-drag: spring-grab a link (release = throw)
//   - right-click on the buddy: context menu
//   - cursor position becomes the strike target the buddy chases

const DRAG_STIFFNESS = 900;     // spring accel per meter of stretch
const DRAG_DAMPING = 45;        // velocity damping (~critical for k=900 is 60)
const MIN_RADIUS_PX = 24;       // minimum css px halo around each link

export class Interact {
    constructor(sim, desk, renderer) {
        this.sim = sim;
        this.desk = desk;
        this.renderer = renderer;

        this.cursor = { x: 0, y: 0, l: false, r: false }; // physical px
        this.prevL = false;
        this.prevR = false;
        this.lastMove = performance.now();

        this.hovering = false;
        this.dragging = false;
        this.dragBody = null;
        this.dragLocal = [0, 0, 0];
        this.menuOpen = false;
        this.cartMgr = null;      // set after CartridgeManager exists
        this.lastHoverId = null;  // fqid of hovered cell body, for enter/leave

        this.clickThrough = true; // overlay starts click-through

        this.onRightClick = null; // (cssX, cssY) => void

        // Per-body hover radius (css px) from the collision geometry, so the
        // whole limb is grabbable, not just the link origin.
        this.linkRadiiPx = [];
        const dpr = window.devicePixelRatio || 1;
        for (const body of sim.data.bodies) {
            let r = 0.06;
            for (const g of body.geoms) {
                const c = g.pos ? Math.hypot(g.pos[0], g.pos[1], g.pos[2]) : 0;
                if (g.type === 'sphere') r = Math.max(r, c + g.radius);
                else if (g.type === 'capsule' && g.fromto) {
                    const ft = g.fromto;
                    const l0 = Math.hypot(ft[0], ft[1], ft[2]);
                    const l1 = Math.hypot(ft[3], ft[4], ft[5]);
                    r = Math.max(r, Math.max(l0, l1) + g.radius);
                } else if (g.type === 'box') {
                    r = Math.max(r, c + Math.hypot(...g.halfExtents));
                } else if (g.type === 'cylinder') {
                    r = Math.max(r, c + (g.radius || 0.05) + (g.halfHeight || 0));
                }
            }
            this.linkRadiiPx.push(Math.max(MIN_RADIUS_PX, r * desk.ppm / dpr * 0.9));
        }
    }

    updateCursor(c) {
        if (c.x !== this.cursor.x || c.y !== this.cursor.y) {
            this.lastMove = performance.now();
        }
        this.cursor = c;
    }

    idleSeconds() {
        return (performance.now() - this.lastMove) / 1000;
    }

    cursorWorld() {
        return this.desk.toWorld(this.cursor.x, this.cursor.y);
    }

    // Distance-based hit test in screen space.
    hitTest() {
        const dpr = window.devicePixelRatio || 1;
        const cx = this.cursor.x / dpr, cy = this.cursor.y / dpr;
        let best = null, bestScore = Infinity;
        for (let i = 0; i < this.sim.links.length; i++) {
            const pose = this.sim.links[i].link.getGlobalPose();
            const p = pose.get_p();
            const s = this.renderer.projectToScreen(p.get_x(), p.get_y(), p.get_z());
            const d = Math.hypot(s.x - cx, s.y - cy);
            const score = d - (this.linkRadiiPx[i] || MIN_RADIUS_PX);
            if (score < bestScore) { bestScore = score; best = { kind: 'link', index: i, actor: this.sim.links[i].link }; }
        }
        // Buddy-API bodies are grabbable/hoverable too.
        const dpr2 = window.devicePixelRatio || 1;
        for (const [fqid, b] of this.sim.dynBodies) {
            const pose = b.actor.getGlobalPose();
            const p = pose.get_p();
            const s = this.renderer.projectToScreen(p.get_x(), p.get_y(), p.get_z());
            const d = Math.hypot(s.x - cx, s.y - cy);
            const rPx = Math.max(MIN_RADIUS_PX, b.radius * this.desk.ppm / dpr2);
            const score = d - rPx;
            if (score < bestScore) { bestScore = score; best = { kind: 'dyn', id: fqid, actor: b.actor }; }
        }
        if (bestScore < 0) return best;
        return null;
    }

    // Called every frame before physics stepping.
    update() {
        const hit = this.hitTest();
        this.hovering = !!hit;

        const lEdgeDown = this.cursor.l && !this.prevL;
        const lEdgeUp = !this.cursor.l && this.prevL;
        const rEdgeDown = this.cursor.r && !this.prevR;

        // Pointer enter/leave/down/up events for buddy-cell bodies.
        if (this.cartMgr) {
            const hoverId = hit && hit.kind === 'dyn' ? hit.id : null;
            const cw = this.cursorWorld();
            if (hoverId !== this.lastHoverId) {
                if (this.lastHoverId) this.cartMgr.routePointerEvent(this.lastHoverId, 'pointerleave', cw.x, cw.z);
                if (hoverId) this.cartMgr.routePointerEvent(hoverId, 'pointerenter', cw.x, cw.z);
                this.lastHoverId = hoverId;
            }
            if (lEdgeDown && hoverId) this.cartMgr.routePointerEvent(hoverId, 'pointerdown', cw.x, cw.z);
            if (lEdgeUp && this.lastHoverId) this.cartMgr.routePointerEvent(this.lastHoverId, 'pointerup', cw.x, cw.z);
        }

        if (lEdgeDown && hit && !this.menuOpen) {
            this.dragging = true;
            this.dragBody = hit.actor;
            // Grab point: keep it simple, grab the body origin.
            this.dragLocal = [0, 0, 0];
        }
        if (lEdgeUp && this.dragging) {
            this.dragging = false;
            this.dragBody = null;
        }
        if (rEdgeDown && hit && !this.menuOpen && this.onRightClick) {
            const dpr = window.devicePixelRatio || 1;
            this.onRightClick(this.cursor.x / dpr, this.cursor.y / dpr);
        }

        this.prevL = this.cursor.l;
        this.prevR = this.cursor.r;

        this.syncClickThrough();
    }

    syncClickThrough() {
        const wantInteractive = this.hovering || this.dragging || this.menuOpen;
        const wantClickThrough = !wantInteractive;
        if (wantClickThrough !== this.clickThrough) {
            this.clickThrough = wantClickThrough;
            try { window.go.main.App.SetClickThrough(wantClickThrough); } catch (e) {}
        }
    }

    // Spring force pulling the grabbed body to the cursor; applied every
    // physics substep. Momentum on release gives a natural throw.
    applyDragForce() {
        if (!this.dragging || !this.dragBody) return;
        const PhysX = this.sim.PhysX;
        const cw = this.cursorWorld();
        const pose = this.dragBody.getGlobalPose();
        const p = pose.get_p();

        let mass = 1.0;
        try { mass = this.dragBody.getMass(); } catch (e) {}

        let dx = cw.x - p.get_x();
        let dy = 0 - p.get_y();       // pull back to the desktop plane
        let dz = cw.z - p.get_z();

        // Clamp the spring stretch so yanking the mouse across the screen
        // can't accelerate bodies to tunneling speeds.
        const len = Math.hypot(dx, dy, dz);
        const MAX_STRETCH = 2.5;
        if (len > MAX_STRETCH) {
            const s = MAX_STRETCH / len;
            dx *= s; dy *= s; dz *= s;
        }

        // Damped spring: strong pull toward the cursor without slingshot
        // oscillation (damping is below critical so throws keep energy).
        let vx = 0, vy = 0, vz = 0;
        try {
            const v = this.dragBody.getLinearVelocity();
            vx = v.get_x(); vy = v.get_y(); vz = v.get_z();
        } catch (e) {}

        const force = new PhysX.PxVec3(
            (dx * DRAG_STIFFNESS - vx * DRAG_DAMPING) * mass,
            (dy * DRAG_STIFFNESS - vy * DRAG_DAMPING) * mass,
            (dz * DRAG_STIFFNESS - vz * DRAG_DAMPING) * mass
        );
        const point = new PhysX.PxVec3(p.get_x(), p.get_y(), p.get_z());
        try {
            PhysX.PxRigidBodyExt.prototype.addForceAtPos(this.dragBody, force, point);
        } catch (e) {
            try { this.dragBody.addForce(force); } catch (e2) {}
        }
    }

    // World position for the strike target: exactly the cursor. Reachability
    // clamping happens in the task observation (sim.buildTaskObs), not here,
    // so the target ring never snaps or lags the mouse.
    targetWorld() {
        const cw = this.cursorWorld();
        return [cw.x, 0, Math.max(cw.z, 0.05)];
    }
}
