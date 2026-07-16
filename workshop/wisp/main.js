// Wisp — demo Buddy API pack. A glowing shader orb bound to a physics ball
// that shares the PhysX world with the sword buddy: it flees the cursor,
// startles when the avatar gets close, and can be grabbed and thrown.

export const meta = {
    name: 'Wisp',
    author: 'BuddyEngine',
    version: '1',
    description: 'A skittish glowing orb that shares the desktop with your buddies and flees the cursor.',
};

const buddy = await Buddy.ready();
buddy.log('wisp online, instance', buddy.id);

// Physics: a bouncy ball in the shared world.
const ball = buddy.phys.spawn('ball', {
    shape: { type: 'sphere', r: 0.14 },
    pos: [2.5, 0, 2.0],
    mass: 0.5,
    restitution: 0.65,
    friction: 0.4,
    planar2D: true,        // 2D-sprite motion: X/Z only, spin on depth axis only
    angularDamping: 0.9,   // rolling contact can't wind up runaway spin
});

// Visuals: additive-blend shader glow on a camera-facing quad.
buddy.gfx.geometry('quad', { type: 'plane', params: { w: 0.85, h: 0.85 } });
buddy.gfx.material('glow', {
    type: 'shader',
    transparent: true,
    depthWrite: false,
    blending: 'additive',
    uniforms: { uTime: 0, uPanic: 0, uTint: [0.45, 0.8, 1.0] },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: `
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
        }`,
});
// Plane faces +Z; the attach offset rotates it to face the ortho camera
// (which looks along +Y). Attach overwrites the node transform each frame,
// so the rotation must live in the offset, not the node pose.
const orb = buddy.gfx.mesh('orb', { geo: 'quad', mat: 'glow' });
orb.attach('ball', [0, 0, 0], [0.7071, 0, 0, 0.7071]);

const FLEE_RADIUS = 1.6;
const AVATAR_RADIUS = 1.2;
let panic = 0;
let lastHop = 0;

buddy.onFrame((world) => {
    const me = world.bodies.get(buddy.id + '/ball');
    if (!me) return;
    const [x, , z] = me.pos;

    panic = Math.max(0, panic - world.dt * 1.5);

    // Flee the cursor.
    const dx = x - world.cursor.wx, dz = z - world.cursor.wz;
    const dCursor = Math.hypot(dx, dz);
    if (dCursor < FLEE_RADIUS && world.time - lastHop > 0.25) {
        const s = 1.2 / Math.max(dCursor, 0.2);
        ball.impulse([dx * s * 0.4, 0, Math.abs(dz) * s * 0.25 + 0.55]);
        panic = 1;
        lastHop = world.time;
    }

    // Startle when any humanoid's pelvis gets close (buddies own their
    // rigs now, so find one generically).
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

    // Pointer events from the host (it also handles grab/throw physics).
    for (const ev of world.events) {
        if (ev.type === 'pointerdown') panic = 1;
    }

    // Keep the wisp on-screen-ish: nudge back toward center if far out.
    const halfW = buddy.screen.wPx / 2 / buddy.screen.ppm;
    if (Math.abs(x) > halfW - 0.5) ball.force([-Math.sign(x) * 2.0, 0, 0]);

    // Animate the shader.
    orb.set({ matParams: { uTime: world.time % 1000, uPanic: panic } });
});
