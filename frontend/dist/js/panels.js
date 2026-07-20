// Host UI "meta buddies": the Toybox (spawn/despawn buddies by dragging
// them in and out, adjust their exposed options) and the Profiler (per-cell
// CPU cost). These need host powers — pack lists, instance create/destroy,
// cross-cell perf — that sandboxed cells deliberately don't have, so they
// live host-side and only LOOK like buddies.
//
// Panels are positioned in desktop/page coordinates. Hosts that form-fit
// their window (native overlay, extension) union open panels into the fit
// rect via buddyUI.rects() and re-anchor them via buddyUI.reposition().

const EMOJI = {
    kirby: '🌸', wisp: '✨', live2d: '🐶', swordfighter: '⚔️',
    'interactive-buddy': '🤖', stickman: '✏️', sm64: '🍄',
};

let deps = null;           // { cartMgr, interact, desk, sim }
let winRect = { x: 0, y: 0 }; // current form-fit window origin (page css)
const panels = [];         // { el, page:{x,y}, visible() }

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------
const CSS = `
.be-panel {
    position: fixed; z-index: 15;
    background: rgba(26, 26, 46, 0.96);
    border: 1px solid rgba(124, 131, 255, 0.4);
    border-radius: 10px;
    color: #e0e0ff;
    font-family: 'Segoe UI', Tahoma, sans-serif;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    user-select: none; -webkit-user-select: none;
    display: none;
}
.be-panel-title {
    padding: 7px 12px; font-size: 11px; letter-spacing: 1px;
    text-transform: uppercase; color: #9aa0d0; cursor: grab;
    border-bottom: 1px solid rgba(124,131,255,0.25);
    display: flex; justify-content: space-between; align-items: center;
}
.be-panel-title b { color: #c6caff; }
.be-x { cursor: pointer; padding: 0 4px; color: #9aa0d0; }
.be-x:hover { color: #ff9a9a; }
.be-tiles { display: grid; grid-template-columns: repeat(4, 72px); gap: 8px; padding: 10px; }
.be-tile {
    width: 72px; height: 64px; border-radius: 8px; cursor: grab;
    background: rgba(124,131,255,0.12); border: 1px solid rgba(124,131,255,0.25);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; overflow: hidden;
}
.be-tile:hover { background: rgba(124,131,255,0.28); }
.be-tile.be-sel { border-color: #8fd3ff; }
.be-tile .em { font-size: 22px; line-height: 1; pointer-events: none; }
.be-tile .nm { font-size: 10px; color: #b9bdf0; max-width: 68px; white-space: nowrap;
    text-overflow: ellipsis; overflow: hidden; pointer-events: none; }
.be-tile .ct { position: absolute; } /* unused; badge below */
.be-badge { font-size: 9px; color: #7fe08a; pointer-events: none; }
.be-side {
    border-top: 1px solid rgba(124,131,255,0.25);
    padding: 8px 12px 10px; max-height: 220px; overflow-y: auto;
}
.be-side h4 { font-size: 11px; color: #9aa0d0; margin: 4px 0 6px; text-transform: uppercase; letter-spacing: 1px; }
.be-opt { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
.be-opt label { flex: 1; color: #c6caff; font-size: 12px; }
.be-opt input[type=range] { width: 110px; }
.be-inst { display: flex; align-items: center; gap: 8px; margin: 3px 0; font-size: 12px; }
.be-inst .be-x { margin-left: auto; }
.be-hint { padding: 4px 12px 10px; font-size: 10px; color: #8087b8; }
.be-prof-rows { padding: 8px 12px 12px; min-width: 300px; }
.be-prow { display: grid; grid-template-columns: 92px 1fr 52px 40px; gap: 8px; align-items: center; margin: 4px 0; font-size: 12px; }
.be-prow .bar { height: 8px; border-radius: 4px; background: rgba(124,131,255,0.15); position: relative; overflow: hidden; }
.be-prow .bar i { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: #7fe08a; }
.be-prow .ms { text-align: right; color: #c6caff; }
.be-prow .in { text-align: right; color: #8087b8; }
`;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function makePanel(title, pageX, pageY) {
    const p = el('div', 'be-panel');
    const bar = el('div', 'be-panel-title');
    const t = el('b', '', title);
    const x = el('span', 'be-x', '✕');
    bar.append(t, x);
    p.append(bar);
    document.body.append(p);
    const rec = { el: p, page: { x: pageX, y: pageY } };
    x.addEventListener('click', () => { p.style.display = 'none'; syncUiHover(false); });
    // Title-bar dragging (page coords).
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
    p.addEventListener('pointerenter', () => syncUiHover(true));
    p.addEventListener('pointerleave', () => syncUiHover(false));
    panels.push(rec);
    place(rec);
    return rec;
}

function syncUiHover(v) { if (deps) deps.interact.uiHover = v; }

function place(rec) {
    rec.el.style.left = (rec.page.x - winRect.x) + 'px';
    rec.el.style.top = (rec.page.y - winRect.y) + 'px';
}

// ---------------------------------------------------------------------------
// buddyUI: form-fit integration
// ---------------------------------------------------------------------------
window.buddyUI = {
    // Page-space css rects of visible panels (formfit unions these in).
    rects() {
        return panels
            .filter(p => p.el.style.display !== 'none' && p.el.style.display !== '')
            .map(p => ({ x: p.page.x, y: p.page.y, w: p.el.offsetWidth, h: p.el.offsetHeight }));
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
    // instance badges
    for (const tile of toybox.tiles.children) {
        const n = instanceCount(tile.dataset.pack);
        tile.querySelector('.be-badge').textContent = n ? `×${n}` : '';
        tile.classList.toggle('be-sel', tile.dataset.pack === selPack);
    }
    const side = toybox.side;
    side.textContent = '';
    if (!selPack) {
        side.append(el('h4', '', 'select a buddy'));
        return;
    }
    side.append(el('h4', '', selPack + ' — options'));
    const cells = cellsOf(selPack);
    const schemaCell = cells.find(c => c.optionsSchema);
    if (schemaCell) {
        for (const [key, o] of Object.entries(schemaCell.optionsSchema)) {
            const row = el('div', 'be-opt');
            row.append(el('label', '', o.label));
            let input;
            if (o.type === 'range') {
                input = el('input');
                input.type = 'range';
                input.min = o.min; input.max = o.max; input.step = o.step;
                input.value = schemaCell.optionValues[key];
                input.addEventListener('input', () => {
                    for (const c of cells) deps.cartMgr.setCellOption(c.id, key, +input.value);
                });
            } else if (o.type === 'select') {
                input = el('select');
                for (const ch of o.choices || []) {
                    const opt = el('option', '', ch);
                    opt.value = ch;
                    input.append(opt);
                }
                input.value = schemaCell.optionValues[key];
                input.addEventListener('change', () => {
                    for (const c of cells) deps.cartMgr.setCellOption(c.id, key, input.value);
                });
            } else {
                input = el('input');
                input.type = 'checkbox';
                input.checked = !!schemaCell.optionValues[key];
                input.addEventListener('change', () => {
                    for (const c of cells) deps.cartMgr.setCellOption(c.id, key, input.checked);
                });
            }
            row.append(input);
            side.append(row);
        }
    } else {
        side.append(el('div', 'be-inst', 'no options exposed'));
    }
    // live instances with destroy buttons
    side.append(el('h4', '', 'instances'));
    let any = false;
    for (const c of cells) {
        const iids = c.instanced ? [...c.instances] : [null];
        for (const iid of iids) {
            any = true;
            const row = el('div', 'be-inst', c.id + (iid != null ? ' · i' + iid : ''));
            const x = el('span', 'be-x', '✕');
            x.addEventListener('click', () => {
                deps.cartMgr.destroyInstance(c.id, iid);
                setTimeout(refreshSidebar, 120);
            });
            row.append(x);
            side.append(row);
        }
    }
    if (!any) side.append(el('div', 'be-inst', 'none'));
}

// ---------------------------------------------------------------------------
// Profiler
// ---------------------------------------------------------------------------
let profiler = null;

function refreshProfiler() {
    if (!profiler || profiler.el.style.display === 'none') return;
    const rows = profiler.rows;
    rows.textContent = '';
    const cells = [...deps.cartMgr.cells.values()].filter(c => !c.dead);
    cells.sort((a, b) => ((b.perf && b.perf.avg) || 0) - ((a.perf && a.perf.avg) || 0));
    const maxMs = Math.max(2, ...cells.map(c => (c.perf && c.perf.avg) || 0));
    for (const c of cells) {
        const avg = (c.perf && c.perf.avg) || 0;
        const stale = !c.perf || performance.now() - c.perf.at > 3000;
        const row = el('div', 'be-prow');
        row.append(el('div', '', c.name));
        const bar = el('div', 'bar');
        const fill = el('i');
        fill.style.width = Math.min(100, avg / maxMs * 100) + '%';
        fill.style.background = avg > 8 ? '#ff9a9a' : avg > 3 ? '#ffd27f' : '#7fe08a';
        bar.append(fill);
        row.append(bar);
        row.append(el('div', 'ms', stale ? '—' : avg.toFixed(2) + 'ms'));
        row.append(el('div', 'in', '×' + (c.instanced ? c.instances.size : 1)));
        rows.append(row);
    }
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

    // Toybox: bottom middle-left, above the ground line.
    toybox = makePanel('🧸 Toybox', Math.max(8, pw / 2 - 340), ph - 360);
    toybox.tiles = el('div', 'be-tiles');
    toybox.side = el('div', 'be-side');
    toybox.el.append(toybox.tiles, toybox.side,
        el('div', 'be-hint', 'drag a buddy out to spawn it · drop it back in to despawn · click = spawn'));

    profiler = makePanel('📈 Profiler', pw - 380, ph - 300);
    profiler.rows = el('div', 'be-prof-rows');
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
    return {
        openToybox() { toybox.el.style.display = 'block'; buildToybox(); place(toybox); },
    };
}
