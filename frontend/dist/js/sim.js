// PhysX world + humanoid articulation, ported from the SwordBrawl MimicKit
// strike demo. World is Z-up, meters. The desktop plane is X (screen right)
// by Z (screen up); Y is depth (out of the monitor).

import {
    quatRotateVec, quatMul, axisAngleToQuat, expMapToQuat,
    calcHeadingQuatInv, quatToTanNorm, quatFromTwoVec,
} from './math3d.js';

export const DT = 1 / 120;
export const POLICY_SUBSTEPS = 4; // control at 30Hz

export class SimWorld {
    constructor() {
        this.PhysX = null;
        this.physics = null;
        this.scene = null;
        this.material = null;
        this.articulation = null;
        this.links = [];          // { name, link, meshGroup }
        this.data = null;         // humanoidData
        this.origDrives = [];
        this.staticActors = new Map(); // key -> { actor, rect }
        this.targetActor = null;  // kinematic mouse target
        this.targetState = { pos: [2,0,0.9], vel: [0,0,0] };
        this.dynBodies = new Map(); // fqid -> { actor, radius, kinematic } (Buddy API bodies)
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

    // Filter data: statics act like ground (group 1, collides with 2|4).
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

    // Kinematic collider for things that move (windows, icons). Driven via
    // setKinematicTarget so PhysX derives a proper velocity for contacts —
    // dragging a window shoves the buddy instead of teleporting through it.
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
            goal: { cx, cz },
        });
        return actor;
    }

    // New desired position; updateKinematics() sweeps the actor there with
    // velocity. Jumps larger than teleportDist (snap/maximize, occlusion
    // reshuffles) teleport instead so they can't plow through the buddy.
    setKinematicGoal(key, cx, cz, teleportDist = 3.0) {
        const entry = this.staticActors.get(key);
        if (!entry || !entry.kinematic) return;
        if (Math.hypot(cx - entry.box.cx, cz - entry.box.cz) > teleportDist) {
            this.setKinematicPose(key, cx, cz);
            return;
        }
        entry.goal.cx = cx;
        entry.goal.cz = cz;
    }

    // Instant relocation without contact velocity (no shove).
    setKinematicPose(key, cx, cz) {
        const entry = this.staticActors.get(key);
        if (!entry || !entry.kinematic) return;
        const PhysX = this.PhysX;
        entry.box.cx = cx;
        entry.box.cz = cz;
        entry.goal.cx = cx;
        entry.goal.cz = cz;
        entry.actor.setGlobalPose(new PhysX.PxTransform(
            new PhysX.PxVec3(cx, entry.box.cy, entry.box.cz),
            new PhysX.PxQuat(0, 0, 0, 1)), true);
    }

    // Called every physics substep: move kinematic colliders smoothly toward
    // their goals so window drags become continuous sweeps with velocity.
    updateKinematics(dt) {
        const PhysX = this.PhysX;
        const tau = 0.08; // smoothing time constant, seconds
        const k = 1 - Math.exp(-dt / tau);
        for (const entry of this.staticActors.values()) {
            if (!entry.kinematic) continue;
            const b = entry.box;
            const dx = entry.goal.cx - b.cx;
            const dz = entry.goal.cz - b.cz;
            if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) continue;
            b.cx += dx * k;
            b.cz += dz * k;
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

    // Highest static surface top under (x) that is at or below z, used to
    // make observations height-relative so standing on windows stays in
    // distribution for the policy.
    supportHeightAt(x, z) {
        let best = 0; // ground
        for (const { box } of this.staticActors.values()) {
            if (box.wall) continue;
            const top = box.cz + box.hz;
            if (x >= box.cx - box.hx && x <= box.cx + box.hx && top <= z && top > best) {
                best = top;
            }
        }
        return best;
    }

    // -- mouse target (kinematic box the HLC tries to strike) ---------------

    createTarget() {
        const PhysX = this.PhysX;
        const shapeFlags = new PhysX.PxShapeFlags(this.enums.SHAPE_FLAGS);
        const geom = new PhysX.PxBoxGeometry(0.12, 0.12, 0.12);
        const shape = this.physics.createShape(geom, this.material, true, shapeFlags);
        shape.setSimulationFilterData(new PhysX.PxFilterData(4, 3, 0, 0));
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
            this.targetState.vel = [
                Math.max(-maxV, Math.min(maxV, (pos[0] - prev[0]) / dt)),
                Math.max(-maxV, Math.min(maxV, (pos[1] - prev[1]) / dt)),
                Math.max(-maxV, Math.min(maxV, (pos[2] - prev[2]) / dt)),
            ];
        }
        this.targetState.pos = pos.slice();
        const PhysX = this.PhysX;
        this.targetActor.setKinematicTarget(new PhysX.PxTransform(
            new PhysX.PxVec3(pos[0], pos[1], pos[2]),
            new PhysX.PxQuat(0, 0, 0, 1)));
    }

    // -- generic dynamic bodies (Buddy API) ----------------------------------

    // desc: {shape:{type,hx,hy,hz|r|hh}, pos, quat?, mass?, kinematic?,
    //        collides?:'all'|'world'|'none', friction?, restitution?}
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
        const f = filters[desc.collides || 'all'] || filters.all;
        shape.setSimulationFilterData(new PhysX.PxFilterData(f[0], f[1], 0, 0));

        const p = desc.pos || [0, 0, 1];
        const q = desc.quat || [0, 0, 0, 1];
        const pose = new PhysX.PxTransform(
            new PhysX.PxVec3(p[0], p[1], p[2]), new PhysX.PxQuat(q[0], q[1], q[2], q[3]));
        const actor = this.physics.createRigidDynamic(pose);
        actor.attachShape(shape);
        PhysX.PxRigidBodyExt.prototype.setMassAndUpdateInertia(actor, Math.max(0.01, desc.mass || 1.0));
        if (desc.kinematic) actor.setRigidBodyFlag(PhysX.PxRigidBodyFlagEnum.eKINEMATIC, true);
        actor.setAngularDamping(0.05);
        actor.setLinearDamping(0.01);
        if (typeof actor.setMaxLinearVelocity === 'function') actor.setMaxLinearVelocity(80.0);
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

    // Snapshot every dynamic body in the world for the Buddy API frame
    // packet: articulation links (sys/avatar/*), the strike target, and all
    // buddy-spawned bodies. Layout: [pos3 quat4 linvel3 angvel3] per body.
    snapshotBodies() {
        const ids = [];
        const entries = [];
        for (const l of this.links) {
            ids.push('sys/avatar/' + l.name);
            entries.push(l.link);
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

    // Escape net: teleport any Buddy-API body that leaves the play volume
    // back above the ground with zeroed velocity. Returns rescued count.
    rescueStrayBodies(halfW) {
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
        return rescued;
    }

    bodyPose(fqid) {
        let actor = null;
        if (fqid.startsWith('sys/avatar/')) {
            const name = fqid.slice('sys/avatar/'.length);
            const l = this.links.find(x => x.name === name);
            actor = l && l.link;
        } else if (fqid === 'sys/target') {
            actor = this.targetActor;
        } else {
            const b = this.dynBodies.get(fqid);
            actor = b && b.actor;
        }
        if (!actor) return null;
        const pose = actor.getGlobalPose();
        const p = pose.get_p(), q = pose.get_q();
        return { pos: [p.get_x(), p.get_y(), p.get_z()], quat: [q.get_x(), q.get_y(), q.get_z(), q.get_w()] };
    }

    // -- articulation --------------------------------------------------------

    buildArticulation(humanoidData, spawn) {
        const PhysX = this.PhysX;
        const E = this.enums;
        this.data = humanoidData;

        const shapeFlags = new PhysX.PxShapeFlags(E.SHAPE_FLAGS);
        const rbext = PhysX.PxRigidBodyExt.prototype;

        const articulation = this.physics.createArticulationReducedCoordinate();
        this.articulation = articulation;
        articulation.setSolverIterationCounts(4, 0);
        if (typeof articulation.setSleepThreshold === 'function') articulation.setSleepThreshold(5e-5);
        if (typeof articulation.setStabilizationThreshold === 'function') articulation.setStabilizationThreshold(1e-5);
        articulation.setArticulationFlag(PhysX.PxArticulationFlagEnum.eDISABLE_SELF_COLLISION, true);

        const bodyLinkMap = {};
        this.links = [];

        for (const body of humanoidData.bodies) {
            const wp = body.pos;
            const zOff = humanoidData.tpose_pelvis_z || humanoidData.pelvis_z;
            const pose = new PhysX.PxTransform(
                new PhysX.PxVec3(wp[0], wp[1], wp[2] + zOff),
                new PhysX.PxQuat(0, 0, 0, 1)
            );

            const parentLink = body.parent ? bodyLinkMap[body.parent] : null;
            const link = articulation.createLink(parentLink, pose);

            for (const geom of body.geoms) {
                const shape = this.createGeomShape(geom, shapeFlags);
                if (shape) {
                    shape.setSimulationFilterData(new PhysX.PxFilterData(2, 5, 0, 0));
                    link.attachShape(shape);
                }
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
            link.setMaxLinearVelocity(80.0);   // below tunneling speed for the containment walls
            link.setMaxAngularVelocity(1000.0);
            if (typeof link.setSleepThreshold === 'function') link.setSleepThreshold(5e-5);
            if (typeof link.setStabilizationThreshold === 'function') link.setStabilizationThreshold(1e-5);
            if (typeof link.setCfmScale === 'function') link.setCfmScale(0.025);
            if (typeof link.setRigidBodyFlag === 'function') {
                try { link.setRigidBodyFlag(PhysX.PxRigidBodyFlagEnum.eENABLE_GYROSCOPIC_FORCES, true); } catch(e) {}
            }

            bodyLinkMap[body.name] = link;
            this.links.push({ name: body.name, link, meshGroup: null });
        }

        // Joints
        const axisEnums = [E.TWIST, E.SWING1, E.SWING2];
        this.origDrives.length = 0;

        for (const jdata of humanoidData.joints) {
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
                    this.origDrives.push({ joint, axisEnum: axE, stiffness: ax.stiffness, damping: ax.damping, maxForce: ax.maxForce });
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
                this.origDrives.push({ joint, axisEnum: E.TWIST, stiffness: ax.stiffness, damping: ax.damping, maxForce: ax.maxForce });
                joint.setMotion(E.SWING1, E.LOCKED);
                joint.setMotion(E.SWING2, E.LOCKED);
            }
        }

        for (const fj of humanoidData.fixedJoints) {
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
        this.applyInitPose(spawn);
    }

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

    // spawn: optional { x, z } world offset for the root.
    applyInitPose(spawn) {
        const PhysX = this.PhysX;
        const E = this.enums;
        const data = this.data;
        if (!data.init_root_pos || !data.init_dof_pos) return;

        const rp = data.init_root_pos.slice();
        if (spawn) {
            rp[0] = spawn.x !== undefined ? spawn.x : rp[0];
            rp[1] = 0;
            if (spawn.z !== undefined) rp[2] += spawn.z;
        }
        const rq = data.init_root_rot_quat;
        const initDof = data.init_dof_pos;

        this.articulation.setRootGlobalPose(new PhysX.PxTransform(
            new PhysX.PxVec3(rp[0], rp[1], rp[2]),
            new PhysX.PxQuat(rq[0], rq[1], rq[2], rq[3])), true);

        const axisEnums = [E.TWIST, E.SWING1, E.SWING2];
        const bodyLinkMap = {};
        for (const l of this.links) bodyLinkMap[l.name] = l.link;
        for (let i = 0; i < data.dofInfo.length; i++) {
            const dof = data.dofInfo[i];
            const cl = bodyLinkMap[dof.child_body];
            if (!cl) continue;
            try {
                cl.getInboundJoint().setJointPosition(axisEnums[dof.physx_axis], initDof[i]);
                cl.getInboundJoint().setJointVelocity(axisEnums[dof.physx_axis], 0);
            } catch(e) {}
        }
        const initFlags = new PhysX.PxArticulationCacheFlags(PhysX.PxArticulationCacheFlagEnum.eALL);
        const initCache = this.articulation.createCache();
        this.articulation.copyInternalStateToCache(initCache, initFlags);
        this.articulation.applyCache(initCache, initFlags, true);

        for (let i = 0; i < data.dofInfo.length; i++) {
            const dof = data.dofInfo[i];
            const childLink = bodyLinkMap[dof.child_body];
            if (!childLink) continue;
            try {
                childLink.getInboundJoint().setDriveTarget(axisEnums[dof.physx_axis], initDof[i]);
            } catch(e) {}
        }
    }

    removeArticulation() {
        if (this.articulation) {
            this.scene.removeArticulation(this.articulation);
            this.articulation = null;
            this.links = [];
        }
    }

    rootPose() {
        const pose = this.links[0].link.getGlobalPose();
        const p = pose.get_p(), q = pose.get_q();
        return {
            pos: [p.get_x(), p.get_y(), p.get_z()],
            rot: [q.get_x(), q.get_y(), q.get_z(), q.get_w()],
        };
    }

    // -- observations --------------------------------------------------------

    // supportZ shifts all absolute heights so the policy believes the surface
    // it stands on is the ground it was trained on.
    buildObservation(supportZ) {
        const E = this.enums;
        const data = this.data;
        const obs = new Float32Array(data.obs_dim);
        const axisEnums = [E.TWIST, E.SWING1, E.SWING2];

        const bodyLinkMap = {};
        for (const l of this.links) bodyLinkMap[l.name] = l.link;

        const root = this.rootPose();
        const rootPos = root.pos, rootRot = root.rot;

        const rv = this.links[0].link.getLinearVelocity();
        const rootVel = [rv.get_x(), rv.get_y(), rv.get_z()];
        const raw = this.links[0].link.getAngularVelocity();
        const rootAngVel = [raw.get_x(), raw.get_y(), raw.get_z()];

        const headingInv = calcHeadingQuatInv(rootRot);

        let idx = 0;
        obs[idx++] = rootPos[2] - supportZ;

        const localRootRot = quatMul(headingInv, rootRot);
        const rootTanNorm = quatToTanNorm(localRootRot);
        for (let i = 0; i < 6; i++) obs[idx++] = rootTanNorm[i];

        const localVel = quatRotateVec(headingInv, rootVel);
        obs[idx++] = localVel[0]; obs[idx++] = localVel[1]; obs[idx++] = localVel[2];
        const localAngVel = quatRotateVec(headingInv, rootAngVel);
        obs[idx++] = localAngVel[0]; obs[idx++] = localAngVel[1]; obs[idx++] = localAngVel[2];

        const dofPositions = new Float32Array(data.dofInfo.length);
        for (let i = 0; i < data.dofInfo.length; i++) {
            const dof = data.dofInfo[i];
            const childLink = bodyLinkMap[dof.child_body];
            if (childLink) {
                try {
                    dofPositions[i] = childLink.getInboundJoint().getJointPosition(axisEnums[dof.physx_axis]);
                } catch(e) { dofPositions[i] = 0; }
            }
        }

        for (const kj of data.kinematicJoints) {
            let quat;
            if (kj.type === 'SPHERICAL') {
                quat = expMapToQuat(dofPositions[kj.dof_idx], dofPositions[kj.dof_idx + 1], dofPositions[kj.dof_idx + 2]);
            } else if (kj.type === 'HINGE') {
                quat = axisAngleToQuat(kj.axis, dofPositions[kj.dof_idx]);
            } else {
                quat = [0, 0, 0, 1];
            }
            const tn = quatToTanNorm(quat);
            for (let k = 0; k < 6; k++) obs[idx++] = tn[k];
        }

        for (const dof of data.dofInfo) {
            try {
                const childLink = bodyLinkMap[dof.child_body];
                if (childLink) {
                    obs[idx++] = childLink.getInboundJoint().getJointVelocity(axisEnums[dof.physx_axis]);
                } else { obs[idx++] = 0; }
            } catch(e) { obs[idx++] = 0; }
        }

        const keyIds = data.key_body_ids || [2, 5, 10, 13, 16, 6];
        for (const bid of keyIds) {
            const lp = this.links[bid].link.getGlobalPose().get_p();
            const rel = [lp.get_x() - rootPos[0], lp.get_y() - rootPos[1], lp.get_z() - rootPos[2]];
            const localRel = quatRotateVec(headingInv, rel);
            obs[idx++] = localRel[0]; obs[idx++] = localRel[1]; obs[idx++] = localRel[2];
        }

        return obs;
    }

    // ASE Strike task obs (15): local_tar_pos(3) + local_tar_rot tan/norm(6) +
    // local_tar_vel(3) + local_tar_ang_vel(3). Target = the mouse cursor.
    buildTaskObs(supportZ) {
        const taskObs = new Float32Array(15);
        const root = this.rootPose();
        const headingInv = calcHeadingQuatInv(root.rot);

        const tarPos = this.targetState.pos;
        const tarVel = this.targetState.vel;

        let idx = 0;
        // ASE uses absolute Z; make it support-relative AND clamp to the
        // strike-reachable band the HLC was trained on (pillar height), so a
        // cursor at the top of the screen reads as "high but reachable".
        const relZ = Math.min(Math.max(tarPos[2] - supportZ, 0.2), 2.2);
        const tarRel = [
            tarPos[0] - root.pos[0],
            tarPos[1] - root.pos[1],
            relZ,
        ];
        const localTarPos = quatRotateVec(headingInv, tarRel);
        taskObs[idx++] = localTarPos[0];
        taskObs[idx++] = localTarPos[1];
        taskObs[idx++] = localTarPos[2];

        // Target rotation: identity in heading frame.
        const tarTanNorm = quatToTanNorm(quatMul(headingInv, [0, 0, 0, 1]));
        for (let i = 0; i < 6; i++) taskObs[idx++] = tarTanNorm[i];

        const localTarVel = quatRotateVec(headingInv, tarVel);
        taskObs[idx++] = localTarVel[0];
        taskObs[idx++] = localTarVel[1];
        taskObs[idx++] = localTarVel[2];

        // Angular velocity: zero (cursor doesn't spin).
        taskObs[idx++] = 0; taskObs[idx++] = 0; taskObs[idx++] = 0;

        return taskObs;
    }

    applyActions(action) {
        const E = this.enums;
        const data = this.data;
        const axisEnums = [E.TWIST, E.SWING1, E.SWING2];
        const bodyLinkMap = {};
        for (const l of this.links) bodyLinkMap[l.name] = l.link;

        const aLow = data.action_low, aHigh = data.action_high;
        for (let i = 0; i < data.dofInfo.length; i++) {
            const dof = data.dofInfo[i];
            const childLink = bodyLinkMap[dof.child_body];
            if (!childLink) continue;
            try {
                const joint = childLink.getInboundJoint();
                if (!joint) continue;
                let a = action[i];
                if (aLow && aHigh) a = Math.max(aLow[i], Math.min(aHigh[i], a));
                joint.setDriveTarget(axisEnums[dof.physx_axis], a);
            } catch(e) {}
        }
    }

    step() {
        this.scene.simulate(DT);
        this.scene.fetchResults(true);
    }
}
