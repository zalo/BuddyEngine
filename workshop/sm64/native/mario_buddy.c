// mario_buddy.c — flat WASM ABI over libsm64 for the BuddyEngine sm64 pack.
//
// Exposes everything the cell needs to run Mario against desktop geometry:
//   - global init (ROM in, texture atlas out)
//   - static surfaces + movable surface objects (PhysX colliders lower to
//     SM64 surfaces through a small builder to avoid struct packing in JS)
//   - mario create/tick/delete with a mixed f32/i32 state out-buffer
//   - damage / heal / position / velocity / action passthroughs
//   - audio init + tick for WebAudio streaming
//
// All functions take/return scalars or heap pointers; no structs cross the
// JS boundary except via the builder below.

#include <libsm64.h>
#include <string.h>
#include <stdlib.h>

#define EXPORT __attribute__((used, visibility("default")))

// ---------------------------------------------------------------------------
// Global init
// ---------------------------------------------------------------------------

static struct SM64MarioGeometryBuffers s_geom;

EXPORT void mb_global_init(uint8_t *rom, uint8_t *outTexture,
                           float *positionBuf, float *colorBuf,
                           float *normalBuf, float *uvBuf) {
    sm64_global_init(rom, outTexture);
    s_geom.position = positionBuf;
    s_geom.color    = colorBuf;
    s_geom.normal   = normalBuf;
    s_geom.uv       = uvBuf;
    s_geom.numTrianglesUsed = 0;
}

EXPORT int mb_texture_width(void)  { return SM64_TEXTURE_WIDTH; }
EXPORT int mb_texture_height(void) { return SM64_TEXTURE_HEIGHT; }

// ---------------------------------------------------------------------------
// Surface builder — JS fills a staging array one triangle at a time, then
// commits it either as the static surface set or as a movable object.
// ---------------------------------------------------------------------------

static struct SM64Surface *s_staged = NULL;
static uint32_t s_stagedCount = 0;
static uint32_t s_stagedCap = 0;

EXPORT void mb_surfaces_begin(void) { s_stagedCount = 0; }

EXPORT void mb_surface_add(int16_t type, int16_t force, uint16_t terrain,
                           int32_t x0, int32_t y0, int32_t z0,
                           int32_t x1, int32_t y1, int32_t z1,
                           int32_t x2, int32_t y2, int32_t z2) {
    if (s_stagedCount >= s_stagedCap) {
        s_stagedCap = s_stagedCap ? s_stagedCap * 2 : 64;
        s_staged = realloc(s_staged, s_stagedCap * sizeof(struct SM64Surface));
    }
    struct SM64Surface *s = &s_staged[s_stagedCount++];
    s->type = type; s->force = force; s->terrain = terrain;
    s->vertices[0][0] = x0; s->vertices[0][1] = y0; s->vertices[0][2] = z0;
    s->vertices[1][0] = x1; s->vertices[1][1] = y1; s->vertices[1][2] = z1;
    s->vertices[2][0] = x2; s->vertices[2][1] = y2; s->vertices[2][2] = z2;
}

EXPORT void mb_static_surfaces_commit(void) {
    sm64_static_surfaces_load(s_staged, s_stagedCount);
}

// Commit staged surfaces as a movable surface object. Vertices are in the
// object's local frame; the object is placed at (px,py,pz).
EXPORT uint32_t mb_surface_object_create(float px, float py, float pz) {
    struct SM64SurfaceObject obj;
    memset(&obj, 0, sizeof(obj));
    obj.transform.position[0] = px;
    obj.transform.position[1] = py;
    obj.transform.position[2] = pz;
    obj.surfaceCount = s_stagedCount;
    obj.surfaces = s_staged;   // libsm64 copies these internally
    return sm64_surface_object_create(&obj);
}

EXPORT void mb_surface_object_move(uint32_t id, float px, float py, float pz) {
    struct SM64ObjectTransform t;
    memset(&t, 0, sizeof(t));
    t.position[0] = px; t.position[1] = py; t.position[2] = pz;
    sm64_surface_object_move(id, &t);
}

EXPORT void mb_surface_object_delete(uint32_t id) {
    sm64_surface_object_delete(id);
}

// ---------------------------------------------------------------------------
// Mario
// ---------------------------------------------------------------------------

EXPORT int32_t mb_mario_create(float x, float y, float z) {
    return sm64_mario_create(x, y, z);
}

EXPORT void mb_mario_delete(int32_t id) { sm64_mario_delete(id); }

// outState: 16 x 4-byte slots, mixed f32/i32 (JS overlays two typed arrays):
//   f[0..2] pos   f[3..5] vel   f[6] faceAngle   f[7] forwardVel
//   i[8] health   u[9] action   i[10] animID     i[11] animFrame
//   u[12] flags   u[13] particleFlags            i[14] invincTimer
// Returns numTrianglesUsed for the geometry buffers passed at init.
EXPORT int mb_mario_tick(int32_t id,
                         float camLookX, float camLookZ,
                         float stickX, float stickY,
                         int buttonA, int buttonB, int buttonZ,
                         uint32_t *outState) {
    struct SM64MarioInputs inputs = {
        .camLookX = camLookX, .camLookZ = camLookZ,
        .stickX = stickX, .stickY = stickY,
        .buttonA = (uint8_t)buttonA, .buttonB = (uint8_t)buttonB,
        .buttonZ = (uint8_t)buttonZ,
    };
    struct SM64MarioState st;
    memset(&st, 0, sizeof(st));
    sm64_mario_tick(id, &inputs, &st, &s_geom);

    float *f = (float *)outState;
    int32_t *i = (int32_t *)outState;
    f[0] = st.position[0]; f[1] = st.position[1]; f[2] = st.position[2];
    f[3] = st.velocity[0]; f[4] = st.velocity[1]; f[5] = st.velocity[2];
    f[6] = st.faceAngle;   f[7] = st.forwardVelocity;
    i[8] = st.health;      outState[9] = st.action;
    i[10] = st.animID;     i[11] = st.animFrame;
    outState[12] = st.flags; outState[13] = st.particleFlags;
    i[14] = st.invincTimer;
    return s_geom.numTrianglesUsed;
}

EXPORT void mb_take_damage(int32_t id, uint32_t damage, uint32_t subtype,
                           float x, float y, float z) {
    sm64_mario_take_damage(id, damage, subtype, x, y, z);
}

EXPORT void mb_heal(int32_t id, uint8_t healCounter) { sm64_mario_heal(id, healCounter); }
EXPORT void mb_set_health(int32_t id, uint16_t health) { sm64_set_mario_health(id, health); }
EXPORT void mb_kill(int32_t id) { sm64_mario_kill(id); }
EXPORT void mb_set_position(int32_t id, float x, float y, float z) { sm64_set_mario_position(id, x, y, z); }
EXPORT void mb_set_velocity(int32_t id, float x, float y, float z) { sm64_set_mario_velocity(id, x, y, z); }
EXPORT void mb_set_forward_velocity(int32_t id, float v) { sm64_set_mario_forward_velocity(id, v); }
EXPORT void mb_set_faceangle(int32_t id, float y) { sm64_set_mario_faceangle(id, y); }
EXPORT void mb_set_action(int32_t id, uint32_t action) { sm64_set_mario_action(id, action); }
EXPORT void mb_set_invincibility(int32_t id, int16_t timer) { sm64_set_mario_invincibility(id, timer); }
EXPORT void mb_set_water_level(int32_t id, int level) { sm64_set_mario_water_level(id, level); }
EXPORT int mb_attack(int32_t id, float x, float y, float z, float hitboxHeight) {
    return sm64_mario_attack(id, x, y, z, hitboxHeight) ? 1 : 0;
}
EXPORT float mb_find_floor_height(float x, float y, float z) {
    return sm64_surface_find_floor_height(x, y, z);
}

// ---------------------------------------------------------------------------
// Audio (optional at runtime — cell streams into WebAudio if allowed)
// ---------------------------------------------------------------------------

EXPORT void mb_audio_init(uint8_t *rom) { sm64_audio_init(rom); }

EXPORT uint32_t mb_audio_tick(uint32_t numQueuedSamples, uint32_t numDesiredSamples,
                              int16_t *audioBuffer) {
    return sm64_audio_tick(numQueuedSamples, numDesiredSamples, audioBuffer);
}

EXPORT void mb_play_sound_global(int32_t soundBits) { sm64_play_sound_global(soundBits); }
EXPORT void mb_set_sound_volume(float vol) { sm64_set_sound_volume(vol); }
