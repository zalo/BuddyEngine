// Host UI "meta buddies": the Toybox (spawn/despawn buddies by dragging
// them in and out, adjust their exposed options) and the Profiler (per-pack
// CPU cost). These need host powers — pack lists, instance create/destroy,
// cross-cell perf — that sandboxed cells deliberately don't have, so they
// live host-side and only LOOK like buddies.
//
// Design: "toy hardware" — molded warm-charcoal plastic, XP-era Trebuchet
// chrome, instrument monospace numerals, candy-coral (toybox) and mint
// (profiler) identities. Everything must read at small sizes over any
// backdrop, so panels are near-opaque with a plastic sheen and one hot
// accent each.
//
// Panels are positioned in desktop/page coordinates. Hosts that form-fit
// their window union open panels into the fit rect via buddyUI.rects() and
// re-anchor them via buddyUI.reposition(); interact polls buddyUI.hitTest()
// with the global cursor to flip click-through off over a panel.

const EMOJI = {
    kirby: '🌸', wisp: '✨', live2d: '🐶', swordfighter: '⚔️',
    'interactive-buddy': '🤖', stickman: '✏️', sm64: '🍄',
};

let deps = null;              // { cartMgr, interact, desk, sim }
let winRect = { x: 0, y: 0 }; // current form-fit window origin (page css)
const panels = [];            // { el, page:{x,y} }

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------
const CSS = `
.be-panel {
    --chassis: #211d26;
    --chassis-hi: #2c2733;
    --ink: #efe9f4;
    --ink-dim: #9d93ab;
    --line: rgba(255,255,255,0.07);
    position: fixed; z-index: 15;
    background:
        radial-gradient(120% 90% at 50% -20%, rgba(255,255,255,0.055), transparent 55%),
        var(--chassis);
    border: 1px solid #14111a;
    border-radius: 14px;
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.09),
        inset 0 -1px 0 rgba(0,0,0,0.45),
        0 14px 34px rgba(10, 6, 18, 0.55);
    color: var(--ink);
    font-family: 'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif;
    font-size: 13px;
    user-select: none; -webkit-user-select: none;
    display: none;
    animation: be-pop 0.18s cubic-bezier(0.34, 1.4, 0.64, 1);
    overflow: hidden;
}
@keyframes be-pop { from { transform: scale(0.95) translateY(6px); opacity: 0; } }
.be-panel[data-acc="coral"] { --acc: #ff7a59; --acc-soft: rgba(255,122,89,0.16); }
.be-panel[data-acc="mint"]  { --acc: #5fe8a8; --acc-soft: rgba(95,232,168,0.14); }

.be-title {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px 7px 12px;
    cursor: grab;
    background:
        radial-gradient(circle at 1.5px 1.5px, rgba(255,255,255,0.10) 1px, transparent 1.5px) 0 0 / 7px 7px,
        linear-gradient(180deg, var(--chassis-hi), var(--chassis));
    border-bottom: 1px solid #14111a;
    box-shadow: 0 1px 0 var(--line);
}
.be-title:active { cursor: grabbing; }
.be-title .be-em { font-size: 14px; filter: saturate(1.2); }
.be-title b {
    font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--ink); font-weight: 700;
}
.be-title .be-sub {
    font-family: Consolas, Menlo, monospace;
    font-size: 10px; color: var(--acc); margin-left: auto;
    background: var(--acc-soft); border-radius: 99px; padding: 2px 8px;
}
.be-x {
    width: 20px; height: 20px; border-radius: 50%;
    display: grid; place-items: center;
    color: var(--ink-dim); font-size: 11px; cursor: pointer;
    background: rgba(0,0,0,0.25);
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.5), 0 1px 0 var(--line);
}
.be-x:hover { color: #fff; background: rgba(255,90,90,0.35); }
.be-accline { height: 2px; background: linear-gradient(90deg, var(--acc), transparent 70%); }

/* --- toybox tiles ------------------------------------------------------- */
.be-tiles { display: grid; grid-template-columns: repeat(4, 74px); gap: 9px; padding: 12px; }
.be-tile {
    position: relative;
    height: 68px; border-radius: 11px; cursor: grab;
    background: linear-gradient(180deg, var(--chassis-hi), #262130);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.10),
        inset 0 -2px 0 rgba(0,0,0,0.35),
        0 2px 4px rgba(0,0,0,0.35);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 1px;
    transition: transform 0.08s ease, box-shadow 0.08s ease;
}
.be-tile:hover { transform: translateY(-2px); box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -2px 0 rgba(0,0,0,0.35),
    0 6px 12px rgba(0,0,0,0.45); }
.be-tile:active { transform: translateY(1px); box-shadow:
    inset 0 2px 5px rgba(0,0,0,0.5); }
.be-tile.be-sel { outline: 2px solid var(--acc); outline-offset: -2px; }
.be-tile .em { font-size: 24px; line-height: 1.1; pointer-events: none;
    filter: drop-shadow(0 2px 2px rgba(0,0,0,0.4)); }
.be-tile .nm { font-size: 10px; color: var(--ink-dim); max-width: 68px;
    white-space: nowrap; text-overflow: ellipsis; overflow: hidden; pointer-events: none; }
.be-badge {
    position: absolute; top: 4px; right: 4px;
    font-family: Consolas, Menlo, monospace; font-size: 9px; font-weight: 700;
    color: #1d1420; background: var(--acc);
    border-radius: 99px; padding: 1px 5px; pointer-events: none;
    box-shadow: 0 1px 3px rgba(0,0,0,0.5);
}
.be-badge:empty { display: none; }

/* --- sidebar (options + instances) -------------------------------------- */
.be-side { padding: 4px 14px 10px; max-height: 240px; overflow-y: auto; }
.be-side::-webkit-scrollbar { width: 6px; }
.be-side::-webkit-scrollbar-thumb { background: var(--chassis-hi); border-radius: 3px; }
.be-h {
    display: flex; align-items: center; gap: 6px;
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--ink-dim); margin: 10px 0 6px;
}
.be-h::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.be-opt { display: flex; align-items: center; gap: 10px; margin: 7px 0; }
.be-opt label { flex: 1; font-size: 12px; color: var(--ink); }
.be-opt input[type=range] { width: 108px; accent-color: var(--acc); }
.be-opt select {
    background: var(--chassis-hi); color: var(--ink);
    border: 1px solid #14111a; border-radius: 6px; padding: 2px 6px; font-size: 11px;
}
.be-switch { position: relative; width: 34px; height: 18px; flex: none; cursor: pointer; }
.be-switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.be-switch i {
    position: absolute; inset: 0; border-radius: 99px;
    background: rgba(0,0,0,0.45);
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.6), 0 1px 0 var(--line);
    transition: background 0.15s ease;
}
.be-switch i::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 50%;
    background: linear-gradient(180deg, #f4eef8, #b9aec6);
    box-shadow: 0 1px 2px rgba(0,0,0,0.5);
    transition: transform 0.15s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.be-switch input:checked + i { background: var(--acc); }
.be-switch input:checked + i::after { transform: translateX(16px); }
.be-inst {
    display: flex; align-items: center; gap: 8px; margin: 4px 0;
    font-family: Consolas, Menlo, monospace; font-size: 11px; color: var(--ink-dim);
}
.be-inst .be-x { width: 16px; height: 16px; font-size: 9px; margin-left: auto; }
.be-hint {
    padding: 7px 14px 10px; font-size: 9px; letter-spacing: 0.6px;
    color: var(--ink-dim); border-top: 1px solid var(--line);
}
.be-hint b { color: var(--acc); font-weight: 700; }

/* --- profiler ------------------------------------------------------------ */
.be-prof { padding: 10px 14px 12px; min-width: 280px; }
.be-prow { margin: 8px 0; }
.be-prow .top {
    display: flex; align-items: baseline; gap: 7px; margin-bottom: 4px;
}
.be-prow .em { font-size: 13px; }
.be-prow .nm { font-size: 12px; color: var(--ink); font-weight: 700; }
.be-prow .ct {
    font-family: Consolas, Menlo, monospace; font-size: 9px;
    color: var(--ink-dim); background: rgba(0,0,0,0.3);
    border-radius: 99px; padding: 1px 6px;
}
.be-prow .ms {
    margin-left: auto; font-family: Consolas, Menlo, monospace;
    font-size: 12px; color: var(--ink);
}
.be-prow .ms small { color: var(--ink-dim); font-size: 9px; }
.be-prow .bar {
    height: 7px; border-radius: 4px;
    background: rgba(0,0,0,0.4);
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.6);
    overflow: hidden;
}
.be-prow .bar i {
    display: block; height: 100%; border-radius: 4px;
    background: linear-gradient(90deg, var(--acc), color-mix(in srgb, var(--acc) 60%, #fff 10%));
    transition: width 0.25s ease;
    box-shadow: 0 0 6px var(--acc-soft);
}
.be-prow.warn .bar i { background: linear-gradient(90deg, #ffc65c, #ffdb8f); }
.be-prow.hot .bar i { background: linear-gradient(90deg, #ff6d6d, #ff9a8a); }
.be-empty { color: var(--ink-dim); font-size: 11px; padding: 6px 0; font-style: italic; }
`;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function makePanel(emoji, title, accent, pageX, pageY) {
    const p = el('div', 'be-panel');
    p.dataset.acc = accent;
    const bar = el('div', 'be-title');
    bar.append(el('span', 'be-em', emoji), el('b', '', title));
    const sub = el('span', 'be-sub', '');
    const x = el('span', 'be-x', '✕');
    bar.append(sub, x);
    p.append(bar, el('div', 'be-accline'));
    document.body.append(p);
    const rec = { el: p, page: { x: pageX, y: pageY }, sub };
    x.addEventListener('click', () => { p.style.display = 'none'; });
    bar.addEventListener('pointerdown', (e) => {
        if (e.target === x) return;
        const start = { x: e.clientX, y: e.clientY, px: rec.page.x, py: rec.page.y };
        const move = (ev) => {
            rec.page.x = start.px + ev.clientX - start.x;
            rec.page.y = start.py + ev.clientY - start.y;
            place(rec);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        e.stopPropagation();
    });
    panels.push(rec);
    place(rec);
    return rec;
}

function place(rec) {
    rec.el.style.left = (rec.page.x - winRect.x) + 'px';
    rec.el.style.top = (rec.page.y - winRect.y) + 'px';
}

// ---------------------------------------------------------------------------
// buddyUI: form-fit + click-through integration
// ---------------------------------------------------------------------------
window.buddyUI = {
    // Page-space css rects of visible panels (formfit unions these in).
    rects() {
        return panels
            .filter(p => p.el.style.display === 'block')
            .map(p => ({ x: p.page.x, y: p.page.y, w: p.el.offsetWidth, h: p.el.offsetHeight }));
    },
    // Is this page-css point over an open panel? Drives the click-through
    // activator: on the native overlay the cursor is a global stream and DOM
    // hover events never fire while the window is click-through, so interact
    // polls this every frame.
    hitTest(cssX, cssY) {
        return this.rects().some(r =>
            cssX >= r.x && cssX <= r.x + r.w && cssY >= r.y && cssY <= r.y + r.h);
    },
    // Re-anchor panels after the window rect changed.
    reposition(rect) {
        winRect = rect;
        panels.forEach(place);
    },
};

// ---------------------------------------------------------------------------
// Toybox
// ---------------------------------------------------------------------------
let toybox = null;
let selPack = null;

async function buildToybox() {
    const packs = await window.go.main.App.RefreshPacks();
    toybox.tiles.textContent = '';
    for (const p of packs) {
        const tile = el('div', 'be-tile');
        tile.append(el('div', 'em', EMOJI[p.id] || '🧩'));
        tile.append(el('div', 'nm', p.name || p.id));
        tile.append(el('div', 'be-badge', ''));
        tile.dataset.pack = p.id;
        toybox.tiles.append(tile);
        tile.addEventListener('pointerdown', (e) => startTileDrag(e, p.id));
    }
    refreshSidebar();
}

function cellsOf(packId) {
    return [...deps.cartMgr.cells.values()].filter(c => c.pack.id === packId && !c.dead);
}

function instanceCount(packId) {
    let n = 0;
    for (const c of cellsOf(packId)) n += c.instanced ? c.instances.size : 1;
    return n;
}

function insidePanel(rec, pageX, pageY) {
    return pageX >= rec.page.x && pageX <= rec.page.x + rec.el.offsetWidth &&
           pageY >= rec.page.y && pageY <= rec.page.y + rec.el.offsetHeight;
}

// Drag a tile: the buddy is created the moment the drag starts, held by the
// grab spring; releasing back inside the toybox despawns it. A plain click
// (no movement) just spawns it in front of the toybox.
function startTileDrag(e, packId) {
    selPack = packId;
    refreshSidebar();
    const dpr = window.devicePixelRatio || 1;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    let ref = null;      // {cellId, iid}
    let grabbed = false;
    let released = false;
    let releasePage = null;

    const cursorPage = () => ({ x: deps.interact.cursor.x / dpr, y: deps.interact.cursor.y / dpr });
    const spawnWorld = () => {
        const cw = deps.interact.cursorWorld();
        return { x: cw.x, z: Math.max(cw.z, 0.4), dragged: true };
    };

    // Create immediately (spec: exists the moment it leaves the tray).
    Promise.resolve(deps.cartMgr.spawnInstance(packId, spawnWorld())).then(r => {
        ref = r;
        pollForBody();
        refreshSidebar();
    });

    // Grab its first body as soon as physics has one.
    const t0 = performance.now();
    function pollForBody() {
        if (released || grabbed) return;
        if (performance.now() - t0 > 6000 || !ref) return;
        const pref = ref.iid != null ? `${ref.cellId}/i${ref.iid}.` : `${ref.cellId}/`;
        for (const t of deps.sim.hoverTargets()) {
            if (t.id.startsWith(pref)) {
                grabbed = deps.interact.beginDrag(t.id);
                return;
            }
        }
        requestAnimationFrame(pollForBody);
    }

    const move = (ev) => {
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 8) moved = true;
    };
    const up = () => {
        released = true;
        releasePage = cursorPage();
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        deps.interact.endDrag();
        const finish = () => {
            if (!ref) return setTimeout(finish, 100); // spawn still in flight
            if (moved && insidePanel(toybox, releasePage.x, releasePage.y)) {
                deps.cartMgr.destroyInstance(ref.cellId, ref.iid); // put back in the box
            }
            refreshSidebar();
        };
        finish();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

function refreshSidebar() {
    if (!toybox) return;
    let total = 0;
    for (const tile of toybox.tiles.children) {
        const n = instanceCount(tile.dataset.pack);
        total += n;
        tile.querySelector('.be-badge').textContent = n ? '×' + n : '';
        tile.classList.toggle('be-sel', tile.dataset.pack === selPack);
    }
    toybox.sub.textContent = total + ' out';
    const side = toybox.side;
    side.textContent = '';
    if (!selPack) {
        side.append(el('div', 'be-h', 'pick a toy'));
        return;
    }
    side.append(el('div', 'be-h', (EMOJI[selPack] || '') + ' ' + selPack + ' options'));
    const cells = cellsOf(selPack);
    const schemaCell = cells.find(c => c.optionsSchema);
    if (schemaCell) {
        for (const [key, o] of Object.entries(schemaCell.optionsSchema)) {
            const row = el('div', 'be-opt');
            row.append(el('label', '', o.label));
            if (o.type === 'range') {
                const input = el('input');
                input.type = 'range';
                input.min = o.min; input.max = o.max; input.step = o.step;
                input.value = schemaCell.optionValues[key];
                input.addEventListener('input', () => {
                    for (const c of cells) deps.cartMgr.setCellOption(c.id, key, +input.value);
                });
                row.append(input);
            } else if (o.type === 'select') {
                const input = el('select');
                for (const ch of o.choices || []) {
                    const opt = el('option', '', ch);
                    opt.value = ch;
                    input.append(opt);
                }
                input.value = schemaCell.optionValues[key];
                input.addEventListener('change', () => {
                    for (const c of cells) deps.cartMgr.setCellOption(c.id, key, input.value);
                });
                row.append(input);
            } else {
                const sw = el('label', 'be-switch');
                const input = el('input');
                input.type = 'checkbox';
                input.checked = !!schemaCell.optionValues[key];
                input.addEventListener('change', () => {
                    for (const c of cells) deps.cartMgr.setCellOption(c.id, key, input.checked);
                });
                sw.append(input, el('i'));
                row.append(sw);
            }
            side.append(row);
        }
    } else {
        side.append(el('div', 'be-empty', 'no options exposed'));
    }
    side.append(el('div', 'be-h', 'out of the box'));
    let any = false;
    for (const c of cells) {
        const iids = c.instanced ? [...c.instances] : [null];
        for (const iid of iids) {
            any = true;
            const row = el('div', 'be-inst', c.id + (iid != null ? '·i' + iid : ''));
            const x = el('span', 'be-x', '✕');
            x.addEventListener('click', () => {
                deps.cartMgr.destroyInstance(c.id, iid);
                setTimeout(refreshSidebar, 120);
            });
            row.append(x);
            side.append(row);
        }
    }
    if (!any) side.append(el('div', 'be-empty', 'none out yet'));
}

// ---------------------------------------------------------------------------
// Profiler — grouped by pack, sorted by cost
// ---------------------------------------------------------------------------
let profiler = null;

function refreshProfiler() {
    if (!profiler || profiler.el.style.display !== 'block') return;
    const rows = profiler.rows;
    rows.textContent = '';
    // Group cells by pack: legacy multi-spawns of the same buddy are one row.
    const groups = new Map();
    for (const c of deps.cartMgr.cells.values()) {
        if (c.dead) continue;
        const g = groups.get(c.pack.id) || { name: c.name, pack: c.pack.id, avg: 0, worst: 0, n: 0, stale: true };
        if (c.perf) {
            g.avg += c.perf.avg;
            g.worst = Math.max(g.worst, c.perf.worst);
            if (performance.now() - c.perf.at < 3000) g.stale = false;
        }
        g.n += c.instanced ? c.instances.size : 1;
        g.name = c.name;
        groups.set(c.pack.id, g);
    }
    const list = [...groups.values()].sort((a, b) => b.avg - a.avg);
    const totalMs = list.reduce((s, g) => s + g.avg, 0);
    profiler.sub.textContent = totalMs.toFixed(1) + 'ms/f';
    const maxMs = Math.max(1.5, ...list.map(g => g.avg));
    for (const g of list) {
        const row = el('div', 'be-prow' + (g.avg > 8 ? ' hot' : g.avg > 3 ? ' warn' : ''));
        const top = el('div', 'top');
        top.append(el('span', 'em', EMOJI[g.pack] || '🧩'));
        top.append(el('span', 'nm', g.name));
        top.append(el('span', 'ct', '×' + g.n));
        const ms = el('span', 'ms', g.stale ? '—' : g.avg.toFixed(2));
        if (!g.stale) ms.append(el('small', '', ' ms'));
        top.append(ms);
        const bar = el('div', 'bar');
        const fill = el('i');
        fill.style.width = (g.stale ? 0 : Math.min(100, g.avg / maxMs * 100)) + '%';
        bar.append(fill);
        row.append(top, bar);
        rows.append(row);
    }
    if (!list.length) rows.append(el('div', 'be-empty', 'no buddies running'));
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
export function initPanels(d) {
    deps = d;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    const dpr = window.devicePixelRatio || 1;
    const pw = deps.desk.screenW / dpr, ph = deps.desk.groundPy / dpr;

    toybox = makePanel('🧸', 'Toybox', 'coral', Math.max(8, pw / 2 - 360), Math.max(8, ph - 420));
    toybox.tiles = el('div', 'be-tiles');
    toybox.side = el('div', 'be-side');
    const hint = el('div', 'be-hint');
    hint.innerHTML = '<b>drag out</b> to spawn &nbsp;·&nbsp; <b>drop back in</b> to despawn &nbsp;·&nbsp; <b>click</b> = spawn';
    toybox.el.append(toybox.tiles, toybox.side, hint);

    profiler = makePanel('📈', 'Profiler', 'mint', Math.min(pw - 320, pw - 340), Math.max(8, ph - 300));
    profiler.rows = el('div', 'be-prof');
    profiler.el.append(profiler.rows);
    setInterval(refreshProfiler, 500);
    setInterval(() => { if (toybox.el.style.display === 'block') refreshSidebar(); }, 1200);

    // Menu entries (injected — the menu markup lives in three host pages).
    const menu = document.getElementById('menu');
    if (menu) {
        const mkBtn = (label, rec, build) => {
            const b = el('button', '', label);
            b.addEventListener('click', () => {
                const show = rec.el.style.display !== 'block';
                rec.el.style.display = show ? 'block' : 'none';
                if (show && build) build();
                place(rec);
                menu.style.display = 'none';
                deps.interact.menuOpen = false;
            });
            menu.insertBefore(b, menu.querySelector('hr'));
        };
        mkBtn('Toybox...', toybox, buildToybox);
        mkBtn('Profiler...', profiler, null);
    }

    // Open by default: the toybox IS the buddy launcher.
    toybox.el.style.display = 'block';
    profiler.el.style.display = 'block';
    buildToybox();
    refreshProfiler();

    return {
        openToybox() { toybox.el.style.display = 'block'; buildToybox(); place(toybox); },
    };
}
