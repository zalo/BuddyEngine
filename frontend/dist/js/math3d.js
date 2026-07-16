// Quaternion / vector helpers shared by the MJCF parser, observation
// builders and articulation code. Quaternions are [x, y, z, w] unless noted.

export function normalize(v) {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return n < 1e-12 ? v : v.map(x => x / n);
}

export function cross(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

export function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

export function getRotationQuat(from, to) {
    const u = normalize(from), v = normalize(to);
    const d = dot(u, v);
    if (d > 1 - 1e-6) return [0, 0, 0, 1];
    if (d < 1e-6 - 1) {
        let axis = cross([1,0,0], u);
        if (dot(axis, axis) < 1e-6) axis = cross([0,1,0], u);
        axis = normalize(axis);
        return [axis[0], axis[1], axis[2], 0];
    }
    const c = cross(u, v);
    const s = Math.sqrt((1 + d) * 2), inv = 1 / s;
    const q = [c[0]*inv, c[1]*inv, c[2]*inv, 0.5*s];
    const qn = Math.sqrt(q.reduce((s2, x) => s2 + x * x, 0));
    return q.map(x => x / qn);
}

export function quatRotateVec(q, v) {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    const tx = 2 * (qy*vz - qz*vy);
    const ty = 2 * (qz*vx - qx*vz);
    const tz = 2 * (qx*vy - qy*vx);
    return [
        vx + qw*tx + (qy*tz - qz*ty),
        vy + qw*ty + (qz*tx - qx*tz),
        vz + qw*tz + (qx*ty - qy*tx)
    ];
}

export function quatMul(a, b) {
    const [ax,ay,az,aw] = a, [bx,by,bz,bw] = b;
    return [
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw,
        aw*bw - ax*bx - ay*by - az*bz
    ];
}

export function quatNorm(q) {
    const [x,y,z,w] = q;
    const len = Math.sqrt(x*x + y*y + z*z + w*w) || 1;
    return [x/len, y/len, z/len, w/len];
}

export function axisAngleToQuat(axis, angle) {
    const ha = angle * 0.5;
    const s = Math.sin(ha), c = Math.cos(ha);
    const len = Math.sqrt(axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]) || 1;
    return quatNorm([axis[0]/len*s, axis[1]/len*s, axis[2]/len*s, c]);
}

export function expMapToQuat(ex, ey, ez) {
    const angle = Math.sqrt(ex*ex + ey*ey + ez*ez);
    if (angle < 1e-5) return [0, 0, 0, 1];
    return axisAngleToQuat([ex/angle, ey/angle, ez/angle], angle);
}

export function calcHeading(q) {
    const rotDir = quatRotateVec(q, [1, 0, 0]);
    return Math.atan2(rotDir[1], rotDir[0]);
}

export function calcHeadingQuatInv(q) {
    return axisAngleToQuat([0, 0, 1], -calcHeading(q));
}

export function quatToTanNorm(q) {
    const tan = quatRotateVec(q, [1, 0, 0]);
    const norm = quatRotateVec(q, [0, 0, 1]);
    return [tan[0], tan[1], tan[2], norm[0], norm[1], norm[2]];
}

export function mat33ToQuat(cols) {
    const [m00,m10,m20] = cols[0], [m01,m11,m21] = cols[1], [m02,m12,m22] = cols[2];
    const tr = m00 + m11 + m22;
    let x, y, z, w;
    if (tr >= 0) {
        const h = Math.sqrt(tr + 1); w = 0.5*h; const f = 0.5/h;
        x = (m21-m12)*f; y = (m02-m20)*f; z = (m10-m01)*f;
    } else {
        let i = 0;
        if (m11 > m00) i = 1;
        if (m22 > [m00,m11,m22][i]) i = 2;
        if (i === 0) {
            const h = Math.sqrt(m00-m11-m22+1); x = 0.5*h; const f = 0.5/h;
            y = (m01+m10)*f; z = (m20+m02)*f; w = (m21-m12)*f;
        } else if (i === 1) {
            const h = Math.sqrt(m11-m22-m00+1); y = 0.5*h; const f = 0.5/h;
            z = (m12+m21)*f; x = (m01+m10)*f; w = (m02-m20)*f;
        } else {
            const h = Math.sqrt(m22-m00-m11+1); z = 0.5*h; const f = 0.5/h;
            x = (m20+m02)*f; y = (m12+m21)*f; w = (m10-m01)*f;
        }
    }
    return quatNorm([x,y,z,w]);
}

export function quatFromTwoVec(from, to) {
    const [fx,fy,fz] = from, [tx,ty,tz] = to;
    const d = fx*tx + fy*ty + fz*tz;
    if (d > 0.999999) return [0,0,0,1];
    if (d < -0.999999) {
        let ax = [0, -fz, fy];
        if (Math.abs(fx) > 0.9) ax = [fz, 0, -fx];
        const len = Math.sqrt(ax[0]*ax[0]+ax[1]*ax[1]+ax[2]*ax[2]);
        return [ax[0]/len, ax[1]/len, ax[2]/len, 0];
    }
    const cx = fy*tz - fz*ty, cy = fz*tx - fx*tz, cz = fx*ty - fy*tx;
    const w = 1 + d;
    const len = Math.sqrt(cx*cx + cy*cy + cz*cz + w*w);
    return [cx/len, cy/len, cz/len, w/len];
}

export function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
