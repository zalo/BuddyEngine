// Wisp — demo Buddy API pack. A glowing shader orb bound to a physics ball
// that shares the PhysX world with the other buddies: it flees the cursor,
// startles when a humanoid gets close, and can be grabbed and thrown.
// Instanced: every wisp lives in this one cell.

export const meta = {
    name: 'Wisp',
    author: 'BuddyEngine',
    version: '2',
    description: 'A skittish glowing orb that shares the desktop with your buddies and flees the cursor.',
};

const buddy = await Buddy.ready();
buddy.log('wisp cell online');

// Pack-global geometry, shared by every instance as '$quad'.
buddy.gfx.geometry('quad', { type: 'plane', params: { w: 0.85, h: 0.85 } });

const GLOW_FRAG = `
    varying vec2 vUv;
    uniform float uTime;
    uniform float uPanic;
    uniform vec3 uTint;
    void main() {
        vec2 c = vUv - 0.5;
        float r = length(c);
        float wob = 0.03 * sin(uTime * 6.0 + atan(c.y, c.x) * 5.0);
        float core = smoothstep(0.16 + wob, 0.02, r);
        float halo = smoothstep(0.5, 0.1, r) * (0.35 + 0.15 * sin(uTime * 3.0));
        vec3 tint = mix(uTint, vec3(1.0, 0.4, 0.3), uPanic);
        vec3 col = tint * (halo + core * 1.6) + vec3(1.0) * core * 0.7;
        gl_FragColor = vec4(col, (core + halo));
    }`;
const GLOW_VERT = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

// Adjustable from the toybox sidebar.
const opts = { fleeRadius: 1.6, tintShift: 0 };
buddy.options({
    fleeRadius: { label: 'Cursor flee radius', type: 'range', value: opts.fleeRadius, min: 0, max: 4, step: 0.1 },
    tintShift: { label: 'Tint shift', type: 'range', value: 0, min: 0, max: 1, step: 0.05 },
}, (key, value) => { opts[key] = value; });

Buddy.instances((inst) => {
    const sx = inst.spawn.x !== undefined ? inst.spawn.x : 2.5 - (inst.iid % 5);
    const sz = inst.spawn.z !== undefined ? inst.spawn.z : 2.0;

    const ball = inst.phys.spawn('ball', {
        shape: { type: 'sphere', r: 0.14 },
        pos: [sx, 0, sz],
        mass: 0.5,
        restitution: 0.65,
        friction: 0.4,
        planar2D: true,
        angularDamping: 0.9,
    });

    // Per-instance material: node matParams updates mutate the material,
    // so sharing one across wisps would sync their flames.
    inst.gfx.material('glow', {
        type: 'shader',
        transparent: true,
        depthWrite: false,
        blending: 'additive',
        uniforms: { uTime: 0, uPanic: 0, uTint: [0.45, 0.8, 1.0] },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
    });
    const orb = inst.gfx.mesh('orb', { geo: '$quad', mat: 'glow' });
    orb.attach('ball', [0, 0, 0], [0.7071, 0, 0, 0.7071]);

    const AVATAR_RADIUS = 1.2;
    let panic = 0;
    let lastHop = 0;

    inst.onFrame((world) => {
        const me = world.bodies.get(inst.bodyId('ball'));
        if (!me) return;
        const [x, , z] = me.pos;

        panic = Math.max(0, panic - world.dt * 1.5);

        const dx = x - world.cursor.wx, dz = z - world.cursor.wz;
        const dCursor = Math.hypot(dx, dz);
        if (dCursor < opts.fleeRadius && world.time - lastHop > 0.25) {
            const s = 1.2 / Math.max(dCursor, 0.2);
            ball.impulse([dx * s * 0.4, 0, Math.abs(dz) * s * 0.25 + 0.55]);
            panic = 1;
            lastHop = world.time;
        }

        let pelvis = null;
        for (const [id, b] of world.bodies) {
            if (id.endsWith('.pelvis')) { pelvis = b; break; }
        }
        if (pelvis) {
            const ax = x - pelvis.pos[0], az = z - pelvis.pos[2];
            const d = Math.hypot(ax, az);
            if (d < AVATAR_RADIUS && world.time - lastHop > 0.4) {
                ball.impulse([Math.sign(ax || 1) * 0.9, 0, 0.8]);
                panic = 1;
                lastHop = world.time;
                buddy.bus.broadcast('wisp.startled', { at: [x, z] });
            }
        }

        for (const ev of world.events) {
            if (ev.type === 'pointerdown') panic = 1;
        }

        const halfW = inst.screen.wPx / 2 / inst.screen.ppm;
        if (Math.abs(x) > halfW - 0.5) ball.force([-Math.sign(x) * 2.0, 0, 0]);

        orb.set({
            matParams: {
                uTime: world.time % 1000,
                uPanic: panic,
                uTint: [0.45 + opts.tintShift * 0.5, 0.8 - opts.tintShift * 0.4, 1.0 - opts.tintShift * 0.6],
            },
        });
    });

    return {
        dispose() {
            orb.remove();
            ball.remove();
        },
    };
});
