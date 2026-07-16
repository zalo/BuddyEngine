// Mario — a libsm64 buddy. The actual Super Mario 64 movement code runs as
// WASM inside this cell (built from libsm64 + native/mario_buddy.c; see
// native/build.sh), fed by the ROM that ships in this pack.
//
// The desktop's PhysX colliders (windows, icons, ground, screen walls) are
// streamed into libsm64 as SM64 collision surfaces every frame — windows
// become movable surface objects Mario can stand on and be squished around
// by. Mario is mirrored back into the shared PhysX world as a dynamic box
// proxy, so he pushes toys around, other buddies see him, and the host's
// grab/throw spring works on him. Mario's real N64 geometry is rendered
// in-cell (WebGL2 → OffscreenCanvas) and published as a cartridge texture.
//
// He runs a behavior state machine (idle/wander/chase/flee/hurt/held/
// thrown/dead) and takes damage from high-speed collisions: fast foreign
// bodies smacking into him, being hurled into walls, and libsm64's own
// native fall damage. A SM64-style power meter appears when he's hurt.

export const meta = {
    name: 'Mario',
    author: 'BuddyEngine',
    version: '1',
    description: 'It\'s-a me! Real SM64 physics via libsm64. Walks on your windows, brawls with buddies, takes fall damage. Bring your own ROM (included file must be your legal backup).',
};

const buddy = await Buddy.ready();
buddy.log('mario booting');

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const U = 256;              // SM64 units per meter (Mario = 161u ≈ 0.63m)
const TICK = 1 / 30;        // SM64 runs at 30Hz
const VU = U * TICK;        // m/s -> sm64 units-per-frame
const DEPTH = 100;          // corridor half-depth (units): keeps Mario in the desktop plane
const HOME_X = 1.0;

const CANVAS_PX = 224;      // mario render target
const PLANE_M = 1.7;        // world size of the render quad
const FOOT_M = 0.4;         // feet sit this far above the quad bottom

const CAPSULE = { hx: 0.15, hy: 0.15, hz: 0.31 }; // proxy half-extents (box)
const PROXY_CENTER = 0.31;  // proxy center above Mario's feet (m)

const DMG_BODY_SPEED = 3.5; // m/s: foreign body rel-speed that hurts
const DMG_BODY_DIST = 0.5;  // m: how close a body must be to hit
const DMG_SLAM_SPEED = 38;  // u/f: airborne horizontal speed that hurts when stopped dead
const DMG_COOLDOWN = 0.6;   // s between damage events we inflict

// SM64 action constants (from the decomp)
const ACT_IDLE = 0x0C400201;
const ACT_FREEFALL = 0x0100088C;
const ACT_FLAG_AIR = 0x00000800;
const HEALTH_FULL = 0x880;  // 8 wedges

// ---------------------------------------------------------------------------
// ROM gate — the ROM is not distributed with the pack. Without it, log one
// line and go dormant instead of crashing the cell.
// ---------------------------------------------------------------------------
const ROM_FILE = 'Super Mario 64 (USA).z64';
const romBuf = await buddy.assets.bytes(ROM_FILE).catch(() => null);
if (!romBuf || romBuf.byteLength < 0x100000) {
    buddy.log(`sm64: no ROM — place your legal backup "${ROM_FILE}" in the pack folder. Going dormant.`);
} else {
    await run(romBuf);
}

async function run(romBuf) {
// -------------------------------------------------------------------------
// libsm64 WASM boot
// -------------------------------------------------------------------------
const wasmBytes = await buddy.assets.bytes('sm64.wasm');
const glue = await buddy.assets.module('sm64.js');
const M = await glue.default({
    wasmBinary: new Uint8Array(wasmBytes),
    locateFile: () => 'sm64.wasm',
    print: () => {},
    printErr: (t) => buddy.log('[sm64]', t),
});

const rom = new Uint8Array(romBuf);
const romPtr = M._malloc(rom.length);
M.HEAPU8.set(rom, romPtr);

const TEX_W = 64 * 11, TEX_H = 64;
const texPtr = M._malloc(TEX_W * TEX_H * 4);
const MAXT = 1024; // SM64_GEO_MAX_TRIANGLES
const geoPos = M._malloc(4 * 9 * MAXT);
const geoCol = M._malloc(4 * 9 * MAXT);
const geoNorm = M._malloc(4 * 9 * MAXT);
const geoUv = M._malloc(4 * 6 * MAXT);
M._mb_global_init(romPtr, texPtr, geoPos, geoCol, geoNorm, geoUv);

const statePtr = M._malloc(16 * 4);
// Heap can grow (views go stale) — always deref through fresh views.
const sf = (ptr, n) => new Float32Array(M.HEAPF32.buffer, ptr, n);
const si = (ptr, n) => new Int32Array(M.HEAP32.buffer, ptr, n);
const su = (ptr, n) => new Uint32Array(M.HEAPU32.buffer, ptr, n);
buddy.log('libsm64 up, atlas', M._mb_texture_width() + 'x' + M._mb_texture_height());

// ---------------------------------------------------------------------------
// Static world: a corridor that pins Mario to the desktop plane, plus a
// safety floor far below the screen (kill plane logic respawns him).
// ---------------------------------------------------------------------------
const halfWm = buddy.screen.wPx / 2 / buddy.screen.ppm;
const XR = Math.ceil((halfWm + 8) * U);
const YT = Math.ceil((buddy.screen.hPx / buddy.screen.ppm + 8) * U);
const YB = -1600;

// quad(a,b,c,d) CCW viewed from outside -> two SM64 tris, normal out.
function addQuad(a, b, c, d) {
    M._mb_surface_add(0, 0, 0, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    M._mb_surface_add(0, 0, 0, a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
}
// Axis-aligned box: all six faces, outward normals. cx/cy/cz center, e* half-extents.
function addBox(cx, cy, cz, ex, ey, ez) {
    const x0 = cx - ex, x1 = cx + ex, y0 = cy - ey, y1 = cy + ey, z0 = cz - ez, z1 = cz + ez;
    addQuad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // top    (+y floor)
    addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom (-y ceiling)
    addQuad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +x wall
    addQuad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x wall
    addQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z wall
    addQuad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -z wall
}

M._mb_surfaces_begin();
addQuad([XR, YB, DEPTH], [-XR, YB, DEPTH], [-XR, YT, DEPTH], [XR, YT, DEPTH]);     // front wall (normal -z)
addQuad([-XR, YB, -DEPTH], [XR, YB, -DEPTH], [XR, YT, -DEPTH], [-XR, YT, -DEPTH]); // back wall (normal +z)
addQuad([-XR, YB, DEPTH], [XR, YB, DEPTH], [XR, YB, -DEPTH], [-XR, YB, -DEPTH]);   // safety floor
const ZZ = 2000;
addQuad([XR, YB, -ZZ], [XR, YB, ZZ], [XR, YT, ZZ], [XR, YT, -ZZ]);                 // right end cap (normal -x)
addQuad([-XR, YB, ZZ], [-XR, YB, -ZZ], [-XR, YT, -ZZ], [-XR, YT, ZZ]);             // left end cap (normal +x)
M._mb_static_surfaces_commit();

// Keep any teleport target inside the corridor — outside it SM64 has no
// floor and Mario's tick soft-locks.
const clampX = (x) => Math.max(-XR + 150, Math.min(XR - 150, x));
const clampY = (y) => Math.max(YB + 150, Math.min(YT - 150, y));

// ---------------------------------------------------------------------------
// PhysX colliders -> SM64 surface objects (the desktop, as Mario feels it).
// Windows/icons are kinematic and move; each becomes a movable surface
// object, moved (or rebuilt on resize) as the collider list changes.
// ---------------------------------------------------------------------------
const surfObjs = new Map(); // collider id -> {objId, cx, cz, hx, hz}

function syncColliders(colliders) {
    const seen = new Set();
    for (const c of colliders) {
        if (c.hx <= 0 || c.hz <= 0) continue;
        seen.add(c.id);
        const prev = surfObjs.get(c.id);
        if (prev && prev.hx === c.hx && prev.hz === c.hz) {
            if (prev.cx !== c.cx || prev.cz !== c.cz) {
                M._mb_surface_object_move(prev.objId, c.cx * U, c.cz * U, 0);
                prev.cx = c.cx; prev.cz = c.cz;
            }
            continue;
        }
        if (prev) M._mb_surface_object_delete(prev.objId);
        M._mb_surfaces_begin();
        // Extend depth past the corridor walls so there is no gap behind.
        addBox(0, 0, 0, Math.ceil(c.hx * U), Math.ceil(c.hz * U), DEPTH + 60);
        const objId = M._mb_surface_object_create(c.cx * U, c.cz * U, 0);
        surfObjs.set(c.id, { objId, cx: c.cx, cz: c.cz, hx: c.hx, hz: c.hz });
    }
    for (const [id, o] of surfObjs) {
        if (!seen.has(id)) {
            M._mb_surface_object_delete(o.objId);
            surfObjs.delete(id);
        }
    }
}

function groundTop(colliders) {
    let top = 0;
    for (const c of colliders) {
        if (c.id === 'sys/ground') top = Math.max(top, c.cz + c.hz);
    }
    return top;
}

// ---------------------------------------------------------------------------
// PhysX proxy body + render nodes
// ---------------------------------------------------------------------------
const proxy = buddy.phys.spawn('mario', {
    shape: { type: 'box', ...CAPSULE },
    pos: [HOME_X, 0, 1.2],
    mass: 0.6,
    friction: 0.3,
    restitution: 0.05,
    linearDamping: 0.05,
    planar2D: true,
    lock: { angX: true, angY: true, angZ: true },
});

const FACE_CAM = [0.7071, 0, 0, 0.7071]; // plane +Z -> face the ortho camera

buddy.gfx.geometry('quad', { type: 'plane', params: { w: 1, h: 1 } });
const spriteShader = {
    type: 'shader',
    transparent: true,
    depthWrite: false,
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uTex;
        void main() {
            vec4 c = texture2D(uTex, vec2(vUv.x, 1.0 - vUv.y));
            if (c.a < 0.02) discard;
            gl_FragColor = c;
        }`,
};

// ---------------------------------------------------------------------------
// In-cell WebGL2 renderer for Mario's N64 geometry (cartridge modality).
// Headless-safe: if WebGL2 is unavailable the buddy still simulates.
// ---------------------------------------------------------------------------
const gfx = (() => {
    let canvas, gl;
    try {
        canvas = new OffscreenCanvas(CANVAS_PX, CANVAS_PX);
        gl = canvas.getContext('webgl2', { alpha: true, antialias: true });
    } catch (e) { gl = null; }
    if (!gl) { buddy.log('no webgl2 — rendering disabled'); return null; }

    const compile = (vs, fs) => {
        const mk = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
    };

    const marioProg = compile(`#version 300 es
        layout(location=0) in vec3 aPos;
        layout(location=1) in vec3 aCol;
        layout(location=2) in vec3 aNorm;
        layout(location=3) in vec2 aUv;
        uniform vec3 uCenter; uniform float uHalf;
        out vec3 vCol; out vec3 vNorm; out vec2 vUv;
        void main() {
            vCol = aCol; vNorm = aNorm; vUv = aUv;
            gl_Position = vec4((aPos.xy - uCenter.xy) / uHalf, -aPos.z / 2048.0, 1.0);
        }`, `#version 300 es
        precision mediump float;
        in vec3 vCol; in vec3 vNorm; in vec2 vUv;
        uniform sampler2D uTex;
        out vec4 frag;
        void main() {
            vec4 tc = texture(uTex, vUv);
            vec3 col = mix(vCol, tc.rgb, tc.a);
            float l = 0.72 + 0.28 * max(dot(normalize(vNorm), normalize(vec3(0.25, 0.8, 0.55))), 0.0);
            frag = vec4(col * l, 1.0);
        }`);

    const shadowProg = compile(`#version 300 es
        layout(location=0) in vec2 aUnit;
        uniform vec3 uCenter; uniform float uHalf;
        uniform vec3 uPos; uniform vec2 uR;
        out vec2 vUnit;
        void main() {
            vUnit = aUnit;
            vec2 p = uPos.xy + aUnit * uR - uCenter.xy;
            gl_Position = vec4(p / uHalf, -uPos.z / 2048.0, 1.0);
        }`, `#version 300 es
        precision mediump float;
        in vec2 vUnit;
        out vec4 frag;
        void main() {
            float a = 0.4 * smoothstep(1.0, 0.55, length(vUnit));
            frag = vec4(0.0, 0.0, 0.0, a);
        }`);

    // Mario texture atlas straight out of the wasm heap.
    const atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEX_W, TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(M.HEAPU8.buffer, texPtr, TEX_W * TEX_H * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const vbo = { pos: gl.createBuffer(), col: gl.createBuffer(), norm: gl.createBuffer(), uv: gl.createBuffer() };
    const unitQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);

    const uM = {
        center: gl.getUniformLocation(marioProg, 'uCenter'),
        half: gl.getUniformLocation(marioProg, 'uHalf'),
        tex: gl.getUniformLocation(marioProg, 'uTex'),
    };
    const uS = {
        center: gl.getUniformLocation(shadowProg, 'uCenter'),
        half: gl.getUniformLocation(shadowProg, 'uHalf'),
        pos: gl.getUniformLocation(shadowProg, 'uPos'),
        r: gl.getUniformLocation(shadowProg, 'uR'),
    };

    return {
        render(tris, mPos, floorY) {
            const cx = mPos[0], cy = mPos[1] + (PLANE_M / 2 - FOOT_M) * U;
            const half = PLANE_M / 2 * U;
            gl.viewport(0, 0, CANVAS_PX, CANVAS_PX);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            // soft blob shadow (front view: flat ellipse at the floor line)
            const h = mPos[1] - floorY;
            if (h >= -1 && h < 700) {
                const shrink = Math.max(0.25, 1 - h / 900);
                gl.useProgram(shadowProg);
                gl.uniform3f(uS.center, cx, cy, 0);
                gl.uniform1f(uS.half, half);
                gl.uniform3f(uS.pos, mPos[0], floorY + 4, mPos[2] - 70);
                gl.uniform2f(uS.r, 60 * shrink, 14 * shrink);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
                gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
                for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                gl.depthMask(true);
                gl.disable(gl.BLEND);
            }

            gl.useProgram(marioProg);
            gl.uniform3f(uM.center, cx, cy, 0);
            gl.uniform1f(uM.half, half);
            gl.uniform1i(uM.tex, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, atlas);
            const n = tris * 3;
            const feed = (buf, ptr, comps) => {
                gl.bindBuffer(gl.ARRAY_BUFFER, buf);
                gl.bufferData(gl.ARRAY_BUFFER, sf(ptr, n * comps), gl.DYNAMIC_DRAW);
            };
            feed(vbo.pos, geoPos, 3);
            feed(vbo.col, geoCol, 3);
            feed(vbo.norm, geoNorm, 3);
            feed(vbo.uv, geoUv, 2);
            const attr = (loc, buf, comps) => {
                gl.bindBuffer(gl.ARRAY_BUFFER, buf);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, comps, gl.FLOAT, false, 0, 0);
            };
            attr(0, vbo.pos, 3); attr(1, vbo.col, 3); attr(2, vbo.norm, 3); attr(3, vbo.uv, 2);
            gl.drawArrays(gl.TRIANGLES, 0, n);

            buddy.publishCanvas('texMario', canvas);
        },
    };
})();

// Publish an initial (blank) frame so the texture exists before the
// material references it, then build the nodes.
if (gfx) {
    gfx.render(0, [0, 0, 0], -1e6);
    buddy.gfx.material('matMario', { ...spriteShader, uniforms: { uTex: 'texMario' } });
    const marioNode = buddy.gfx.mesh('view', { geo: 'quad', mat: 'matMario' });
    marioNode.set({ scale: [PLANE_M, PLANE_M, 1] });
    marioNode.attach('mario', [0, 0, PLANE_M / 2 - FOOT_M - PROXY_CENTER], FACE_CAM);
}

// ---------------------------------------------------------------------------
// Power meter (SM64-style pie) on a small quad above Mario's head
// ---------------------------------------------------------------------------
const meter = (() => {
    let canvas, ctx;
    try {
        canvas = new OffscreenCanvas(96, 96);
        ctx = canvas.getContext('2d');
    } catch (e) { return null; }
    if (!ctx) return null;
    return {
        draw(wedges) {
            const c = 48, r = 40;
            ctx.clearRect(0, 0, 96, 96);
            ctx.beginPath(); ctx.arc(c, c, r + 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(20,24,60,0.85)'; ctx.fill();
            const color = wedges >= 6 ? '#3f9dff' : wedges >= 3 ? '#ffd23f' : '#ff4a3f';
            for (let i = 0; i < wedges; i++) {
                const a0 = -Math.PI / 2 + i * Math.PI / 4, a1 = a0 + Math.PI / 4 - 0.06;
                ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, r, a0, a1); ctx.closePath();
                ctx.fillStyle = color; ctx.fill();
            }
            buddy.publishCanvas('texMeter', canvas);
        },
    };
})();
let meterNode = null;
if (meter) {
    meter.draw(8);
    buddy.gfx.material('matMeter', { ...spriteShader, uniforms: { uTex: 'texMeter' } });
    meterNode = buddy.gfx.mesh('meter', { geo: 'quad', mat: 'matMeter' });
    meterNode.set({ scale: [0.42, 0.42, 1], visible: false });
    meterNode.attach('mario', [0, 0, 0.62], FACE_CAM);
}

// ---------------------------------------------------------------------------
// Audio (best effort — SM64's own mixer streamed into WebAudio; sandboxed
// cells may refuse to start an AudioContext, in which case we stay silent)
// ---------------------------------------------------------------------------
const audio = (() => {
    let ctx = null;
    try { ctx = new AudioContext({ sampleRate: 32000 }); } catch (e) { return null; }
    let inited = false, nextT = 0;
    const bufPtr = M._malloc(4096 * 4);
    return {
        poke() { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); },
        tick() {
            if (ctx.state !== 'running') return;
            if (!inited) {
                try { M._mb_audio_init(romPtr); M._mb_set_sound_volume(0.5); inited = true; }
                catch (e) { ctx = { state: 'dead' }; return; }
            }
            const queued = Math.max(0, Math.floor((nextT - ctx.currentTime) * 32000));
            if (queued > 6000) return;
            const n = M._mb_audio_tick(queued, 1100, bufPtr);
            if (n <= 0) return;
            const pcm = new Int16Array(M.HEAP16.buffer, bufPtr, n * 2);
            const ab = ctx.createBuffer(2, n, 32000);
            const L = ab.getChannelData(0), R = ab.getChannelData(1);
            for (let i = 0; i < n; i++) { L[i] = pcm[2 * i] / 32768; R[i] = pcm[2 * i + 1] / 32768; }
            const src = ctx.createBufferSource();
            src.buffer = ab;
            src.connect(ctx.destination);
            nextT = Math.max(nextT, ctx.currentTime + 0.06);
            src.start(nextT);
            nextT += n / 32000;
        },
    };
})();

// ---------------------------------------------------------------------------
// Behavior state machine
// ---------------------------------------------------------------------------
const mario = {
    id: -1,
    state: 'boot',      // boot|idle|wander|chase|flee|hurt|held|thrown|dead
    stateT: 0,
    pos: [HOME_X * U, 200, 0], vel: [0, 0, 0],
    faceAngle: 0, fwdVel: 0,
    health: HEALTH_FULL, action: ACT_IDLE, invinc: 0,
    grounded: true,
    target: HOME_X,      // wander/chase target x (m)
    fleeFrom: 0,
    stuckT: 0,
    lastDmgT: -10,
    deadT: 0,
    holdStart: -1, held: false, holding: false, thrownT: 0,
    idleDur: 3,
    meterShownAt: -10,
    lastWedges: 8,
    regenT: 0,
    prevHVel: 0, prevVel: [0, 0, 0],
    prevPos: [0, 0, 0], stallT: 0,
};

function setState(s) {
    if (mario.state === s) return;
    mario.state = s;
    mario.stateT = 0;
}

function takeDamage(now, wedges, srcSm64) {
    if (now - mario.lastDmgT < DMG_COOLDOWN || mario.invinc > 0 || mario.state === 'dead') return;
    mario.lastDmgT = now;
    M._mb_take_damage(mario.id, wedges, 0, srcSm64[0], srcSm64[1], srcSm64[2]);
    buddy.bus.broadcast('mario.ouch', { at: [mario.pos[0] / U, mario.pos[1] / U], oomph: wedges });
    mario.meterShownAt = now;
}

// Behavior tick — decides SM64 inputs from perception. Runs at 30Hz.
function behave(world, now) {
    const mxm = mario.pos[0] / U;          // meters
    const mzm = mario.pos[1] / U;          // meters, world up
    const cur = world.cursor;
    const inputs = { sx: 0, sy: 0, a: 0, b: 0, z: 0 };

    // -- perception ---------------------------------------------------------
    let threat = null;
    for (const [id, b] of world.bodies) {
        if (id.startsWith(buddy.id + '/') || id === 'sys/target') continue;
        const dx = b.pos[0] - mxm, dz = b.pos[2] - (mzm + PROXY_CENTER);
        const d = Math.hypot(dx, dz);
        if (d > 2.2) continue;
        const closing = -(b.vel[0] * dx + b.vel[2] * dz) / Math.max(d, 0.05);
        const speed = Math.hypot(b.vel[0], b.vel[2]);
        // high-speed collision -> damage (knockback comes from SM64 itself)
        if (d < DMG_BODY_DIST + 0.1 && closing > DMG_BODY_SPEED) {
            const wedges = 1 + (closing > 7 ? 1 : 0) + (closing > 11 ? 1 : 0);
            takeDamage(now, wedges, [b.pos[0] * U, b.pos[2] * U, 0]);
        }
        if (speed > 2.5 && d < 1.6 && closing > 0.5) threat = { x: b.pos[0], d };
    }

    // wall-slam damage: airborne + fast, then stopped dead by something
    const hVel = Math.hypot(mario.vel[0], mario.vel[2]);
    if (!mario.grounded && mario.prevHVel > DMG_SLAM_SPEED && hVel < 8 &&
        mario.state !== 'held') {
        const dir = Math.hypot(mario.prevVel[0], mario.prevVel[2]) || 1;
        takeDamage(now, 1 + (mario.prevHVel > 65 ? 1 : 0) + (mario.prevHVel > 95 ? 1 : 0), [
            mario.pos[0] + mario.prevVel[0] / dir * 60,
            mario.pos[1] + 40,
            mario.pos[2] + mario.prevVel[2] / dir * 60,
        ]);
    }
    mario.prevHVel = hVel;
    mario.prevVel = mario.vel.slice();

    // -- transitions ----------------------------------------------------------
    const hurtRecently = now - mario.lastDmgT < 0.9;
    if (mario.state !== 'dead' && mario.health < 0x100) {
        setState('dead');
        mario.deadT = now;
        buddy.bus.broadcast('mario.dead', { at: [mxm, mzm] });
    }
    switch (mario.state) {
        case 'dead':
            if (now - mario.deadT > 3.5) {
                M._mb_set_health(mario.id, HEALTH_FULL);
                M._mb_set_position(mario.id, HOME_X * U, (groundTop(world.colliders) + 0.4) * U, 0);
                M._mb_set_velocity(mario.id, 0, 0, 0);
                M._mb_set_action(mario.id, ACT_FREEFALL);
                M._mb_set_invincibility(mario.id, 90);
                mario.lastWedges = -1; // force meter redraw
                setState('idle');
            }
            return inputs;
        case 'held':
            if (!mario.held) { setState('thrown'); mario.thrownT = now; }
            return inputs;
        case 'thrown':
            if (mario.holding) setState('held');
            else if (mario.grounded && now - mario.thrownT > 0.25) setState('idle');
            return inputs;
        case 'hurt':
            if (!hurtRecently && mario.grounded) setState(threat ? 'flee' : 'idle');
            break;
        default:
            if (mario.holding) setState('held');
            else if (hurtRecently) { setState('hurt'); mario.fleeFrom = threat ? threat.x : mxm + 1; }
            else if (threat) { setState('flee'); mario.fleeFrom = threat.x; }
            break;
    }

    // -- state behaviors ------------------------------------------------------
    const walkToward = (tx, mag) => {
        const dx = tx - mxm;
        if (Math.abs(dx) < 0.12) return true;
        inputs.sx = -Math.sign(dx) * mag; // stick(-1,0) -> +x with camLook(0,1)
        // knockbacks drift Mario off the desktop plane; steer back to z=0
        inputs.sy = Math.max(-0.3, Math.min(0.3, mario.pos[2] / 150));
        // stuck against a wall? hop.
        if (mario.grounded && Math.abs(mario.fwdVel) < 2.5) {
            mario.stuckT += TICK;
            if (mario.stuckT > 0.45) { inputs.a = 1; mario.stuckT = -0.6; }
        } else if (mario.grounded) mario.stuckT = Math.max(0, mario.stuckT - TICK);
        return false;
    };

    switch (mario.state) {
        case 'idle': {
            // look at the cursor when it hangs around
            const dc = Math.abs(cur.wx - mxm);
            if (dc < 1.8 && Math.abs(cur.wz - mzm) < 1.5) {
                M._mb_set_faceangle(mario.id, dc < 0.35 ? 0 : (cur.wx > mxm ? Math.PI / 2 : -Math.PI / 2));
            }
            if (mario.stateT > mario.idleDur) {
                mario.idleDur = 2 + Math.random() * 6;
                // pick a stroll target: nearby ground spot, or a low window top
                const tops = world.colliders.filter(c =>
                    c.kinematic && c.hx > 0.3 &&
                    c.cz + c.hz > mzm + 0.2 && c.cz + c.hz < mzm + 1.05 &&
                    Math.abs(c.cx - mxm) < 3.5);
                if (tops.length && Math.random() < 0.5) {
                    const t = tops[Math.floor(Math.random() * tops.length)];
                    mario.target = t.cx + (Math.random() - 0.5) * t.hx;
                } else {
                    mario.target = Math.max(-halfWm + 0.6, Math.min(halfWm - 0.6,
                        mxm + (Math.random() * 6 - 3)));
                }
                setState('wander');
            }
            break;
        }
        case 'wander': {
            const arrived = walkToward(mario.target, 0.45);
            // climb: target above us and we're under its ledge -> jump
            if (!arrived && mario.grounded) {
                const support = supportTopAt(world.colliders, mario.target, mzm);
                if (support > mzm + 0.25 && Math.abs(mario.target - mxm) < 0.9) inputs.a = 1;
            }
            if (arrived || mario.stateT > 9) setState('idle');
            break;
        }
        case 'chase': {
            walkToward(cur.wx, 0.95);
            if (mario.grounded && cur.wz > mzm + 0.5 && Math.abs(cur.wx - mxm) < 0.7) inputs.a = 1;
            if (mario.stateT > 8) setState('idle');
            break;
        }
        case 'flee': {
            walkToward(mxm + Math.sign(mxm - mario.fleeFrom || 1) * 3, 1.0);
            if (mario.stateT > 1.6 && !threat) setState('idle');
            else if (threat) { mario.fleeFrom = threat.x; mario.stateT = Math.min(mario.stateT, 1.0); }
            break;
        }
        case 'hurt': break; // ragdoll through the knockback, no inputs
    }

    // slow regen while healthy-ish and calm
    if (mario.health < HEALTH_FULL && now - mario.lastDmgT > 12) {
        mario.regenT += TICK;
        if (mario.regenT > 8) { mario.regenT = 0; M._mb_heal(mario.id, 4); }
    }

    return inputs;
}

function supportTopAt(colliders, x, aboveZ) {
    let best = 0;
    for (const c of colliders) {
        if (c.id.startsWith('sys/wall')) continue;
        const top = c.cz + c.hz;
        if (x >= c.cx - c.hx && x <= c.cx + c.hx && top > best && top < aboveZ + 1.4) best = top;
    }
    return best;
}

// ---------------------------------------------------------------------------
// Frame loop: 30Hz SM64 ticks driven by the host frame stream
// ---------------------------------------------------------------------------
let accum = 0;
let booted = false;
let pokeCount = 0, lastPokeT = -10;
let separatedT = 0;

buddy.bus.on('sys.reset', () => {
    if (mario.id >= 0) {
        M._mb_set_position(mario.id, HOME_X * U, 300, 0);
        M._mb_set_velocity(mario.id, 0, 0, 0);
    }
});

buddy.onFrame((world) => {
    const now = world.time;

    // -- pointer events ------------------------------------------------------
    for (const ev of world.events) {
        if (!ev.id.endsWith('/mario')) continue;
        if (ev.type === 'pointerdown') {
            mario.holdStart = now;
            mario.held = true;
            if (audio) audio.poke();
        } else if (ev.type === 'pointerup') {
            const wasQuick = now - mario.holdStart < 0.3;
            releaseHold(world);
            if (wasQuick) {
                pokeCount = now - lastPokeT < 1.2 ? pokeCount + 1 : 1;
                lastPokeT = now;
                if (mario.id >= 0 && mario.state !== 'dead') {
                    if (pokeCount >= 2) { setState('chase'); pokeCount = 0; }
                    else if (mario.grounded) M._mb_set_action(mario.id, 0x03000880); // ACT_JUMP
                }
            }
        }
    }
    if (mario.held && !world.cursor.l && now - mario.holdStart > 0.2) releaseHold(world);

    // -- lazy world boot (needs the first collider list) ----------------------
    if (!booted) {
        if (!world.colliders.length) return;
        syncColliders(world.colliders);
        const gz = groundTop(world.colliders);
        mario.id = M._mb_mario_create(HOME_X * U, (gz + 0.3) * U, 0);
        if (mario.id < 0) { buddy.log('mario_create failed, retrying'); return; }
        M._mb_set_water_level(mario.id, -30000);
        booted = true;
        setState('idle');
        buddy.log('mario spawned at ground', gz.toFixed(2));
    } else {
        syncColliders(world.colliders);
    }

    // -- fixed-rate SM64 ticks -------------------------------------------------
    accum = Math.min(accum + world.dt, 3 * TICK);
    let ticked = false;
    while (accum >= TICK) {
        accum -= TICK;
        ticked = true;

        mario.holding = mario.held && (now - mario.holdStart > 0.25);
        if (mario.holding && mario.state !== 'dead') {
            setState('held');
            // sm64 follows the grabbed proxy
            const p = proxy.state;
            if (p) {
                M._mb_set_position(mario.id,
                    clampX(p.pos[0] * U), clampY((p.pos[2] - PROXY_CENTER) * U), 0);
                M._mb_set_velocity(mario.id, 0, 0, 0);
                if (mario.action !== ACT_FREEFALL) M._mb_set_action(mario.id, ACT_FREEFALL);
            }
        }

        const inputs = behave(world, now);
        const tris = M._mb_mario_tick(mario.id, 0, 1,
            inputs.sx, inputs.sy, inputs.a, inputs.b, inputs.z, statePtr);

        const f = sf(statePtr, 16), i = si(statePtr, 16), u = su(statePtr, 16);
        mario.pos = [f[0], f[1], f[2]];
        mario.vel = [f[3], f[4], f[5]];
        mario.faceAngle = f[6];
        mario.fwdVel = f[7];
        mario.health = i[8];
        mario.action = u[9];
        mario.invinc = i[14];
        mario.grounded = !(mario.action & ACT_FLAG_AIR);
        mario.stateT += TICK;

        // fell off the world -> hurt + respawn at home
        if (mario.pos[1] < YB + 100) {
            M._mb_set_position(mario.id, HOME_X * U, (groundTop(world.colliders) + 0.5) * U, 0);
            M._mb_set_velocity(mario.id, 0, 0, 0);
            takeDamage(now, 1, [mario.pos[0] + 50, mario.pos[1], 0]);
        }
        // embedded inside a collider (window dragged onto him / floor
        // teleported up through him): pop out — top if close, else nearest
        // side (skip while held: the grab teleport would fight it)
        for (const c of mario.holding ? [] : world.colliders) {
            const fx = mario.pos[0] / U, fz = mario.pos[1] / U;
            const mid = fz + 0.3; // mid-body: feet can rest exactly on a box boundary
            const inX = fx > c.cx - c.hx + 0.02 && fx < c.cx + c.hx - 0.02;
            const inZ = mid > c.cz - c.hz + 0.05 && mid < c.cz + c.hz - 0.05;
            if (!inX || !inZ) continue;
            const top = c.cz + c.hz;
            const dTop = top - fz;
            const dSide = c.hx - Math.abs(fx - c.cx) + 0.22;
            if (dTop <= dSide) {
                M._mb_set_position(mario.id, mario.pos[0], top * U + 2, 0);
            } else {
                const side = fx > c.cx ? c.cx + c.hx + 0.22 : c.cx - c.hx - 0.22;
                M._mb_set_position(mario.id, clampX(side * U), mario.pos[1], 0);
            }
            M._mb_set_velocity(mario.id, 0, 0, 0);
            break;
        }
        // escaped or soft-locked (e.g. teleported out of bounds): recover
        const stalled = !mario.grounded && mario.state !== 'held' &&
            Math.hypot(mario.vel[0], mario.vel[1], mario.vel[2]) > 1 &&
            mario.pos[0] === mario.prevPos[0] && mario.pos[1] === mario.prevPos[1];
        mario.stallT = stalled ? mario.stallT + TICK : 0;
        if (Math.abs(mario.pos[0]) > XR - 120 || mario.stallT > 0.7) {
            mario.stallT = 0;
            M._mb_set_position(mario.id, clampX(mario.pos[0]), clampY(mario.pos[1]) + 50, 0);
            M._mb_set_velocity(mario.id, 0, 0, 0);
            M._mb_set_forward_velocity(mario.id, 0);
            M._mb_set_action(mario.id, ACT_FREEFALL);
        }
        mario.prevPos = mario.pos.slice();

        if (gfx && tris > 0) {
            const floorY = M._mb_find_floor_height(mario.pos[0], mario.pos[1] + 30, mario.pos[2]);
            gfx.render(tris, mario.pos, floorY);
        }
        if (audio) audio.tick();
    }

    // -- proxy tracking ---------------------------------------------------------
    const p = proxy.state;
    if (p && booted) {
        const tx = mario.pos[0] / U, tz = mario.pos[1] / U + PROXY_CENTER;
        const dx = tx - p.pos[0], dz = tz - p.pos[2];
        const dist = Math.hypot(dx, dz);
        if (!mario.held) {
            const k = Math.min(1 / Math.max(world.dt, 1e-3), 30);
            const cap = 25;
            let vx = dx * k, vz = dz * k;
            const s = Math.hypot(vx, vz);
            if (s > cap) { vx *= cap / s; vz *= cap / s; }
            proxy.velocity([vx, 0, vz], [0, 0, 0]);
            // proxy pinned away from the sim (wedged under something):
            // rebuild it at Mario's position
            separatedT = dist > 0.9 ? separatedT + world.dt : 0;
            if (separatedT > 1.5) {
                separatedT = 0;
                proxy.remove();
                buddy.phys.spawn('mario', {
                    shape: { type: 'box', ...CAPSULE },
                    pos: [tx, 0, tz],
                    mass: 0.6, friction: 0.3, restitution: 0.05,
                    linearDamping: 0.05, planar2D: true,
                    lock: { angX: true, angY: true, angZ: true },
                });
            }
        }
    }

    // -- power meter -----------------------------------------------------------
    if (ticked && meter) {
        const wedges = Math.max(0, Math.min(8, mario.health >> 8));
        if (wedges !== mario.lastWedges) {
            mario.lastWedges = wedges;
            mario.meterShownAt = now;
            meter.draw(wedges);
        }
        const show = (now - mario.meterShownAt < 4) || (wedges <= 2 && wedges > 0);
        meterNode.set({ visible: show });
    }
});

function releaseHold(world) {
    if (!mario.held) return;
    mario.held = false;
    if (mario.id < 0 || mario.state !== 'held') return;
    // hand the throw velocity to SM64 and let its air physics take over
    const p = proxy.state;
    if (p) {
        const vx = p.vel[0], vz = p.vel[2];
        const h = Math.hypot(vx, vz);
        if (h > 0.3) M._mb_set_faceangle(mario.id, Math.atan2(vx, 0.001));
        M._mb_set_forward_velocity(mario.id, Math.min(h * VU, 150));
        M._mb_set_velocity(mario.id, vx * VU, Math.min(vz * VU, 120), 0);
        M._mb_set_action(mario.id, ACT_FREEFALL);
    }
}

globalThis.__mario = mario; // cell-local debug handle (harness introspection)
buddy.log('mario online — wahoo!');
} // run()
