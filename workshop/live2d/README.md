# Hiyori — Live2D avatar buddy

The reference pack for the **DOM view modality**: instead of publishing
textures into the shared three.js scene, the cell asks the host to composite
its sandboxed iframe directly (`buddy.view.show()`, fullscreen, transparent,
`pointer-events: none`), and renders a Live2D Cubism model into an in-DOM
canvas at native resolution.

A plane-locked physics box anchors her in the shared PhysX world, so all the
usual desktop-buddy physicality comes for free: she stands on the taskbar and
window ledges, can be grabbed and thrown (tumbling via a CSS rotation that
mirrors the body quaternion, then self-rights with a PD torque), watches the
cursor with head/eye params, and plays a `TapBody` motion when poked.

## How it works around the sandbox

Cells have no network and the `l2d` runtime loads model files with
`fetch(dir + name)` and `Image.src` URLs. `main.js` prefetches every file
referenced by `Hiyori.model3.json` through `buddy.assets.bytes`, then shims
`window.fetch` (virtual file map → `Response`) and the
`HTMLImageElement.prototype.src` setter (virtual path → blob URL) before
calling `l2d.load()`.

One subtle ordering rule: `buddy.view.show()` is called **before** loading
the model. A `display:none` iframe gets no `requestAnimationFrame` ticks,
and l2d's whole load pipeline (including its `loaded` event) rides its rAF
render loop — waiting for `loaded` while hidden deadlocks.

## Licenses / attribution

- `l2d.min.js` — [l2d](https://github.com/hacxy/l2d) v2 by Hacxy, MIT.
  Bundles the Live2D Cubism cores; use of the Cubism SDK is subject to the
  [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).
- `model/` — **Hiyori Momose**, official Live2D Inc. sample model
  (from [CubismWebSamples](https://github.com/Live2D/CubismWebSamples)),
  provided under the
  [Live2D Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html).
  Sample data for demonstration; not for standalone redistribution.
