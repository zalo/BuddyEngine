// Host-side retained-mode scene graph for buddy cells. Cells describe
// three.js objects over the wire (geometries, materials incl. custom
// shaders, textures incl. transferred OffscreenCanvas bitmaps, GLTF scenes
// with skinned meshes + animation clips); this module owns the real THREE
// objects. One SceneMirror per cell — disposing it wipes everything that
// buddy created.

import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';

const MAX_NODES = 512;
const MAX_TEX_DIM = 2048;

export class SceneMirror {
    constructor(scene, readAsset /* async (path) => ArrayBuffer */) {
        this.scene = scene;
        this.readAsset = readAsset;
        this.root = new THREE.Group();
        scene.add(this.root);

        this.geos = new Map();
        this.mats = new Map();
        this.texs = new Map();
        this.nodes = new Map();   // id -> {obj, attach?: {body, offsetPos, offsetQuat}, mixer?, clips?}
        this.gltfLoader = new GLTFLoader();
        this.clock = new THREE.Clock();
    }

    // ------------------------------------------------------------------ defs

    defineGeometry(c) {
        this.disposeGeo(c.id);
        const p = c.params || {};
        let geo;
        switch (c.type) {
            case 'box': geo = new THREE.BoxGeometry(p.w || 0.2, p.h || 0.2, p.d || 0.2); break;
            case 'sphere': geo = new THREE.SphereGeometry(p.r || 0.1, p.ws || 24, p.hs || 16); break;
            case 'capsule': geo = new THREE.CapsuleGeometry(p.r || 0.1, p.l || 0.2, 8, 16); break;
            case 'plane': geo = new THREE.PlaneGeometry(p.w || 0.3, p.h || 0.3); break;
            case 'cylinder': geo = new THREE.CylinderGeometry(p.rt || 0.1, p.rb || 0.1, p.h || 0.2, 20); break;
            case 'buffer': {
                geo = new THREE.BufferGeometry();
                if (c.position) geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c.position), 3));
                if (c.normal) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(c.normal), 3));
                if (c.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(c.uv), 2));
                if (c.index) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(c.index), 1));
                if (!c.normal) geo.computeVertexNormals();
                break;
            }
            default: throw new Error('geo type: ' + c.type);
        }
        this.geos.set(c.id, geo);
    }

    async defineTexture(c) {
        let tex;
        if (c.bitmap) {
            // Cartridge modality: an OffscreenCanvas frame published as a
            // texture — pixels in, no code in.
            if (c.bitmap.width > MAX_TEX_DIM || c.bitmap.height > MAX_TEX_DIM) {
                c.bitmap.close();
                throw new Error('bitmap too large');
            }
            const existing = this.texs.get(c.id);
            if (existing && existing.isCanvasStream) {
                existing.image.close && existing.image.close();
                existing.image = c.bitmap;
                existing.needsUpdate = true;
                return;
            }
            tex = new THREE.Texture(c.bitmap);
            tex.isCanvasStream = true;
            tex.needsUpdate = true;
        } else if (c.asset) {
            const bytes = await this.readAsset(c.asset);
            const blob = new Blob([bytes]);
            const bitmap = await createImageBitmap(blob);
            tex = new THREE.Texture(bitmap);
            tex.needsUpdate = true;
        } else {
            throw new Error('texture needs asset or bitmap');
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        if (c.nearest) { // pixel art
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
        }
        this.disposeTex(c.id);
        this.texs.set(c.id, tex);
    }

    defineMaterial(c) {
        this.disposeMat(c.id);
        const p = c.params || {};
        if (p.map || c.map) p.map = this.texs.get(p.map || c.map) || null;
        let mat;
        switch (c.type) {
            case 'basic': mat = new THREE.MeshBasicMaterial(p); break;
            case 'sprite': mat = new THREE.SpriteMaterial(p); break;
            case 'shader': {
                const uniforms = {};
                for (const [k, v] of Object.entries(c.uniforms || {})) {
                    uniforms[k] = { value: this.coerceUniform(v) };
                }
                mat = new THREE.ShaderMaterial({
                    vertexShader: c.vertexShader || THREE.ShaderLib.basic.vertexShader,
                    fragmentShader: c.fragmentShader ||
                        'void main(){ gl_FragColor = vec4(1.0,0.0,1.0,1.0); }',
                    uniforms,
                    transparent: !!c.transparent,
                    depthWrite: c.depthWrite !== false,
                    side: THREE.DoubleSide,
                    blending: c.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
                });
                break;
            }
            default: mat = new THREE.MeshStandardMaterial(p); break;
        }
        if (c.transparent) mat.transparent = true;
        this.mats.set(c.id, mat);
    }

    coerceUniform(v) {
        if (Array.isArray(v)) {
            if (v.length === 2) return new THREE.Vector2(...v);
            if (v.length === 3) return new THREE.Vector3(...v);
            if (v.length === 4) return new THREE.Vector4(...v);
        }
        if (typeof v === 'string' && this.texs.has(v)) return this.texs.get(v);
        return v;
    }

    // ----------------------------------------------------------------- nodes

    async addNode(c) {
        if (this.nodes.size >= MAX_NODES) throw new Error('node budget exceeded');
        this.removeNode({ id: c.id });
        let obj;
        let extra = {};
        if (c.kind === 'group') {
            obj = new THREE.Group();
        } else if (c.kind === 'sprite') {
            obj = new THREE.Sprite(this.mats.get(c.mat) || new THREE.SpriteMaterial());
        } else if (c.kind === 'gltf') {
            const bytes = await this.readAsset(c.asset);
            const gltf = await this.gltfLoader.parseAsync(bytes, '');
            obj = gltf.scene; // includes skinned meshes, bones, morph targets
            if (gltf.animations && gltf.animations.length) {
                extra.mixer = new THREE.AnimationMixer(obj);
                extra.clips = gltf.animations;
            }
        } else { // mesh
            obj = new THREE.Mesh(
                this.geos.get(c.geo) || new THREE.BoxGeometry(0.1, 0.1, 0.1),
                this.mats.get(c.mat) || new THREE.MeshStandardMaterial({ color: 0xff00ff }));
        }
        if (c.pos) obj.position.set(...c.pos);
        if (c.quat) obj.quaternion.set(...c.quat);
        if (c.scale) obj.scale.set(...(typeof c.scale === 'number' ? [c.scale, c.scale, c.scale] : c.scale));

        const parent = c.parent ? this.nodes.get(c.parent) : null;
        (parent ? parent.obj : this.root).add(obj);
        this.nodes.set(c.id, { obj, ...extra });
    }

    setNode(c) {
        const n = this.nodes.get(c.id);
        if (!n) return;
        if (c.pos) n.obj.position.set(...c.pos);
        if (c.quat) n.obj.quaternion.set(...c.quat);
        if (c.scale) n.obj.scale.set(...(typeof c.scale === 'number' ? [c.scale, c.scale, c.scale] : c.scale));
        if (c.visible !== undefined) n.obj.visible = c.visible;
        if (c.matParams) {
            const mat = n.obj.material;
            if (mat && mat.isShaderMaterial) {
                for (const [k, v] of Object.entries(c.matParams)) {
                    if (mat.uniforms[k]) mat.uniforms[k].value = this.coerceUniform(v);
                }
            } else if (mat) {
                for (const [k, v] of Object.entries(c.matParams)) {
                    if (k === 'color' || k === 'emissive') mat[k] = new THREE.Color(v);
                    else if (k in mat) mat[k] = v;
                }
            }
        }
    }

    attachNode(c, bodyPoseFn) {
        const n = this.nodes.get(c.id);
        if (!n) return;
        n.attach = {
            body: c.body,
            offsetPos: c.offsetPos || [0, 0, 0],
            offsetQuat: c.offsetQuat || [0, 0, 0, 1],
        };
        this._bodyPoseFn = bodyPoseFn;
    }

    removeNode(c) {
        const n = this.nodes.get(c.id);
        if (!n) return;
        n.obj.removeFromParent();
        n.obj.traverse(o => {
            if (o.geometry && !this._isShared(o.geometry, this.geos)) o.geometry.dispose();
        });
        this.nodes.delete(c.id);
    }

    _isShared(res, map) {
        for (const v of map.values()) if (v === res) return true;
        return false;
    }

    anim(c) {
        const n = this.nodes.get(c.id);
        if (!n || !n.mixer) return;
        const clip = THREE.AnimationClip.findByName(n.clips, c.clip) || n.clips[0];
        if (!clip) return;
        const action = n.mixer.clipAction(clip);
        if (c.action === 'stop') { action.stop(); return; }
        action.reset();
        action.loop = c.loop === 'once' ? THREE.LoopOnce : THREE.LoopRepeat;
        action.timeScale = c.speed || 1;
        if (c.action === 'crossfade' && n._lastAction && n._lastAction !== action) {
            action.play();
            n._lastAction.crossFadeTo(action, c.fade || 0.3, false);
        } else {
            action.play();
        }
        n._lastAction = action;
    }

    // Called every render frame: track physics bodies + advance mixers.
    update(bodyPoseFn) {
        const dt = this.clock.getDelta();
        const q = new THREE.Quaternion();
        const oq = new THREE.Quaternion();
        const ov = new THREE.Vector3();
        for (const n of this.nodes.values()) {
            if (n.attach) {
                const pose = bodyPoseFn(n.attach.body);
                if (pose) {
                    q.set(...pose.quat);
                    oq.set(...n.attach.offsetQuat);
                    ov.set(...n.attach.offsetPos).applyQuaternion(q);
                    n.obj.position.set(pose.pos[0] + ov.x, pose.pos[1] + ov.y, pose.pos[2] + ov.z);
                    n.obj.quaternion.copy(q).multiply(oq);
                }
            }
            if (n.mixer) n.mixer.update(dt);
        }
    }

    disposeGeo(id) { const g = this.geos.get(id); if (g) { g.dispose(); this.geos.delete(id); } }
    disposeMat(id) { const m = this.mats.get(id); if (m) { m.dispose(); this.mats.delete(id); } }
    disposeTex(id) { const t = this.texs.get(id); if (t) { t.dispose(); this.texs.delete(id); } }

    disposeAll() {
        for (const id of [...this.nodes.keys()]) this.removeNode({ id });
        for (const g of this.geos.values()) g.dispose();
        for (const m of this.mats.values()) m.dispose();
        for (const t of this.texs.values()) t.dispose();
        this.geos.clear(); this.mats.clear(); this.texs.clear();
        this.root.removeFromParent();
    }
}
