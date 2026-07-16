#!/usr/bin/env bash
# Build sm64.js / sm64.wasm for the sm64 buddy pack.
#
# Requires: an emsdk install (EMSDK env var or /tmp/emsdk) and a libsm64
# checkout with Mario geometry already imported (./import-mario-geo.py
# needs network).
#
#   LIBSM64=/tmp/libsm64 EMSDK=/tmp/emsdk ./build.sh
set -euo pipefail

LIBSM64="${LIBSM64:-/tmp/libsm64}"
EMSDK="${EMSDK:-/tmp/emsdk}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACK="$(dirname "$HERE")"

if [ ! -f "$LIBSM64/src/decomp/mario/geo.inc.c" ]; then
    echo "run $LIBSM64/import-mario-geo.py first (downloads Mario model)" >&2
    exit 1
fi

EXPORTS=_malloc,_free,_mb_global_init,_mb_texture_width,_mb_texture_height
EXPORTS+=,_mb_surfaces_begin,_mb_surface_add,_mb_static_surfaces_commit
EXPORTS+=,_mb_surface_object_create,_mb_surface_object_move,_mb_surface_object_delete
EXPORTS+=,_mb_mario_create,_mb_mario_delete,_mb_mario_tick
EXPORTS+=,_mb_take_damage,_mb_heal,_mb_set_health,_mb_kill
EXPORTS+=,_mb_set_position,_mb_set_velocity,_mb_set_forward_velocity,_mb_set_faceangle
EXPORTS+=,_mb_set_action,_mb_set_invincibility,_mb_set_water_level,_mb_attack
EXPORTS+=,_mb_find_floor_height
EXPORTS+=,_mb_audio_init,_mb_audio_tick,_mb_play_sound_global,_mb_set_sound_volume

source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

cd "$LIBSM64"
SRCS=$(find src -name '*.c' -not -path '*/copt/*')
emcc -O2 -fno-strict-aliasing -Wno-unused-function \
    -DSM64_LIB_EXPORT -DGBI_FLOATS -DVERSION_US -DNO_SEGMENTED_MEMORY \
    -I src -I src/decomp/include \
    $SRCS "$HERE/mario_buddy.c" \
    -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=SM64Module \
    -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=1048576 \
    -sEXPORTED_FUNCTIONS=$EXPORTS \
    -o "$PACK/sm64.js"
echo "built: $PACK/sm64.js $PACK/sm64.wasm"
