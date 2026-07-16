// MJCF (MuJoCo XML) parser — ported from the SwordBrawl MimicKit web demo.
// Converts the MJCF baked into the LLC ONNX metadata into the humanoidData
// structure used to build the PhysX articulation.

import { normalize, cross, dot, getRotationQuat, quatRotateVec, mat33ToQuat } from './math3d.js';

function computeJointFrame(jointAxes) {
    const axisMap = [0, 1, 2];
    const n = jointAxes.length;
    if (n === 0) return { q: [0,0,0,1], axisMap };
    if (n === 1) return { q: getRotationQuat([1,0,0], jointAxes[0]), axisMap };

    const Q = getRotationQuat(jointAxes[0], [1,0,0]);
    const b = normalize(quatRotateVec(Q, jointAxes[1]));

    if (n === 2) {
        if (Math.abs(dot(b,[0,1,0])) > Math.abs(dot(b,[0,0,1]))) {
            axisMap[1] = 1;
            const c = normalize(cross(jointAxes[0], jointAxes[1]));
            return { q: mat33ToQuat([normalize(jointAxes[0]), normalize(jointAxes[1]), c]), axisMap };
        } else {
            axisMap[1] = 2; axisMap[2] = 1;
            const c = normalize(cross(jointAxes[1], jointAxes[0]));
            return { q: mat33ToQuat([normalize(jointAxes[0]), c, normalize(jointAxes[1])]), axisMap };
        }
    }
    if (Math.abs(dot(b,[0,1,0])) > Math.abs(dot(b,[0,0,1]))) {
        axisMap[1] = 1; axisMap[2] = 2;
        return { q: mat33ToQuat([normalize(jointAxes[0]), normalize(jointAxes[1]), normalize(jointAxes[2])]), axisMap };
    } else {
        axisMap[1] = 2; axisMap[2] = 1;
        return { q: mat33ToQuat([normalize(jointAxes[0]), normalize(jointAxes[2]), normalize(jointAxes[1])]), axisMap };
    }
}

function parseVec(s, n) {
    if (!s) return null;
    const parts = s.trim().split(/\s+/).map(Number);
    return n ? parts.slice(0, n) : parts;
}

export function parseMJCF(xmlText, opts = {}) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const root = doc.documentElement;

    let fixedBodies = opts.fixedBodies;
    if (!fixedBodies) {
        fixedBodies = new Set();
        const scan = (el, isRoot) => {
            if (!isRoot) {
                const hinges = [...el.querySelectorAll(':scope > joint')].filter(
                    j => (j.getAttribute('type') || 'hinge') !== 'free');
                const freeJ = el.querySelector(':scope > freejoint');
                if (!hinges.length && !freeJ) fixedBodies.add(el.getAttribute('name'));
            }
            for (const child of el.querySelectorAll(':scope > body')) scan(child, false);
        };
        for (const b of root.querySelector('worldbody').querySelectorAll(':scope > body'))
            scan(b, true);
    }

    const actuatorMap = {};
    const actuatorOrder = [];
    const actuatorSec = root.querySelector('actuator');
    if (actuatorSec) {
        for (const mot of actuatorSec.querySelectorAll('motor')) {
            const jname = mot.getAttribute('joint');
            if (!jname) continue;
            const gear = parseFloat(mot.getAttribute('gear') || '1');
            const frc = parseVec(mot.getAttribute('actuatorfrcrange'), 2);
            const maxForce = frc ? Math.max(Math.abs(frc[0]), Math.abs(frc[1])) : gear;
            actuatorMap[jname] = { gear, maxForce };
            actuatorOrder.push(jname);
        }
    }

    const bodies = [], joints = [], fixedJoints = [];
    const PI = Math.PI;

    function processBody(el, parentName, parentWorldPos) {
        const name = el.getAttribute('name');
        const localPos = parseVec(el.getAttribute('pos'), 3) || [0,0,0];
        const worldPos = localPos.map((v, i) => parentWorldPos[i] + v);

        const geoms = [];
        for (const ge of el.querySelectorAll(':scope > geom')) {
            const g = { name: ge.getAttribute('name') || name, type: ge.getAttribute('type') || 'sphere' };
            g.pos = parseVec(ge.getAttribute('pos'), 3) || [0,0,0];
            if (ge.getAttribute('size')) g.size = parseVec(ge.getAttribute('size'));
            if (g.type === 'sphere') g.radius = g.size[0];
            else if (g.type === 'capsule') {
                g.radius = g.size[0];
                if (ge.getAttribute('fromto')) g.fromto = parseVec(ge.getAttribute('fromto'), 6);
            } else if (g.type === 'box') {
                g.halfExtents = g.size.slice(0, 3);
            } else if (g.type === 'cylinder') {
                g.radius = g.size[0];
                if (g.size.length > 1) g.halfHeight = g.size[1];
                if (ge.getAttribute('fromto')) {
                    g.fromto = parseVec(ge.getAttribute('fromto'), 6);
                    const ft = g.fromto;
                    g.halfHeight = Math.sqrt((ft[3]-ft[0])**2+(ft[4]-ft[1])**2+(ft[5]-ft[2])**2) / 2;
                }
                if (!g.halfHeight) g.halfHeight = 0.1;
            }
            g.density = parseFloat(ge.getAttribute('density') || '1000');
            geoms.push(g);
        }

        function geomMassAndCenter(g) {
            let volume = 0, center = g.pos.slice();
            if (g.type === 'sphere') {
                volume = (4/3) * PI * g.radius ** 3;
            } else if (g.type === 'capsule' && g.fromto) {
                const ft = g.fromto, r = g.radius;
                const halfH = Math.sqrt((ft[3]-ft[0])**2+(ft[4]-ft[1])**2+(ft[5]-ft[2])**2) / 2;
                volume = PI * r*r * (2*halfH) + (4/3) * PI * r**3;
                center = [(ft[0]+ft[3])/2, (ft[1]+ft[4])/2, (ft[2]+ft[5])/2];
            } else if (g.type === 'capsule') {
                const r = g.radius, hh = g.size.length > 1 ? g.size[1] : 0.1;
                volume = PI * r*r * (2*hh) + (4/3) * PI * r**3;
            } else if (g.type === 'box') {
                const he = g.halfExtents || g.size.slice(0,3);
                volume = 8 * he[0] * he[1] * he[2];
            } else if (g.type === 'cylinder') {
                const r = g.radius, hh = g.halfHeight || 0.1;
                volume = PI * r*r * (2*hh);
                if (g.fromto) {
                    const ft = g.fromto;
                    center = [(ft[0]+ft[3])/2, (ft[1]+ft[4])/2, (ft[2]+ft[5])/2];
                }
            }
            return { mass: volume * g.density, center, volume };
        }

        function capsuleInertia(g) {
            const ft = g.fromto, r = g.radius;
            const dx = ft[3]-ft[0], dy = ft[4]-ft[1], dz = ft[5]-ft[2];
            const L = Math.sqrt(dx*dx+dy*dy+dz*dz);
            const halfH = L / 2;
            const cylM = PI * r*r * L * g.density;
            const sphM = (4/3) * PI * r**3 * g.density;
            const cylIaxial = cylM * r*r / 2;
            const cylIperp = cylM * (3*r*r + L*L) / 12;
            const sphIaxial = 2 * sphM * r*r / 5;
            const sphIperp = sphIaxial + sphM * (3*r/8 + halfH)**2;
            const Iaxial = cylIaxial + sphIaxial;
            const Iperp = cylIperp + sphIperp;
            if (L < 1e-10) return [Iperp, Iperp, Iperp];
            const ax = [dx/L, dy/L, dz/L];
            return [
                Iperp + (Iaxial - Iperp) * ax[0]*ax[0],
                Iperp + (Iaxial - Iperp) * ax[1]*ax[1],
                Iperp + (Iaxial - Iperp) * ax[2]*ax[2],
            ];
        }

        let totalMass = 0;
        let com = [0, 0, 0];
        const geomData = geoms.map(g => {
            const { mass, center } = geomMassAndCenter(g);
            return { g, mass, center };
        });
        for (const { mass, center } of geomData) {
            com[0] += mass * center[0];
            com[1] += mass * center[1];
            com[2] += mass * center[2];
            totalMass += mass;
        }
        if (totalMass > 0) com = com.map(c => c / totalMass);

        let inertia = [0, 0, 0];
        for (const { g, mass, center } of geomData) {
            let Ii;
            if (g.type === 'sphere') {
                const I = (2/5) * mass * g.radius**2;
                Ii = [I, I, I];
            } else if (g.type === 'capsule' && g.fromto) {
                Ii = capsuleInertia(g);
            } else if (g.type === 'box') {
                const he = g.halfExtents || g.size.slice(0,3);
                const a=2*he[0], b=2*he[1], c=2*he[2];
                Ii = [mass*(b*b+c*c)/12, mass*(a*a+c*c)/12, mass*(a*a+b*b)/12];
            } else if (g.type === 'cylinder') {
                const r = g.radius, hh = g.halfHeight || 0.015;
                const Iaxial = mass * r*r / 2;
                const Iperp = mass * (3*r*r + (2*hh)**2) / 12;
                if (g.fromto) {
                    const ft = g.fromto, L = 2*hh;
                    const ddx = ft[3]-ft[0], ddy = ft[4]-ft[1], ddz = ft[5]-ft[2];
                    if (L > 1e-10) {
                        const ax = [ddx/L, ddy/L, ddz/L];
                        Ii = [Iperp + (Iaxial-Iperp)*ax[0]*ax[0],
                              Iperp + (Iaxial-Iperp)*ax[1]*ax[1],
                              Iperp + (Iaxial-Iperp)*ax[2]*ax[2]];
                    } else { Ii = [Iperp, Iperp, Iaxial]; }
                } else { Ii = [Iperp, Iperp, Iaxial]; }
            } else {
                Ii = [0, 0, 0];
            }
            const dx = center[0]-com[0], dy = center[1]-com[1], dz = center[2]-com[2];
            inertia[0] += Ii[0] + mass*(dy*dy+dz*dz);
            inertia[1] += Ii[1] + mass*(dx*dx+dz*dz);
            inertia[2] += Ii[2] + mass*(dx*dx+dy*dy);
        }

        bodies.push({ name, parent: parentName, pos: worldPos, localPos, geoms,
                       mass: totalMass, inertia, com });

        const jointEls = [...el.querySelectorAll(':scope > joint')].filter(
            j => (j.getAttribute('type') || 'hinge') !== 'free' && j.tagName !== 'freejoint');

        if (fixedBodies.has(name)) {
            fixedJoints.push({ name: name+'_fixed', parent_body: parentName, child_body: name, localPos0: localPos });
        } else if (jointEls.length && parentName !== null) {
            const axesData = [], jointAxes = [];
            for (const je of jointEls) {
                const axis = parseVec(je.getAttribute('axis') || '1 0 0', 3);
                jointAxes.push(axis);
                const rng = parseVec(je.getAttribute('range') || '-3.14159 3.14159', 2);
                const jname = je.getAttribute('name');
                const act = actuatorMap[jname] || { gear: 100, maxForce: 100 };
                axesData.push({
                    name: jname, mjcf_axis: axis,
                    stiffness: parseFloat(je.getAttribute('stiffness') || '0'),
                    damping: parseFloat(je.getAttribute('damping') || '0'),
                    maxForce: act.maxForce,
                    range: rng,
                    armature: parseFloat(je.getAttribute('armature') || '0'),
                });
            }

            const { q, axisMap } = computeJointFrame(jointAxes);
            const localRot = [q[3], q[0], q[1], q[2]];

            joints.push({
                name: jointEls.length > 1 ? jointEls[0].getAttribute('name').replace(/_[^_]+$/, '') : jointEls[0].getAttribute('name'),
                parent_body: parentName, child_body: name,
                axes: axesData,
                axisMap: axisMap.slice(0, jointEls.length),
                localPos0: localPos,
                localRot,
                jointType: jointEls.length > 1 ? 'spherical' : 'revolute',
            });
        }

        for (const child of el.querySelectorAll(':scope > body'))
            processBody(child, name, worldPos);
    }

    const worldbody = root.querySelector('worldbody');
    const pelvis = worldbody.querySelector(':scope > body');
    const pelvisPos = parseVec(pelvis.getAttribute('pos'), 3) || [0,0,0];
    processBody(pelvis, null, pelvisPos);

    const dofInfo = [];
    for (const actName of actuatorOrder) {
        for (const jdata of joints) {
            for (let ai = 0; ai < jdata.axes.length; ai++) {
                if (jdata.axes[ai].name === actName) {
                    dofInfo.push({
                        joint_name: jdata.name, axis_name: actName,
                        physx_axis: jdata.axisMap[ai], child_body: jdata.child_body,
                    });
                    break;
                }
            }
        }
    }

    const bodyNames = bodies.map(b => b.name);
    const fk_parent_indices = bodies.map(b => b.parent === null ? -1 : bodyNames.indexOf(b.parent));
    const fk_local_translations = bodies.map(b => b.localPos);
    const fk_local_rotations = bodies.map(() => [0, 0, 0, 1]);

    const kinematicJoints = [];
    let dofIdx = 0;
    for (let bi = 1; bi < bodies.length; bi++) {
        const bname = bodies[bi].name;
        const jdata = joints.find(j => j.child_body === bname);
        const fjdata = fixedJoints.find(j => j.child_body === bname);
        if (jdata) {
            const nDofs = jdata.axes.length;
            kinematicJoints.push({
                name: jdata.name, child_body: bname,
                type: nDofs > 1 ? 'SPHERICAL' : 'HINGE',
                dof_idx: dofIdx, dof_dim: nDofs,
                axis: nDofs === 1 ? jdata.axes[0].mjcf_axis : undefined,
            });
            dofIdx += nDofs;
        } else if (fjdata) {
            kinematicJoints.push({ name: fjdata.name, child_body: bname, type: 'FIXED', dof_idx: dofIdx, dof_dim: 0 });
        } else {
            kinematicJoints.push({ name: bname, child_body: bname, type: 'FIXED', dof_idx: dofIdx, dof_dim: 0 });
        }
    }

    return {
        bodies, joints, fixedJoints, actuatorOrder, dofInfo,
        fk_parent_indices, fk_local_translations, fk_local_rotations,
        kinematicJoints,
        act_dim: actuatorOrder.length,
    };
}

// Extracts the mimickit_config JSON blob baked into an ONNX file's metadata.
export function extractOnnxMetadata(buffer) {
    const bytes = new Uint8Array(buffer);
    const sentinel = 'mimickit_config';
    const sentinelBytes = new TextEncoder().encode(sentinel);

    for (let i = 0; i < bytes.length - sentinelBytes.length - 10; i++) {
        let match = true;
        for (let j = 0; j < sentinelBytes.length; j++) {
            if (bytes[i + j] !== sentinelBytes[j]) { match = false; break; }
        }
        if (!match) continue;

        const searchStart = i + sentinelBytes.length;
        for (let k = searchStart; k < Math.min(searchStart + 20, bytes.length); k++) {
            if (bytes[k] === 0x12) {
                let len = 0, shift = 0, pos = k + 1;
                while (pos < bytes.length) {
                    const b = bytes[pos++];
                    len |= (b & 0x7f) << shift;
                    shift += 7;
                    if ((b & 0x80) === 0) break;
                }
                if (len > 0 && pos + len <= bytes.length) {
                    const jsonStr = new TextDecoder().decode(bytes.slice(pos, pos + len));
                    try {
                        return JSON.parse(jsonStr);
                    } catch(e) {
                        console.log('Found sentinel but JSON parse failed:', e.message);
                    }
                }
                break;
            }
        }
    }
    console.log('No mimickit_config found in ONNX binary');
    return null;
}
