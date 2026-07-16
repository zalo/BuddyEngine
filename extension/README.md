# BuddyEngine WebExtension

Puts the buddies on every web page. The extension itself is ~100 lines: a
content script injects `overlay.html` from the hosted demo
(https://zalo.github.io/BuddyEngine/) as a fullscreen, transparent,
click-through iframe, forwards pointer input into it, and toggles the
iframe's `pointer-events` when the engine reports a buddy under the cursor
(the native Win32 overlay's click-through model, ported to the DOM). Big
visible page elements (images, headers, videos…) are streamed in as physics
platforms, so buddies stand on the page's content and get shoved around
when you scroll.

Why an iframe to the hosted site instead of bundling the engine?
Extension-page CSP (MV3, and Safari/Firefox MV2 too) forbids the
`blob:`/inline scripts that the engine's sandboxed buddy cells are built
on. A remote iframe is ordinary web content governed by its own CSP, so
the whole engine — PhysX WASM, cells, Live2D — runs unmodified, and every
Pages deploy updates all installs. The trade-offs: it needs network, and
pages with a strict `frame-src`/`child-src` CSP (github.com, banks) will
block the overlay on those sites.

## Install — Android Firefox

Firefox for Android (121+) supports normal WebExtensions.

Easiest (temporary, for development):
1. Install [Firefox Nightly] and enable the three-dot menu →
   Settings → About Firefox Nightly → tap the logo 5× (debug menu).
2. Or, from a desktop with `adb` + [web-ext]:
   ```bash
   npm i -g web-ext
   cd extension/
   web-ext run --target=firefox-android --android-device=<device-id> \
     --firefox-apk=org.mozilla.fenix
   ```

Permanent: zip this folder (`cd extension && zip -r ../buddyengine.xpi .`),
upload to [addons.mozilla.org] (self-distribution / unlisted is fine — AMO
signs it), then open the signed `.xpi` in Firefox for Android, or add it to
a [custom add-on collection] and point Nightly's debug menu at it.

## Install — iOS Safari

Safari Web Extensions must be wrapped in an app with Xcode (macOS):

```bash
xcrun safari-web-extension-converter extension/ \
  --project-location build/safari --app-name "BuddyEngine Buddies" \
  --bundle-identifier com.example.buddyengine --ios-only
open build/safari/"BuddyEngine Buddies"/*.xcodeproj
```

Build & run on your device (free personal team signing works), then enable
it: Settings → Apps → Safari → Extensions → BuddyEngine Buddies → Allow,
and grant it "All Websites" access. The overlay is touch-driven the same
way the mobile web demo is: tap-drag grabs a buddy.

## Desktop testing (any Chromium/Firefox)

- Chromium: `chrome --load-extension=$(pwd)/extension`
- Firefox: `about:debugging` → This Firefox → Load Temporary Add-on →
  pick `extension/manifest.json`.

## Performance

The iframe doesn't stay fullscreen: the engine streams `be.viewport`
rects and the content script form-fits the iframe to the buddies'
bounding box (+ padding, quantized to a 64px grid), so the page only pays
compositor fillrate where buddies actually are. The engine keeps
simulating in full-page coordinates; the ortho camera window and the
buddy-cell iframes are counter-shifted when the child observes its own
resize, so nothing visually jumps. The engine also self-caps to 30fps on
battery power or sustained CPU pressure (`?fps=N` on the overlay URL
forces a cap). With engine debug colliders on, the current window
boundary is drawn in magenta.

## Notes / limits

- Sites with strict `frame-src` CSP block the overlay iframe entirely.
- The overlay reloads itself on real viewport changes (rotation).
- To pick which buddies spawn, edit `OVERLAY_URL` in `content.js` and add
  `?packs=kirby,live2d` (defaults exclude `sm64` and `stickman`).
