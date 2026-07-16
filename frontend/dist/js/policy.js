// ONNX policy inference: HLC (obs + task_obs -> latent z) feeding the shared
// LLC (obs + latent -> 31 PD targets). ASE mode drives the LLC directly with
// a slerped random latent for idle behavior.

import { extractOnnxMetadata } from './mjcf.js';
import { gaussianRandom } from './math3d.js';

export class Policy {
    constructor() {
        this.llc = null;
        this.hlc = null;
        this.meta = null;
        this.latentDim = 64;
        this.latentVec = null;
        this.latentTarget = null;
        this.latentBlendRate = 0.05;
    }

    // buffers: { llc: ArrayBuffer, hlc: ArrayBuffer|null }
    async load(buffers) {
        ort.env.wasm.wasmPaths = new URL('/vendor/', window.location.href).href;
        ort.env.wasm.numThreads = 1; // no SharedArrayBuffer requirement

        this.llc = await ort.InferenceSession.create(buffers.llc, { executionProviders: ['wasm'] });
        this.meta = extractOnnxMetadata(buffers.llc);
        if (buffers.hlc) {
            try {
                this.hlc = await ort.InferenceSession.create(buffers.hlc, { executionProviders: ['wasm'] });
            } catch (e) {
                console.warn('HLC load failed, strike mode disabled:', e.message);
            }
        }
        if (this.meta && this.meta.latent_dim) this.latentDim = this.meta.latent_dim;
        this.randomLatent();
    }

    randomLatent() {
        this.latentVec = this.sampleUnit();
        this.latentTarget = new Float32Array(this.latentVec);
    }

    newLatentTarget() {
        this.latentTarget = this.sampleUnit();
    }

    sampleUnit() {
        const v = new Float32Array(this.latentDim);
        let norm = 0;
        for (let i = 0; i < v.length; i++) { v[i] = gaussianRandom(); norm += v[i]*v[i]; }
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < v.length; i++) v[i] /= norm;
        return v;
    }

    slerpLatent() {
        if (!this.latentTarget || !this.latentVec) return;
        let norm = 0;
        for (let i = 0; i < this.latentVec.length; i++) {
            this.latentVec[i] += this.latentBlendRate * (this.latentTarget[i] - this.latentVec[i]);
            norm += this.latentVec[i] * this.latentVec[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 1e-8) for (let i = 0; i < this.latentVec.length; i++) this.latentVec[i] /= norm;
    }

    async runStrike(obs, taskObs, obsDim) {
        if (!this.hlc) return this.runLatent(obs, obsDim);
        const obsTensor = new ort.Tensor('float32', obs, [1, obsDim]);
        const taskObsTensor = new ort.Tensor('float32', taskObs, [1, 15]);
        const hlcResult = await this.hlc.run({ obs: obsTensor, task_obs: taskObsTensor });
        const z = hlcResult.z.data;
        const latentTensor = new ort.Tensor('float32', z, [1, this.latentDim]);
        const llcResult = await this.llc.run({ obs: obsTensor, latent: latentTensor });
        return llcResult.action.data;
    }

    async runLatent(obs, obsDim) {
        const obsTensor = new ort.Tensor('float32', obs, [1, obsDim]);
        const latentTensor = new ort.Tensor('float32', this.latentVec, [1, this.latentDim]);
        const results = await this.llc.run({ obs: obsTensor, latent: latentTensor });
        return results.action.data;
    }
}

// Loads model buffers either from the built-in assets or a workshop pack.
export async function loadModelBuffers(pack) {
    if (!pack) {
        const [llc, hlc] = await Promise.all([
            fetch('./assets/llc_sword_shield.onnx').then(r => r.arrayBuffer()),
            fetch('./assets/hlc_strike.onnx').then(r => r.arrayBuffer()).catch(() => null),
        ]);
        return { llc, hlc };
    }
    const manifest = JSON.parse(typeof pack.manifest === 'string' ? pack.manifest : JSON.stringify(pack.manifest));
    const readB64 = async (rel) => {
        const b64 = await window.go.main.App.ReadPackFile(pack.id, rel);
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    };
    const llc = await readB64(manifest.llc);
    let hlc = null;
    if (manifest.hlc_strike) {
        try { hlc = await readB64(manifest.hlc_strike); } catch (e) { console.warn(e); }
    }
    return { llc, hlc, manifest };
}
