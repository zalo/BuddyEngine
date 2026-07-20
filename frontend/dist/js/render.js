// Transparent orthographic renderer. The camera looks along +Y (into the
// screen) with Z up, so world X/Z map linearly onto desktop pixels via the
// Desk coordinate mapper.

import * as THREE from 'three';

const BODY_COLORS = {
    pelvis: 0x5577aa, torso: 0x5577aa, head: 0xcc8866,
    right_upper_arm: 0x77aa55, right_lower_arm: 0x77aa55, right_hand: 0xcc8866,
    sword: 0xcccccc,
    left_upper_arm: 0xaa7755, left_lower_arm: 0xaa7755, shield: 0x8888cc, left_hand: 0xcc8866,
    right_thigh: 0x5577aa, right_shin: 0x5577aa, right_foot: 0x555577,
    left_thigh: 0x5577aa, left_shin: 0x5577aa, left_foot: 0x555577,
};

export class Renderer {
    constructor(desk) {
        this.desk = desk;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setClearColor(0x000000, 0);
        document.body.appendChild(this.renderer.domElement);

        // A lost WebGL context leaves the transparent overlay permanently
        // blank; reload to rebuild the whole sim.
        this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            try { window.go.main.App.LogError('webgl context lost, reloading'); } catch (err) {}
            setTimeout(() => window.location.reload(), 250);
        });

        this.scene = new THREE.Scene();

        // Frustum in world meters, aligned with the desktop mapping.
        const tl = desk.toWorld(0, 0);
        const br = desk.toWorld(desk.screenW, desk.screenH);
        this.camera = new THREE.OrthographicCamera(tl.x, br.x, tl.z, br.z, 0.1, 100);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(0, -20, 0);
        this.camera.lookAt(0, 0, 0);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
        dirLight.position.set(3, -8, 10);
        this.scene.add(dirLight);
        const rim = new THREE.HemisphereLight(0xbbccff, 0x664422, 0.5);
        this.scene.add(rim);

        this.targetMesh = null;

        // The rect of the desktop (physical px) this canvas currently shows.
        // Default: the whole screen. A form-fitting host (the extension
        // overlay) narrows it to the buddies' bounding box via
        // setViewportRect, and projectToScreen stays in full-desktop space.
        this.viewRect = { x: 0, y: 0, w: desk.screenW, h: desk.screenH };

        // Debug collider visualization.
        this.debugGroup = new THREE.Group();
        this.debugGroup.visible = true;
        this.scene.add(this.debugGroup);
        this.debugMeshes = new Map(); // collider key -> { group, box }
        this.debugTarget = null;

        // Debug outline of the current viewport window (magenta), visible
        // with the collider debug layer — shows what a form-fitting host is
        // actually compositing.
        const outlineGeo = new THREE.BufferGeometry();
        outlineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
        this.viewportOutline = new THREE.LineLoop(
            outlineGeo,
            new THREE.LineBasicMaterial({ color: 0xff33cc }),
        );
        this.viewportOutline.visible = false;
        this.debugGroup.add(this.viewportOutline);
    }

    // Debug rectangles for the per-body boxes feeding the form-fit union
    // (cyan) — shows at a glance which buddy is inflating the window.
    // Pooled LineLoops in the debug layer; pass [] to clear.
    setDebugFitBoxes(boxes) {
        this.fitBoxLines = this.fitBoxLines || [];
        while (this.fitBoxLines.length < boxes.length) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
            const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0x22ffdd }));
            this.debugGroup.add(line);
            this.fitBoxLines.push(line);
        }
        this.fitBoxLines.forEach((line, i) => {
            if (i >= boxes.length) {
                line.visible = false;
                return;
            }
            const b = boxes[i];
            const pos = line.geometry.attributes.position;
            pos.array.set([b.x0, 0, b.z0, b.x1, 0, b.z0, b.x1, 0, b.z1, b.x0, 0, b.z1]);
            pos.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            line.visible = true;
        });
    }

    // Show a sub-rect of the desktop (physical px): resize the drawing
    // buffer to it and shift the ortho window so world content stays glued
    // to desktop coordinates. Call from a resize observer — i.e. after the
    // host window actually changed — so the camera and the canvas update in
    // the same visual frame.
    setViewportRect(px, py, wPx, hPx) {
        const dpr = window.devicePixelRatio || 1;
        this.viewRect = { x: px, y: py, w: wPx, h: hPx };
        this.renderer.setSize(wPx / dpr, hPx / dpr);
        const tl = this.desk.toWorld(px, py);
        const br = this.desk.toWorld(px + wPx, py + hPx);
        this.camera.left = tl.x;
        this.camera.right = br.x;
        this.camera.top = tl.z;
        this.camera.bottom = br.z;
        this.camera.updateProjectionMatrix();

        // Outline slightly inset so it isn't clipped by the window edge.
        const inset = 2 * dpr / this.desk.ppm;
        const a = { x: tl.x + inset, z: tl.z - inset };
        const b = { x: br.x - inset, z: br.z + inset };
        const pos = this.viewportOutline.geometry.attributes.position;
        pos.array.set([a.x, 0, a.z, b.x, 0, a.z, b.x, 0, b.z, a.x, 0, b.z]);
        pos.needsUpdate = true;
        this.viewportOutline.geometry.computeBoundingSphere();
        this.viewportOutline.visible = true;
    }

    setDebugVisible(v) {
        this.debugGroup.visible = v;
    }

    debugColorFor(key) {
        if (key === 'ground') return 0x33dd77;       // taskbar / ground
        if (key.startsWith('wall')) return 0x999999; // screen edges
        if (key.startsWith('win:')) return 0x33aaff; // window platforms
        if (key.startsWith('icon:')) return 0xffaa33;// desktop icons
        return 0xffffff;
    }

    // Mirror the collider registry into wireframe + translucent boxes.
    // Kinematic boxes move every frame, so poses sync unconditionally.
    syncDebug(colliders, targetPos) {
        if (!this.debugGroup.visible) return;

        for (const [key, entry] of colliders) {
            const b = entry.box;
            if (b.debugHide) continue;
            let dm = this.debugMeshes.get(key);
            if (dm && (Math.abs(dm.hx - b.hx) > 1e-4 || Math.abs(dm.hz - b.hz) > 1e-4)) {
                this.debugGroup.remove(dm.group);
                this.debugMeshes.delete(key);
                dm = null;
            }
            if (!dm) {
                const color = this.debugColorFor(key);
                const geo = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2);
                const group = new THREE.Group();
                const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                    color, transparent: true, opacity: 0.14, depthWrite: false,
                }));
                const edges = new THREE.LineSegments(
                    new THREE.EdgesGeometry(geo),
                    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
                group.add(fill);
                group.add(edges);
                this.debugGroup.add(group);
                dm = { group, hx: b.hx, hz: b.hz };
                this.debugMeshes.set(key, dm);
            }
            dm.group.position.set(b.cx, b.cy, b.cz);
        }
        for (const [key, dm] of this.debugMeshes) {
            if (!colliders.has(key)) {
                this.debugGroup.remove(dm.group);
                this.debugMeshes.delete(key);
            }
        }

        this.syncGhosts();

        // Strike target marker (the point the buddy is trying to hit).
        if (targetPos) {
            if (!this.debugTarget) {
                const ring = new THREE.Mesh(
                    new THREE.RingGeometry(0.09, 0.13, 24),
                    new THREE.MeshBasicMaterial({
                        color: 0xff44dd, transparent: true, opacity: 0.85,
                        side: THREE.DoubleSide, depthWrite: false,
                    }));
                // Ring faces the ortho camera (which looks along +Y).
                ring.rotation.x = Math.PI / 2;
                this.debugTarget = ring;
                this.debugGroup.add(ring);
            }
            this.debugTarget.position.set(targetPos[0], targetPos[1], targetPos[2]);
        }
    }

    buildBodyMeshes(links, bodies) {
        for (let bi = 0; bi < bodies.length; bi++) {
            const body = bodies[bi];
            const group = new THREE.Group();
            const color = BODY_COLORS[body.name] || 0x888888;

            for (const geom of body.geoms) {
                const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
                let mesh = null;
                if (geom.type === 'sphere') {
                    mesh = new THREE.Mesh(new THREE.SphereGeometry(geom.radius, 16, 12), mat);
                    mesh.position.set(...geom.pos);
                } else if (geom.type === 'capsule' && geom.fromto) {
                    const ft = geom.fromto;
                    const p0 = new THREE.Vector3(ft[0], ft[1], ft[2]);
                    const p1 = new THREE.Vector3(ft[3], ft[4], ft[5]);
                    const dir = new THREE.Vector3().subVectors(p1, p0);
                    const len = dir.length();
                    mesh = new THREE.Mesh(new THREE.CapsuleGeometry(geom.radius, len, 8, 12), mat);
                    mesh.position.addVectors(p0, p1).multiplyScalar(0.5);
                    if (len > 0.001) {
                        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.normalize());
                    }
                } else if (geom.type === 'box') {
                    const he = geom.halfExtents;
                    mesh = new THREE.Mesh(new THREE.BoxGeometry(he[0]*2, he[1]*2, he[2]*2), mat);
                    mesh.position.set(...geom.pos);
                } else if (geom.type === 'cylinder') {
                    const r = geom.radius;
                    if (geom.fromto) {
                        const ft = geom.fromto;
                        const p0 = new THREE.Vector3(ft[0], ft[1], ft[2]);
                        const p1 = new THREE.Vector3(ft[3], ft[4], ft[5]);
                        const dir = new THREE.Vector3().subVectors(p1, p0);
                        const len = Math.max(dir.length(), 0.01);
                        mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), mat);
                        mesh.position.addVectors(p0, p1).multiplyScalar(0.5);
                        if (len > 0.001) {
                            mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.normalize());
                        }
                    } else {
                        const hh = geom.halfHeight || 0.015;
                        mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh*2, 16), mat);
                        mesh.position.set(...(geom.pos || [0,0,0]));
                    }
                }
                if (mesh) {
                    mesh.userData.bodyIndex = bi;
                    group.add(mesh);
                }
            }
            this.scene.add(group);
            links[bi].meshGroup = group;
        }
    }

    removeBodyMeshes(links) {
        for (const entry of links) {
            if (entry.meshGroup) {
                this.scene.remove(entry.meshGroup);
                entry.meshGroup = null;
            }
        }
    }

    updateMeshes(links) {
        for (const entry of links) {
            if (!entry.meshGroup) continue;
            const pose = entry.link.getGlobalPose();
            const p = pose.get_p(), q = pose.get_q();
            entry.meshGroup.position.set(p.get_x(), p.get_y(), p.get_z());
            entry.meshGroup.quaternion.set(q.get_x(), q.get_y(), q.get_z(), q.get_w());
        }
    }

    render() {
        this.renderer.render(this.scene, this.camera);
    }

    // Ghost boxes: debug-only outlines with no collider behind them
    // (e.g. desktop icons while icon collision is disabled).
    setGhostBoxes(boxes) {
        this._ghostBoxes = boxes || [];
    }

    syncGhosts() {
        const boxes = this._ghostBoxes || [];
        if (!this.ghostMeshes) this.ghostMeshes = [];
        while (this.ghostMeshes.length > boxes.length) {
            this.debugGroup.remove(this.ghostMeshes.pop().group);
        }
        for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            let gm = this.ghostMeshes[i];
            if (gm && (Math.abs(gm.hx - b.hx) > 1e-4 || Math.abs(gm.hz - b.hz) > 1e-4)) {
                this.debugGroup.remove(gm.group);
                gm = null;
            }
            if (!gm) {
                const geo = new THREE.BoxGeometry(b.hx * 2, 0.1, b.hz * 2);
                const group = new THREE.Group();
                group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                    color: 0xffaa33, transparent: true, opacity: 0.06, depthWrite: false,
                })));
                group.add(new THREE.LineSegments(
                    new THREE.EdgesGeometry(geo),
                    new THREE.LineBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.4 })));
                this.debugGroup.add(group);
                gm = { group, hx: b.hx, hz: b.hz };
                this.ghostMeshes[i] = gm;
            }
            gm.group.position.set(b.cx, 0, b.cz);
        }
        this.ghostMeshes.length = boxes.length;
    }

    // Screen-space (CSS px) position of a world point.
    // World -> CSS px in *full desktop* space (not window-local), so hit
    // testing keeps working when the viewport is a form-fitted sub-rect.
    projectToScreen(wx, wy, wz) {
        const dpr = window.devicePixelRatio || 1;
        const v = new THREE.Vector3(wx, wy, wz).project(this.camera);
        return {
            x: ((v.x + 1) / 2 * this.viewRect.w + this.viewRect.x) / dpr,
            y: ((1 - v.y) / 2 * this.viewRect.h + this.viewRect.y) / dpr,
        };
    }
}
