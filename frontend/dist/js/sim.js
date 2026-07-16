// PhysX world owned by the host. World is Z-up, meters; the desktop plane is
// X (screen right) by Z (screen up); Y is depth (out of the monitor).
//
// The host knows nothing about any particular character: articulated bodies
// are created generically through the Buddy API (arti.* commands) from rig
// descriptions supplied by buddy cells. Policies, observations and skinning
// live in the cells.
//
// Collision groups (filter word0): 1=world statics, 2=articulations,
// 4=buddy-API bodies, 8=cursor target. word1 = which groups I hit.

import { quatFromTwoVec } from './math3d.js';

export const DT = 1 / 120;

export class SimWorld {
    constructor() {
        this.PhysX = null;
        this.physics = null;
        this.scene = null;
        this.material = null;
        this.staticActors = new Map();  // colliders (ground/walls/windows/icons)
        this.dynBodies = new Map();     // fqid -> { actor, radius, kinematic }
        this.articulations = new Map(); // fq prefix -> articulation record
        this.targetActor = null;        // kinematic cursor target
        this.targetState = { pos: [2, 0, 0.9], vel: [0, 0, 0] };
        this.enums = {};
    }

    async init() {
        const module = await import('../vendor/physx-js-webidl.mjs');
        const PhysX = await module.default({
            locateFile: () => './vendor/physx-js-webidl.wasm'
        });
        this.PhysX = PhysX;

        const E = this.enums;
        E.TWIST   = PhysX.PxArticulationAxisEnum.eTWIST;
        E.SWING1  = PhysX.PxArticulationAxisEnum.eSWING1;
        E.SWING2  = PhysX.PxArticulationAxisEnum.eSWING2;
        E.LIMITED = PhysX.PxArticulationMotionEnum.eLIMITED;
        E.LOCKED  = PhysX.PxArticulationMotionEnum.eLOCKED;
        E.SPHERICAL = PhysX.PxArticulationJointTypeEnum.eSPHERICAL;
        E.REVOLUTE  = PhysX.PxArticulationJointTypeEnum.eREVOLUTE;
        E.FIX       = PhysX.PxArticulationJointTypeEnum.eFIX;
        E.FORCE     = PhysX.PxArticulationDriveTypeEnum.eFORCE;
        E.SHAPE_FLAGS = PhysX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | PhysX.PxShapeFlagEnum.eSIMULATION_SHAPE;

        const tlf = PhysX.PxTopLevelFunctions.prototype;
        const version = PhysX.PHYSICS_VERSION;
        const allocator = new PhysX.PxDefaultAllocator();
        const errorCb = new PhysX.PxDefaultErrorCallback();
        const foundation = tlf.CreateFoundation(version, allocator, errorCb);

        const tolerances = new PhysX.PxTolerancesScale();
        this.physics = tlf.CreatePhysics(version, foundation, tolerances);

        const cpuDispatcher = tlf.DefaultCpuDispatcherCreate(0);
        const sceneDesc = new PhysX.PxSceneDesc(tolerances);
        sceneDesc.set_gravity(new PhysX.PxVec3(0, 0, -9.81));
        sceneDesc.set_cpuDispatcher(cpuDispatcher);
        sceneDesc.set_filterShader(tlf.DefaultFilterShader());
        sceneDesc.set_bounceThresholdVelocity(0.2);
        if (PhysX.PxSolverTypeEnum && PhysX.PxSolverTypeEnum.ePGS !== undefined) {
            sceneDesc.set_solverType(PhysX.PxSolverTypeEnum.ePGS);
        }
        if (typeof sceneDesc.set_frictionType === 'function') {
            sceneDesc.set_frictionType(PhysX.PxFrictionTypeEnum.ePATCH);
        }
        if (typeof sceneDesc.set_frictionCorrelationDistance === 'function') {
            sceneDesc.set_frictionCorrelationDistance(0.025);
        }
        if (typeof sceneDesc.set_frictionOffsetThreshold === 'function') {
            sceneDesc.set_frictionOffsetThreshold(0.04);
        }
        if (typeof sceneDesc.set_maxBiasCoefficient === 'function') {
            sceneDesc.set_maxBiasCoefficient(100);
        }
        this.scene = this.physics.createScene(sceneDesc);
        this.material = this.physics.createMaterial(1.0, 1.0, 0.0);
    }

    // -- static colliders (ground, screen walls, windows, icons) ------------

    addStaticBox(key, cx, cy, cz, hx, hy, hz) {
        const PhysX = this.PhysX;
        const shapeFlags = new PhysX.PxShapeFlags(this.enums.SHAPE_FLAGS);
        const geom = new PhysX.PxBoxGeometry(hx, hy, hz);
        const shape = this.physics.createShape(geom, this.material, true, shapeFlags);
        shape.setSimulationFilterData(new PhysX.PxFilterData(1, 7, 0, 0));
        const pose = new PhysX.PxTransform(
            new PhysX.PxVec3(cx, cy, cz), new PhysX.PxQuat(0, 0, 0, 1));
        const actor = this.physics.createRigidStatic(pose);
        actor.attachShape(shape);
        this.scene.addActor(actor);
        this.staticActors.set(key, { actor, box: { cx, cy, cz, hx, hy, hz } });
        return actor;
    }

    addKinematicBox(key, cx, cy, cz, hx, hy, hz) {
        const PhysX = this.PhysX;
        const shapeFlags = new PhysX.PxShapeFlags(this.enums.SHAPE_FLAGS);
        const geom = new PhysX.PxBoxGeometry(hx, hy, hz);
        const shape = this.physics.createShape(geom, this.material, true, shapeFlags);
        shape.setSimulationFilterData(new PhysX.PxFilterData(1, 7, 0, 0));
        const pose = new PhysX.PxTransform(
            new PhysX.PxVec3(cx, cy, cz), new PhysX.PxQuat(0, 0, 0, 1));
        const actor = this.physics.createRigidDynamic(pose);
        actor.attachShape(shape);
        actor.setRigidBodyFlag(PhysX.PxRigidBodyFlagEnum.eKINEMATIC, true);
        this.scene.addActor(actor);
        this.staticActors.set(key, {
            actor,
            kinematic: true,
            box: { cx, cy, cz, hx, hy, hz },
            from: { cx, cz },
            goal: { cx, cz },
            duration: 0,
            elapsed: 0,
            lastGoalAt: 0,
        });
        return actor;
    }

    // New sampled position for a kinematic collider. The body sweeps there
    // linearly over exactly one sample interval, so its rigid-body velocity
    // equals the finite-difference velocity of the tracked window — no
    // smoothing lag. Jumps larger than teleportDist (snap/maximize,
    // occlusion reshuffles) teleport without imparting velocity.
    setKinematicGoal(key, cx, cz, teleportDist = 3.0) {
        const entry = this.staticActors.get(key);
        if (!entry || !entry.kinematic) return;
        if (Math.hypot(cx - entry.box.cx, cz - entry.box.cz) > teleportDist) {
            this.setKinematicPose(key, cx, cz);
            return;
        }
        const now = performance.now() / 1000;
        const interval = entry.lastGoalAt
            ? Math.min(Math.max(now - entry.lastGoalAt, 1 / 120), 0.25)
            : 1 / 30;
        entry.lastGoalAt = now;
        entry.from.cx = entry.box.cx;
        entry.from.cz = entry.box.cz;
        entry.goal.cx = cx;
        entry.goal.cz = cz;
        entry.duration = interval;
        entry.elapsed = 0;
    }

    setKinematicPose(key, cx, cz) {
        const entry = this.staticActors.get(key);
        if (!entry || !entry.kinematic) return;
        const PhysX = this.PhysX;
        entry.box.cx = cx;
        entry.box.cz = cz;
        entry.from.cx = cx;
        entry.from.cz = cz;
        entry.goal.cx = cx;
        entry.goal.cz = cz;
        entry.duration = 0;
        entry.elapsed = 0;
        entry.lastGoalAt = performance.now() / 1000;
        entry.actor.setGlobalPose(new PhysX.PxTransform(
            new PhysX.PxVec3(cx, entry.box.cy, cz),
            new PhysX.PxQuat(0, 0, 0, 1)), true);
    }

    updateKinematics(dt) {
        const PhysX = this.PhysX;
        for (const entry of this.staticActors.values()) {
            if (!entry.kinematic || entry.elapsed >= entry.duration) continue;
            entry.elapsed = Math.min(entry.elapsed + dt, entry.duration);
            const a = entry.elapsed / entry.duration;
            const b = entry.box;
            b.cx = entry.from.cx + (entry.goal.cx - entry.from.cx) * a;
            b.cz = entry.from.cz + (entry.goal.cz - entry.from.cz) * a;
            entry.actor.setKinematicTarget(new PhysX.PxTransform(
                new PhysX.PxVec3(b.cx, b.cy, b.cz),
                new PhysX.PxQuat(0, 0, 0, 1)));
        }
    }

    removeStatic(key) {
        const entry = this.staticActors.get(key);
        if (entry) {
            this.scene.removeActor(entry.actor);
            entry.actor.release();
            this.staticActors.delete(key);
        }
    }

    supportHeightAt(x, z) {
        let best = 0;
        for (const { box } of this.staticActors.values()) {
            if (box.wall) continue;
            const top = box.cz + box.hz;
            if (x >= box.cx - box.hx && x <= box.cx + box.hx && top <= z && top > best) {
                best = top;
            }
        }
        return best;
    }

    // -- cursor target (kinematic body on its own collision layer) ----------

    createTarget() {
        const PhysX = this.PhysX;
        const shapeFlags = new PhysX.PxShapeFlags(this.enums.SHAPE_FLAGS);
        const geom = new PhysX.PxBoxGeometry(0.12, 0.12, 0.12);
        const shape = this.physics.createShape(geom, this.material, true, shapeFlags);
        // Cursor layer: articulations collide with it (sword feedback);
        // buddy objects ignore it unless they opt in via collidesCursor.
        shape.setSimulationFilterData(new PhysX.PxFilterData(8, 2, 0, 0));
        const pose = new PhysX.PxTransform(
            new PhysX.PxVec3(2, 0, 0.9), new PhysX.PxQuat(0, 0, 0, 1));
        this.targetActor = this.physics.createRigidDynamic(pose);
        this.targetActor.attachShape(shape);
        this.targetActor.setRigidBodyFlag(PhysX.PxRigidBodyFlagEnum.eKINEMATIC, true);
        this.scene.addActor(this.targetActor);
    }

    moveTarget(pos, dt) {
        if (!this.targetActor) return;
        const prev = this.targetState.pos;
        if (dt > 0) {
            const maxV = 30;
            const alpha = 0.25;
            for (let i = 0; i < 3; i++) {
                const raw = Math.max(-maxV, Math.min(maxV, (pos[i] - prev[i]) / dt));
                this.targetState.vel[i] += alpha * (raw - this.targetState.vel[i]);
            }
        }
        this.targetState.pos = pos.slice();
        const PhysX = this.PhysX;
        this.targetActor.setKinematicTarget(new PhysX.PxTransform(
            new PhysX.PxVec3(pos[0], pos[1], pos[2]),
            new PhysX.PxQuat(0, 0, 0, 1)));
    }

    // -- generic dynamic bodies (Buddy API) ----------------------------------

    spawnBody(fqid, desc) {
        const PhysX = this.PhysX;
        if (this.dynBodies.has(fqid)) this.removeBody(fqid);

        const s = desc.shape || { type: 'sphere', r: 0.1 };
        let geom, radius;
        if (s.type === 'box') {
            const hx = s.hx || 0.1, hy = s.hy || hx, hz = s.hz || hx;
            geom = new PhysX.PxBoxGeometry(hx, hy, hz);
            radius = Math.hypot(hx, hy, hz);
        } else if (s.type === 'capsule') {
            const r = s.r || 0.1, hh = s.hh || 0.1;
            geom = new PhysX.PxCapsuleGeometry(r, hh); // capsule axis = local X
            radius = r + hh;
        } else {
            const r = s.r || 0.1;
            geom = new PhysX.PxSphereGeometry(r);
            radius = r;
        }

        const mat = this.physics.createMaterial(
            desc.friction !== undefined ? desc.friction : 0.6,
            desc.friction !== undefined ? desc.friction : 0.6,
            desc.restitution !== undefined ? desc.restitution : 0.3);
        const shapeFlags = new PhysX.PxShapeFlags(this.enums.SHAPE_FLAGS);
        const shape = this.physics.createShape(geom, mat, true, shapeFlags);
        const filters = { all: [4, 7], world: [4, 3], none: [4, 0] };
        const f = (filters[desc.collides || 'all'] || filters.all).slice();
        if (desc.collidesCursor) f[1] |= 8;
        shape.setSimulationFilterData(new PhysX.PxFilterData(f[0], f[1], 0, 0));

        const p = desc.pos || [0, 0, 1];
        const q = desc.quat || [0, 0, 0, 1];
        const pose = new PhysX.PxTransform(
            new PhysX.PxVec3(p[0], p[1], p[2]), new PhysX.PxQuat(q[0], q[1], q[2], q[3]));
        const actor = this.physics.createRigidDynamic(pose);
        actor.attachShape(shape);
        PhysX.PxRigidBodyExt.prototype.setMassAndUpdateInertia(actor, Math.max(0.01, desc.mass || 1.0));
        if (desc.kinematic) actor.setRigidBodyFlag(PhysX.PxRigidBodyFlagEnum.eKINEMATIC, true);
        actor.setAngularDamping(desc.angularDamping !== undefined ? desc.angularDamping : 0.05);
        actor.setLinearDamping(desc.linearDamping !== undefined ? desc.linearDamping : 0.01);
        if (typeof actor.setMaxLinearVelocity === 'function') actor.setMaxLinearVelocity(80.0);

        const lock = desc.lock || {};
        if (desc.planar2D) {
            lock.linY = true;
            lock.angX = true;
            lock.angZ = true;
        }
        if (!desc.kinematic && PhysX.PxRigidDynamicLockFlagEnum &&
            typeof actor.setRigidDynamicLockFlag === 'function') {
            const L = PhysX.PxRigidDynamicLockFlagEnum;
            if (lock.linX) actor.setRigidDynamicLockFlag(L.eLOCK_LINEAR_X, true);
            if (lock.linY) actor.setRigidDynamicLockFlag(L.eLOCK_LINEAR_Y, true);
            if (lock.linZ) actor.setRigidDynamicLockFlag(L.eLOCK_LINEAR_Z, true);
            if (lock.angX) actor.setRigidDynamicLockFlag(L.eLOCK_ANGULAR_X, true);
            if (lock.angY) actor.setRigidDynamicLockFlag(L.eLOCK_ANGULAR_Y, true);
            if (lock.angZ) actor.setRigidDynamicLockFlag(L.eLOCK_ANGULAR_Z, true);
        }
        this.scene.addActor(actor);
        this.dynBodies.set(fqid, { actor, radius, kinematic: !!desc.kinematic });
    }

    removeBody(fqid) {
        const b = this.dynBodies.get(fqid);
        if (!b) return;
        this.scene.removeActor(b.actor);
        b.actor.release();
        this.dynBodies.delete(fqid);
    }

    applyForceTo(fqid, f, p, mode) {
        const b = this.dynBodies.get(fqid);
        if (!b || b.kinematic) return;
        const PhysX = this.PhysX;
        const fv = new PhysX.PxVec3(f[0], f[1], f[2]);
        const em = mode === 'impulse'
            ? PhysX.PxForceModeEnum.eIMPULSE : PhysX.PxForceModeEnum.eFORCE;
        if (p) {
            try {
                PhysX.PxRigidBodyExt.prototype.addForceAtPos(b.actor, fv,
                    new PhysX.PxVec3(p[0], p[1], p[2]), em);
                return;
            } catch (e) {}
        }
        b.actor.addForce(fv, em);
    }

    setBodyVelocity(fqid, v, w) {
        const b = this.dynBodies.get(fqid);
        if (!b || b.kinematic) return;
        const PhysX = this.PhysX;
        if (v) b.actor.setLinearVelocity(new PhysX.PxVec3(v[0], v[1], v[2]));
        if (w) b.actor.setAngularVelocity(new PhysX.PxVec3(w[0], w[1], w[2]));
    }

    setBodyKinematicTarget(fqid, pos, quat) {
        const b = this.dynBodies.get(fqid);
        if (!b || !b.kinematic) return;
        const PhysX = this.PhysX;
        const q = quat || [0, 0, 0, 1];
        b.actor.setKinematicTarget(new PhysX.PxTransform(
            new PhysX.PxVec3(pos[0], pos[1], pos[2]),
            new PhysX.PxQuat(q[0], q[1], q[2], q[3])));
    }

    // -- articulations (Buddy API rigs) ---------------------------------------
    //
    // A rig description is engine-agnostic data: named links with collision
    // geoms/mass/inertia, joints with axes/limits/PD drive params, and an
    // init pose. MimicKit MJCF humanoids, mecanim-style bone chains and GLTF
    // skeleton proxies all lower to this same structure. Link world states
    // stream back in body snapshots as `<prefix>.<linkName>`; joint states
    // (dofPos/dofVel) stream to the owning cell each frame; drive targets
    // arrive via arti.drive.

    createArticulation(fq, data, spawn) {
        const PhysX = this.PhysX;
        const E = this.enums;
        if (this.articulations.has(fq)) this.removeArticulation(fq);

        const shapeFlags = new PhysX.PxShapeFlags(E.SHAPE_FLAGS);
        const rbext = PhysX.PxRigidBodyExt.prototype;

        const articulation = this.physics.createArticulationReducedCoordinate();
        articulation.setSolverIterationCounts(4, 0);
        if (typeof articulation.setSleepThreshold === 'function') articulation.setSleepThreshold(5e-5);
        if (typeof articulation.setStabilizationThreshold === 'function') articulation.setStabilizationThreshold(1e-5);
        articulation.setArticulationFlag(PhysX.PxArticulationFlagEnum.eDISABLE_SELF_COLLISION, true);

        const bodyLinkMap = {};
        const links = [];

        for (const body of data.bodies) {
            const wp = body.pos;
            const zOff = data.tpose_pelvis_z || data.pelvis_z || 0;
            const pose = new PhysX.PxTransform(
                new PhysX.PxVec3(wp[0], wp[1], wp[2] + zOff),
                new PhysX.PxQuat(0, 0, 0, 1)
            );

            const parentLink = body.parent ? bodyLinkMap[body.parent] : null;
            const link = articulation.createLink(parentLink, pose);

            let radius = 0.06;
            for (const geom of body.geoms) {
                const shape = this.createGeomShape(geom, shapeFlags);
                if (shape) {
                    // Articulations hit world(1) + buddy objects(4) + cursor(8).
                    shape.setSimulationFilterData(new PhysX.PxFilterData(2, 13, 0, 0));
                    link.attachShape(shape);
                }
                radius = Math.max(radius, geomBoundRadius(geom));
            }

            if (body.mass && body.inertia && body.com) {
                link.setMass(body.mass);
                link.setMassSpaceInertiaTensor(new PhysX.PxVec3(body.inertia[0], body.inertia[1], body.inertia[2]));
                link.setCMassLocalPose(new PhysX.PxTransform(
                    new PhysX.PxVec3(body.com[0], body.com[1], body.com[2]),
                    new PhysX.PxQuat(0, 0, 0, 1)
                ));
            } else if (body.mass) {
                rbext.setMassAndUpdateInertia(link, body.mass);
            } else {
                rbext.updateMassAndInertia(link, 1000);
            }

            link.setAngularDamping(0.01);
            link.setLinearDamping(0.0);
            link.setMaxDepenetrationVelocity(10.0);
            link.setMaxLinearVelocity(80.0);
            link.setMaxAngularVelocity(1000.0);
            if (typeof link.setSleepThreshold === 'function') link.setSleepThreshold(5e-5);
            if (typeof link.setStabilizationThreshold === 'function') link.setStabilizationThreshold(1e-5);
            if (typeof link.setCfmScale === 'function') link.setCfmScale(0.025);
            if (typeof link.setRigidBodyFlag === 'function') {
                try { link.setRigidBodyFlag(PhysX.PxRigidBodyFlagEnum.eENABLE_GYROSCOPIC_FORCES, true); } catch (e) {}
            }

            bodyLinkMap[body.name] = link;
            links.push({ name: body.name, link, radius });
        }

        const axisEnums = [E.TWIST, E.SWING1, E.SWING2];

        for (const jdata of data.joints) {
            const childLink = bodyLinkMap[jdata.child_body];
            const joint = childLink.getInboundJoint();

            joint.setJointType(jdata.jointType === 'spherical' ? E.SPHERICAL : E.REVOLUTE);
            joint.setFrictionCoefficient(0);
            if (typeof joint.setMaxJointVelocity === 'function') joint.setMaxJointVelocity(1000000);

            const lp = jdata.localPos0;
            const lr = jdata.localRot;
            joint.setParentPose(new PhysX.PxTransform(
                new PhysX.PxVec3(lp[0], lp[1], lp[2]),
                new PhysX.PxQuat(lr[1], lr[2], lr[3], lr[0])));
            joint.setChildPose(new PhysX.PxTransform(
                new PhysX.PxVec3(0, 0, 0),
                new PhysX.PxQuat(lr[1], lr[2], lr[3], lr[0])));

            if (jdata.jointType === 'spherical') {
                for (let i = 0; i < jdata.axes.length; i++) {
                    const axE = axisEnums[jdata.axisMap[i]];
                    joint.setMotion(axE, E.LIMITED);
                    const ax = jdata.axes[i];
                    joint.setLimitParams(axE, new PhysX.PxArticulationLimit(ax.range[0], ax.range[1]));
                    joint.setDriveParams(axE, new PhysX.PxArticulationDrive(
                        ax.stiffness, ax.damping, ax.maxForce, E.FORCE));
                    if (ax.armature !== undefined) joint.setArmature(axE, ax.armature);
                }
                for (let i = jdata.axes.length; i < 3; i++) {
                    joint.setMotion(axisEnums[i], E.LOCKED);
                }
            } else {
                joint.setMotion(E.TWIST, E.LIMITED);
                const ax = jdata.axes[0];
                joint.setLimitParams(E.TWIST, new PhysX.PxArticulationLimit(ax.range[0], ax.range[1]));
                joint.setDriveParams(E.TWIST, new PhysX.PxArticulationDrive(
                    ax.stiffness, ax.damping, ax.maxForce, E.FORCE));
                if (ax.armature !== undefined) joint.setArmature(E.TWIST, ax.armature);
                joint.setMotion(E.SWING1, E.LOCKED);
                joint.setMotion(E.SWING2, E.LOCKED);
            }
        }

        for (const fj of data.fixedJoints || []) {
            const childLink = bodyLinkMap[fj.child_body];
            const joint = childLink.getInboundJoint();
            joint.setJointType(E.FIX);
            const lp = fj.localPos0;
            joint.setParentPose(new PhysX.PxTransform(
                new PhysX.PxVec3(lp[0], lp[1], lp[2]), new PhysX.PxQuat(0, 0, 0, 1)));
            joint.setChildPose(new PhysX.PxTransform(
                new PhysX.PxVec3(0, 0, 0), new PhysX.PxQuat(0, 0, 0, 1)));
        }

        this.scene.addArticulation(articulation);

        // Resolve per-dof joint handles once for fast drive/state access.
        const dofAxes = (data.dofInfo || []).map(dof => ({
            joint: bodyLinkMap[dof.child_body] ? bodyLinkMap[dof.child_body].getInboundJoint() : null,
            axisEnum: axisEnums[dof.physx_axis],
        }));

        const rec = { fq, articulation, links, data, dofAxes, bodyLinkMap };
        this.articulations.set(fq, rec);
        this.applyArticulationInit(fq, spawn);
        return rec;
    }

    applyArticulationInit(fq, spawn) {
        const PhysX = this.PhysX;
        const E = this.enums;
        const rec = this.articulations.get(fq);
        if (!rec) return;
        const data = rec.data;
        if (!data.init_root_pos || !data.init_dof_pos) return;

        const rp = data.init_root_pos.slice();
        if (spawn) {
            if (spawn.x !== undefined) rp[0] = spawn.x;
            rp[1] = 0;
            if (spawn.z !== undefined) rp[2] += spawn.z;
        }
        const rq = data.init_root_rot_quat || [0, 0, 0, 1];
        const initDof = data.init_dof_pos;

        rec.articulation.setRootGlobalPose(new PhysX.PxTransform(
            new PhysX.PxVec3(rp[0], rp[1], rp[2]),
            new PhysX.PxQuat(rq[0], rq[1], rq[2], rq[3])), true);

        for (let i = 0; i < rec.dofAxes.length; i++) {
            const d = rec.dofAxes[i];
            if (!d.joint) continue;
            try {
                d.joint.setJointPosition(d.axisEnum, initDof[i]);
                d.joint.setJointVelocity(d.axisEnum, 0);
            } catch (e) {}
        }
        const initFlags = new PhysX.PxArticulationCacheFlags(PhysX.PxArticulationCacheFlagEnum.eALL);
        const initCache = rec.articulation.createCache();
        rec.articulation.copyInternalStateToCache(initCache, initFlags);
        rec.articulation.applyCache(initCache, initFlags, true);

        for (let i = 0; i < rec.dofAxes.length; i++) {
            const d = rec.dofAxes[i];
            if (!d.joint) continue;
            try { d.joint.setDriveTarget(d.axisEnum, initDof[i]); } catch (e) {}
        }
    }

    setArticulationDriveTargets(fq, targets) {
        const rec = this.articulations.get(fq);
        if (!rec) return;
        const n = Math.min(targets.length, rec.dofAxes.length);
        for (let i = 0; i < n; i++) {
            const d = rec.dofAxes[i];
            if (!d.joint) continue;
            const t = targets[i];
            if (!isFinite(t)) continue;
            try { d.joint.setDriveTarget(d.axisEnum, t); } catch (e) {}
        }
    }

    articulationJointState(fq) {
        const rec = this.articulations.get(fq);
        if (!rec) return null;
        const n = rec.dofAxes.length;
        const dofPos = new Array(n).fill(0);
        const dofVel = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            const d = rec.dofAxes[i];
            if (!d.joint) continue;
            try {
                dofPos[i] = d.joint.getJointPosition(d.axisEnum);
                dofVel[i] = d.joint.getJointVelocity(d.axisEnum);
            } catch (e) {}
        }
        return { dofPos, dofVel };
    }

    removeArticulation(fq) {
        const rec = this.articulations.get(fq);
        if (!rec) return;
        this.scene.removeArticulation(rec.articulation);
        this.articulations.delete(fq);
    }

    articulationRootPose(fq) {
        const rec = this.articulations.get(fq);
        if (!rec || !rec.links.length) return null;
        const pose = rec.links[0].link.getGlobalPose();
        const p = pose.get_p(), q = pose.get_q();
        return { pos: [p.get_x(), p.get_y(), p.get_z()], quat: [q.get_x(), q.get_y(), q.get_z(), q.get_w()] };
    }

    // -- shared geometry construction ----------------------------------------

    createGeomShape(geom, shapeFlags) {
        const PhysX = this.PhysX;
        let shape = null;
        if (geom.type === 'sphere') {
            const g = new PhysX.PxSphereGeometry(geom.radius);
            shape = this.physics.createShape(g, this.material, true, shapeFlags);
            const lp = geom.pos;
            shape.setLocalPose(new PhysX.PxTransform(
                new PhysX.PxVec3(lp[0], lp[1], lp[2]), new PhysX.PxQuat(0, 0, 0, 1)));
        } else if (geom.type === 'capsule' && geom.fromto) {
            const ft = geom.fromto;
            const p0 = [ft[0], ft[1], ft[2]], p1 = [ft[3], ft[4], ft[5]];
            const dx = p1[0]-p0[0], dy = p1[1]-p0[1], dz = p1[2]-p0[2];
            const len = Math.sqrt(dx*dx+dy*dy+dz*dz);
            const halfH = Math.max(len / 2, 0.001);
            const g = new PhysX.PxCapsuleGeometry(geom.radius, halfH);
            shape = this.physics.createShape(g, this.material, true, shapeFlags);
            const mid = [(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2];
            const dir = len > 0.001 ? [dx/len, dy/len, dz/len] : [1,0,0];
            const q = quatFromTwoVec([1,0,0], dir);
            shape.setLocalPose(new PhysX.PxTransform(
                new PhysX.PxVec3(mid[0], mid[1], mid[2]),
                new PhysX.PxQuat(q[0], q[1], q[2], q[3])));
        } else if (geom.type === 'box') {
            const he = geom.halfExtents;
            const g = new PhysX.PxBoxGeometry(he[0], he[1], he[2]);
            shape = this.physics.createShape(g, this.material, true, shapeFlags);
            const lp = geom.pos;
            shape.setLocalPose(new PhysX.PxTransform(
                new PhysX.PxVec3(lp[0], lp[1], lp[2]), new PhysX.PxQuat(0, 0, 0, 1)));
        } else if (geom.type === 'cylinder') {
            const r = geom.radius;
            const hh = geom.halfHeight || 0.015;
            const nSides = 16;
            const vec = new PhysX.Vector_PxVec3();
            for (let ring = 0; ring < 2; ring++) {
                const z = ring === 0 ? -hh : hh;
                for (let i = 0; i < nSides; i++) {
                    const a = (2 * Math.PI * i) / nSides;
                    vec.push_back(new PhysX.PxVec3(r * Math.cos(a), r * Math.sin(a), z));
                }
            }
            const desc = new PhysX.PxConvexMeshDesc();
            const bd = new PhysX.PxBoundedData();
            bd.set_count(vec.size());
            bd.set_stride(12);
            bd.set_data(vec.data());
            desc.set_points(bd);
            desc.set_flags(new PhysX.PxConvexFlags(PhysX.PxConvexFlagEnum.eCOMPUTE_CONVEX));
            const cookParams = new PhysX.PxCookingParams(new PhysX.PxTolerancesScale());
            const convexMesh = PhysX.PxTopLevelFunctions.prototype.CreateConvexMesh(cookParams, desc);
            if (convexMesh) {
                const g = new PhysX.PxConvexMeshGeometry(convexMesh);
                shape = this.physics.createShape(g, this.material, true, shapeFlags);
                if (geom.fromto) {
                    const ft = geom.fromto;
                    const p0 = [ft[0], ft[1], ft[2]], p1 = [ft[3], ft[4], ft[5]];
                    const mid = [(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2];
                    const dx = p1[0]-p0[0], dy = p1[1]-p0[1], dz = p1[2]-p0[2];
                    const len = Math.sqrt(dx*dx+dy*dy+dz*dz);
                    const dir = len > 0.001 ? [dx/len, dy/len, dz/len] : [0,0,1];
                    const q = quatFromTwoVec([0,0,1], dir);
                    shape.setLocalPose(new PhysX.PxTransform(
                        new PhysX.PxVec3(mid[0], mid[1], mid[2]),
                        new PhysX.PxQuat(q[0], q[1], q[2], q[3])));
                } else {
                    const lp = geom.pos || [0,0,0];
                    shape.setLocalPose(new PhysX.PxTransform(
                        new PhysX.PxVec3(lp[0], lp[1], lp[2]), new PhysX.PxQuat(0, 0, 0, 1)));
                }
            } else {
                const g = new PhysX.PxCapsuleGeometry(r, hh);
                shape = this.physics.createShape(g, this.material, true, shapeFlags);
                const lp = geom.pos || [0,0,0];
                const q = quatFromTwoVec([1,0,0], [0,0,1]);
                shape.setLocalPose(new PhysX.PxTransform(
                    new PhysX.PxVec3(lp[0], lp[1], lp[2]),
                    new PhysX.PxQuat(q[0], q[1], q[2], q[3])));
            }
        }
        return shape;
    }

    // -- world queries ---------------------------------------------------------

    // All grab/hover candidates: articulation links + buddy bodies.
    hoverTargets() {
        const out = [];
        for (const rec of this.articulations.values()) {
            for (const l of rec.links) {
                out.push({ id: rec.fq + '.' + l.name, actor: l.link, radius: l.radius });
            }
        }
        for (const [fqid, b] of this.dynBodies) {
            out.push({ id: fqid, actor: b.actor, radius: b.radius });
        }
        return out;
    }

    // Escape net for all articulations + dynamic bodies.
    rescueStrays(halfW) {
        const PhysX = this.PhysX;
        let rescued = 0;

        for (const [fqid, b] of this.dynBodies) {
            if (b.kinematic) continue;
            const p = b.actor.getGlobalPose().get_p();
            const x = p.get_x(), y = p.get_y(), z = p.get_z();
            if (isFinite(x) && isFinite(y) && isFinite(z) &&
                Math.abs(x) < halfW + 3 && Math.abs(y) < 6 && z > -3 && z < 90) {
                continue;
            }
            const nx = Math.max(-halfW + 1, Math.min(halfW - 1, isFinite(x) ? x : 0));
            b.actor.setGlobalPose(new PhysX.PxTransform(
                new PhysX.PxVec3(nx, 0, 2.0), new PhysX.PxQuat(0, 0, 0, 1)), true);
            b.actor.setLinearVelocity(new PhysX.PxVec3(0, 0, 0));
            b.actor.setAngularVelocity(new PhysX.PxVec3(0, 0, 0));
            rescued++;
        }

        for (const fq of this.articulations.keys()) {
            const root = this.articulationRootPose(fq);
            if (!root) continue;
            const [x, y, z] = root.pos;
            if (isFinite(x) && isFinite(y) && isFinite(z) &&
                Math.abs(x) < halfW + 3 && Math.abs(y) < 6 && z > -3 && z < 90) {
                continue;
            }
            const nx = Math.max(-halfW + 1, Math.min(halfW - 1, isFinite(x) ? x : 0));
            this.applyArticulationInit(fq, { x: nx });
            rescued++;
        }
        return rescued;
    }

    snapshotBodies() {
        const ids = [];
        const entries = [];
        for (const rec of this.articulations.values()) {
            for (const l of rec.links) {
                ids.push(rec.fq + '.' + l.name);
                entries.push(l.link);
            }
        }
        if (this.targetActor) {
            ids.push('sys/target');
            entries.push(this.targetActor);
        }
        for (const [fqid, b] of this.dynBodies) {
            ids.push(fqid);
            entries.push(b.actor);
        }
        const buf = new Float32Array(entries.length * 13);
        for (let i = 0; i < entries.length; i++) {
            const a = entries[i];
            const o = i * 13;
            const pose = a.getGlobalPose();
            const p = pose.get_p(), q = pose.get_q();
            buf[o] = p.get_x(); buf[o+1] = p.get_y(); buf[o+2] = p.get_z();
            buf[o+3] = q.get_x(); buf[o+4] = q.get_y(); buf[o+5] = q.get_z(); buf[o+6] = q.get_w();
            try {
                const v = a.getLinearVelocity(), w = a.getAngularVelocity();
                buf[o+7] = v.get_x(); buf[o+8] = v.get_y(); buf[o+9] = v.get_z();
                buf[o+10] = w.get_x(); buf[o+11] = w.get_y(); buf[o+12] = w.get_z();
            } catch (e) {}
        }
        return { ids, buf };
    }

    bodyPose(fqid) {
        let actor = null;
        if (fqid === 'sys/target') {
            actor = this.targetActor;
        } else if (this.dynBodies.has(fqid)) {
            actor = this.dynBodies.get(fqid).actor;
        } else {
            for (const rec of this.articulations.values()) {
                if (fqid.startsWith(rec.fq + '.')) {
                    const name = fqid.slice(rec.fq.length + 1);
                    const l = rec.links.find(x => x.name === name);
                    actor = l && l.link;
                    break;
                }
            }
        }
        if (!actor) return null;
        const pose = actor.getGlobalPose();
        const p = pose.get_p(), q = pose.get_q();
        return { pos: [p.get_x(), p.get_y(), p.get_z()], quat: [q.get_x(), q.get_y(), q.get_z(), q.get_w()] };
    }

    step() {
        this.scene.simulate(DT);
        this.scene.fetchResults(true);
    }
}

function geomBoundRadius(g) {
    const c = g.pos ? Math.hypot(g.pos[0], g.pos[1], g.pos[2]) : 0;
    if (g.type === 'sphere') return c + g.radius;
    if (g.type === 'capsule' && g.fromto) {
        const ft = g.fromto;
        return Math.max(Math.hypot(ft[0], ft[1], ft[2]), Math.hypot(ft[3], ft[4], ft[5])) + g.radius;
    }
    if (g.type === 'box') return c + Math.hypot(...(g.halfExtents || [0.1, 0.1, 0.1]));
    if (g.type === 'cylinder') return c + (g.radius || 0.05) + (g.halfHeight || 0);
    return c + 0.08;
}
