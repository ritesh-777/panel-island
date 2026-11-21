// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Panel Island: pill-shaped capsules round the top bar's left and right items, matching Isle's island, and
// their menus opening as that glass growing out of the button into the menu (and back into it as they close).
// Isle's own glass (src/glass.js) and theme (src/theme.js) are imported from where Isle is installed, at the
// same URI Isle loads them from, so this shares Isle's modules (and its theme state) instead of copying them.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {migrate} from './migrate.js';
import {keepBar, setBar} from './topBar.js';
import {keepActivities} from './activities.js';
import {IslandService} from './island.js';
import {WorkspaceGlass} from './workspaceGlass.js';
import {followShared, isSwitching, keepInOverview, onSwitch, releaseOverview, setIsleBehaviour, setSwitchGlass}
    from './overview.js';
import {setIsleSolidEdge, smoothIsleCorners} from './isleCorners.js';
import {addIsleWeather} from './isleWeather.js';
import {lightIsle} from './isleLight.js';
import {tuneIsle} from './isleTuning.js';
import {calmIsle} from './isleCalm.js';
import {SCHEME_CLASS, loadMenuSchemes} from './menuScheme.js';
import {LIGHT_EDGE, lightBlur, lightFill} from './light.js';
import {ALONG_EDGE, BL, BR, DOWN_SIDE, TL, TR, bounds, fitted, flipped, lerpShape, outline, sideMask} from './shape.js';
import {atBottom, setBarAtBottom} from './barPosition.js';
import {CapsuleClock} from './clock.js';
import {CapsuleWeather} from './capsuleWeather.js';

const ISLE_UUID = 'isle@zickrian.github.io';
const ISLE_SCHEMA = 'org.gnome.shell.extensions.isle';
/** Where window corners come from when Settings → Window radius is automatic. */
const RWC_UUID = 'rounded-window-corners@ztrahmet.github.io';
const RWC_SCHEMA = 'org.gnome.shell.extensions.rounded-window-corners-native';
/** libadwaita's window corner radius, without that extension. CSS px. */
const ADWAITA_WINDOW_RADIUS = 15;

/** Space above and below the capsule inside the bar, in CSS px (Isle's PILL_IN_BAR_GAP). */
const GAP = 3;
/** Extra room past the first and last item on each side, in CSS px. */
const SIDE_PAD = 4;
/** Isle's hairline round a pill when its theme has no edge of its own (island.js PILL_EDGE). */
const PILL_EDGE = {color: [1, 1, 1], top: 0.16, bottom: 0.06};
/** How deep the glass's inner glow reaches, in CSS px (island.js GLASS_GLOW_REACH). */
const GLOW_REACH = 4;
/** The notch (Settings → Shape), as Isle's in the bar: flat on top, joined to the top of the screen, its bottom
 * corners round and shoulders flaring from its sides into the bar (controller.js IN_BAR_RADIUS, IN_BAR_SHOULDER);
 * open, as Isle's open island's (EXPANDED_SHOULDER). CSS px. */
const NOTCH_RADIUS = 10;
const NOTCH_SHOULDER = 7;
const NOTCH_OPEN_SHOULDER = 22;
/** Used when Isle can't be found: a dark pill, no blur. */
const FALLBACK_FILL = [0, 0, 0, 0.55];

/** A menu opening: the glass grows from its button with a little overshoot; its content fades in once it is mostly there. */
const OPEN_MS = 440;
const CLOSE_MS = 300;
/** How long (ms) a menu followed by its glass (`Morph.retarget`) stays cut to it after its last change. */
const FOLLOW_SETTLE_MS = 160;
/** Opening on hover, as Isle's island does (its `open-on` and `hover-delay` settings): the pointer resting this long
 * on a button opens its menu, and its leaving both for this long closes it (Isle's COLLAPSE_DELAY_MS). */
const HOVER_DELAY_MS = 120;
const COLLAPSE_MS = 300;
const LEAVE_CHECK_MS = 60;
/** How near the glass the pointer still counts as on it, in CSS px. */
const LEAVE_SLACK = 6;
/** A click this soon after a menu opened on hover keeps it open (it is what the click meant) instead of closing it. */
const PIN_WINDOW_MS = 1500;
/** Room kept round the glass's path, for the overshoot, in CSS px. */
const PATH_MARGIN = 40;

/** The system's accent colour as RGB in 0..1 (GNOME's Appearance settings), or GNOME's blue. */
function accent() {
    try {
        const [color] = St.ThemeContext.get_for_stage(global.stage).get_accent_color();
        return [color.red / 255, color.green / 255, color.blue / 255];
    } catch {
        return [0.21, 0.52, 0.89];
    }
}

/** GNOME's own style now (Settings → Appearance): light unless it prefers dark. */
const gnomeLight = () => St.Settings.get().color_scheme !== St.SystemColorScheme.PREFER_DARK;

/** The light look made from a dark one (light.js), at Glass strength `tint`; black becomes a solid light grey. Dark
 * text and icons go on it (stylesheet.css, panel-island-light-*). */
function lightLook(look, tint = 0) {
    const blur = lightBlur(look.blur, tint);
    return {...look, fill: blur ? lightFill(tint) : [0.93, 0.93, 0.94, 1], edge: {...LIGHT_EDGE}, blur, light: true};
}

/** Whether Isle is installed and on now. */
const isleRunning = () => {
    const state = Main.extensionManager.lookup(ISLE_UUID)?.state;
    return state !== undefined && (state === ExtensionState.ACTIVE || state === ExtensionState.ENABLED);
};
const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
/** How far (CSS px) a capsule's items may wobble during a workspace switch and the capsule stay as it was. */
const SWITCH_SLACK = 2;

/** Until when (µs, monotonic) the left capsule follows its items every frame, no wobble held still: just after the
 * number of workspaces changed, while GNOME's workspace dots grow or shrink for it (often during a switch, as an empty
 * workspace left goes). A real change, then, not a wobble: followed smoothly, not in jumps after it. */
let followUntil = 0;
const followingRealChange = () => GLib.get_monotonic_time() < followUntil;

/** How many workspaces there were as the switch now sliding began (-1: none). A workspace added or taken away since
 * (GNOME takes an empty one away as it is left, its dots shrinking a pixel or two at a time, for longer than any fixed
 * window), and what changes width through the rest of that switch is real: no wobble held still at all. */
let switchCount = -1;
const countChangedThisSwitch = () => switchCount >= 0 && global.workspace_manager.n_workspaces !== switchCount;

/** How long that lasts after a change (ms): GNOME's dots animate for about a quarter of a second. */
const FOLLOW_MS = 700;
const animating = () => St.Settings.get().enable_animations;
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutBack = t => 1 + 2.1 * (t - 1) ** 3 + 1.1 * (t - 1) ** 2;
const easeOutCubic = t => 1 - (1 - t) ** 3;
const easeInOutCubic = t => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
/** Whether `outer` holds all of `inner`. */
const holds = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** The round corners of a body `w` × `h` at `ox`, `oy` that meet a side flush with the screen's edge (see shape.js):
 * each its square ({x, y, size}, `top` for a top corner) and which way its line fades: `across` [from x, to x] for a
 * left or right side, `down` [from y, to y] for the top or bottom (from where it is whole to where it is gone). */
function fadingCorners(ox, oy, w, h, corners, flush) {
    const zones = [];
    const [top, right, bottom, left] = flush;
    const add = (i, x, y, sideX, sideY) => {
        const r = corners[i];
        if (r <= 0 || !(sideX || sideY))
            return;
        const cx = x === 'left' ? ox : ox + w - r, cy = y === 'top' ? oy : oy + h - r;
        zones.push({
            x: cx, y: cy, size: r, top: y === 'top',
            across: sideX ? (x === 'left' ? [ox + r, ox] : [ox + w - r, ox + w]) : null,
            down: sideY ? (y === 'top' ? [oy + r, oy] : [oy + h - r, oy + h]) : null,
        });
    };
    add(TL, 'left', 'top', left, top);
    add(TR, 'right', 'top', right, top);
    add(BR, 'right', 'bottom', right, bottom);
    add(BL, 'left', 'bottom', left, bottom);
    return zones;
}

/** A small number in 0..1 for `i`, the same each time: where a drop sits does not jump as the glass is drawn again. */
const seeded = i => {
    const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
};

/** The weather on a capsule's glass, over the body `w` × `h` at `ox`, `oy` (the caller clips to its shape): drops of
 * rain, frost creeping in from the rim, a warm glare from the left, mist; a few stars on a clear night. Still, never
 * moving: drawn as the shape or the sky changes. */
function paintSky(cr, sky, ox, oy, w, h, s) {
    if (sky === 'rain' || sky === 'storm') {
        if (sky === 'storm') {
            cr.setSourceRGBA(0.45, 0.5, 0.85, 0.12);
            cr.rectangle(ox, oy, w, h);
            cr.fill();
        }
        const count = Math.max(4, Math.round(w / (14 * s)));
        for (let i = 0; i < count; i++) {
            const x = ox + w * (0.04 + 0.92 * seeded(i + 1));
            const y = oy + h * (0.12 + 0.7 * seeded(i + 31));
            const r = (1 + 0.8 * seeded(i + 61)) * s;
            const len = r * (1.6 + seeded(i + 91));
            // A drop: a little elongated, lit on its upper left.
            cr.setSourceRGBA(0.82, 0.9, 1, 0.42);
            cr.save();
            cr.translate(x, y);
            cr.scale(1, len / r);
            cr.arc(0, 0, r, 0, 2 * Math.PI);
            cr.restore();
            cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.55);
            cr.arc(x - r * 0.35, y - len * 0.35, r * 0.35, 0, 2 * Math.PI);
            cr.fill();
        }
    } else if (sky === 'snow' || sky === 'frost') {
        // Frost: white creeping in from the top and bottom edges, and a few crystals.
        for (const [from, to] of [[oy, oy + h * 0.45], [oy + h, oy + h * 0.55]]) {
            const gradient = new Cairo.LinearGradient(0, from, 0, to);
            gradient.addColorStopRGBA(0, 0.88, 0.94, 1, 0.32);
            gradient.addColorStopRGBA(1, 0.88, 0.94, 1, 0);
            cr.setSource(gradient);
            cr.rectangle(ox, Math.min(from, to), w, Math.abs(to - from));
            cr.fill();
        }
        const count = Math.max(3, Math.round(w / (22 * s)));
        cr.setSourceRGBA(1, 1, 1, sky === 'snow' ? 0.75 : 0.5);
        for (let i = 0; i < count; i++) {
            const x = ox + w * (0.05 + 0.9 * seeded(i + 7));
            const y = oy + h * (seeded(i + 17) < 0.5 ? 0.18 : 0.82) + (seeded(i + 27) - 0.5) * h * 0.12;
            cr.arc(x, y, (0.7 + 0.6 * seeded(i + 37)) * s, 0, 2 * Math.PI);
            cr.fill();
        }
    } else if (sky === 'sun') {
        // A warm glare from the left, as low sun through glass.
        const gradient = new Cairo.RadialGradient(ox, oy + h * 0.3, 0, ox, oy + h * 0.3, Math.max(w * 0.6, h));
        gradient.addColorStopRGBA(0, 1, 0.82, 0.48, 0.3);
        gradient.addColorStopRGBA(1, 1, 0.82, 0.48, 0);
        cr.setSource(gradient);
        cr.rectangle(ox, oy, w, h);
        cr.fill();
    } else if (sky === 'fog') {
        // Mist: the glass a little whiter, in soft bands.
        cr.setSourceRGBA(1, 1, 1, 0.1);
        cr.rectangle(ox, oy, w, h);
        cr.fill();
        for (let i = 0; i < 2; i++) {
            const y = oy + h * (0.3 + 0.4 * i);
            const gradient = new Cairo.LinearGradient(0, y - h * 0.2, 0, y + h * 0.2);
            gradient.addColorStopRGBA(0, 1, 1, 1, 0);
            gradient.addColorStopRGBA(0.5, 1, 1, 1, 0.12);
            gradient.addColorStopRGBA(1, 1, 1, 1, 0);
            cr.setSource(gradient);
            cr.rectangle(ox, y - h * 0.2, w, h * 0.4);
            cr.fill();
        }
    } else if (sky === 'night') {
        const count = Math.max(2, Math.round(w / (40 * s)));
        cr.setSourceRGBA(1, 1, 1, 0.45);
        for (let i = 0; i < count; i++) {
            cr.arc(ox + w * (0.08 + 0.84 * seeded(i + 3)), oy + h * (0.2 + 0.6 * seeded(i + 13)), 0.7 * s, 0, 2 * Math.PI);
            cr.fill();
        }
    }
}

/** Isle's glass (or black) and its fill over it, in any side shape (see shape.js); `place(shape, area)` draws it. */
class Glass {
    /** `Mask`: the per-corner cut (shape.js `sideMask`) put in place of Isle's own, or null to keep Isle's. */
    constructor(GlassBackdrop, Mask) {
        this.actor = new Clutter.Actor({reactive: false});
        this.backdrop = GlassBackdrop ? new GlassBackdrop() : null;
        this._mask = null;
        if (this.backdrop) {
            this.actor.add_child(this.backdrop);
            // Ours: it sets its own shape (left alone by the patch smoothing Isle's corners, isleCorners.js).
            this.backdrop._panelIslandOwn = true;
            // Kept in the overview, blurring the wallpaper there (Isle's own hides itself; see overview.js).
            keepInOverview(this.backdrop);
            if (Mask) {
                try {
                    const mask = new Mask();
                    this.backdrop.remove_effect(this.backdrop._mask);
                    this.backdrop._mask = mask;
                    this.backdrop.add_effect(mask);
                    this._mask = mask;
                } catch (e) {
                    console.warn(`[panel-island] Isle's glass kept its own cut: ${e}`);
                }
            }
        }
        this.fill = new St.DrawingArea({reactive: false});
        this.fill.connect('repaint', area => this._paint(area));
        this.actor.add_child(this.fill);
        this._look = {fill: FALLBACK_FILL, edge: PILL_EDGE, blur: null};
        this._shape = null;
        this._shapeKey = null;
        this._area = null;
    }

    /** The weather drawn on the glass ('rain', 'storm', 'snow', 'frost', 'fog', 'sun', 'night', 'cloud'), or none. */
    set sky(sky) {
        if ((sky ?? null) === (this._sky ?? null))
            return;
        this._sky = sky ?? null;
        this.fill.queue_repaint();
    }

    setLook(look) {
        this._look = look;
        this._shapeKey = null;
        this._area = null;
        this.fill.queue_repaint();
        if (!this.backdrop)
            return;
        this.backdrop.look = look.blur;
        // Isle's glass also copies the top bar into its blur, for its island. Under these shapes that is the very
        // items drawn on them: a blurred ghost of each icon right under it. Left out here: not only unseen but cut
        // from the bar (no source), so the bar redrawing (Isle's island animating as media plays, a clock ticking)
        // no longer has this glass blurred again each time for a copy nobody sees. Isle's glass code only places and
        // orders that copy, never reads its source; the copy is made anew as the glass turns on, so cut each time.
        const bar = this.backdrop._bar;
        if (bar) {
            bar.opacity = 0;
            try {
                bar.source = null;
            } catch (e) {
                console.warn(`[panel-island] The bar's copy left as it is: ${e}`);
            }
        }
    }

    _paint(area) {
        const cr = area.get_context();
        const shape = this._shape;
        if (shape) {
            const {ox, oy, width: w, height: h, corners, flares, cuts, flush, outerWidth, outerHeight} = shape;
            const {fill, edge: themeEdge} = this._look;
            cr.setSourceRGBA(fill[0], fill[1], fill[2], fill[3]);
            outline(cr, ox, oy, w, h, corners, flares, cuts);
            cr.fill();
            // The weather on the glass (Settings → Weather), cut to the shape.
            if (this._sky) {
                cr.save();
                outline(cr, ox, oy, w, h, corners, flares, cuts);
                cr.clip();
                paintSky(cr, this._sky, ox, oy, w, h, scale());
                cr.restore();
            }
            // A floating shape stands apart from what is behind it: a hairline round it on black too, as Isle's pill
            // (one hanging from the top of the screen, or standing on its bottom, has none, as Isle's notch).
            const edge = themeEdge ?? (flush[0] || flush[2] ? null : PILL_EDGE);
            if (edge) {
                const [r, g, b] = edge.color ?? [1, 1, 1];
                const gradient = new Cairo.LinearGradient(0, oy, 0, oy + h);
                gradient.addColorStopRGBA(0, r, g, b, edge.top ?? 0);
                gradient.addColorStopRGBA(1, r, g, b, edge.bottom ?? edge.top ?? 0);
                // No rim along the screen's edges.
                const x0 = flush[3] ? ox + 1 : 0, y0 = flush[0] ? oy + 1 : 0;
                const x1 = flush[1] ? ox + w - 1 : outerWidth, y1 = flush[2] ? oy + h - 1 : outerHeight;
                cr.rectangle(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
                cr.clip();
                // The outline itself, 2 px wide, cut to the shape: its inner pixel, the same along a straight edge, a
                // round corner and a concave one. (An outline moved in by half a pixel is no inset at a concave corner:
                // moving its centre slides the arc along itself there, and half the line fell outside the shape.)
                outline(cr, ox, oy, w, h, corners, flares, cuts);
                cr.clip();
                cr.setLineWidth(2);
                // A round corner meeting the screen's edge: its line fades out as it turns to run along that edge, to
                // none facing it (as the glass's rim, shape.js sideFade). On a circle the share facing a side grows as
                // the distance in from its centre, u: kept 1 - u², a gradient across the corner's square.
                const zones = fadingCorners(ox, oy, w, h, corners, flush);
                cr.save();
                cr.rectangle(0, 0, outerWidth, outerHeight);
                zones.forEach(z => cr.rectangle(z.x, z.y, z.size, z.size));
                cr.setFillRule(Cairo.FillRule.EVEN_ODD);
                cr.clip();
                cr.setFillRule(Cairo.FillRule.WINDING);
                cr.setSource(gradient);
                outline(cr, ox, oy, w, h, corners, flares, cuts);
                cr.stroke();
                cr.restore();
                for (const z of zones) {
                    const alpha = (z.top ? edge.top : edge.bottom ?? edge.top) ?? 0;
                    const fadeOf = ([from, to], across, colour) => {
                        const pattern = across ? new Cairo.LinearGradient(from, 0, to, 0)
                            : new Cairo.LinearGradient(0, from, 0, to);
                        for (let k = 0; k <= 8; k++) {
                            const u = k / 8;
                            pattern.addColorStopRGBA(u, ...colour, alpha * (1 - u * u));
                        }
                        return pattern;
                    };
                    cr.save();
                    cr.rectangle(z.x, z.y, z.size, z.size);
                    cr.clip();
                    if (z.across && z.down) {
                        // The screen's corner: faded both ways.
                        cr.pushGroup();
                        cr.setSource(fadeOf(z.across, true, [r, g, b]));
                        outline(cr, ox, oy, w, h, corners, flares, cuts);
                        cr.stroke();
                        cr.popGroupToSource();
                        const mask = new Cairo.LinearGradient(0, z.down[0], 0, z.down[1]);
                        for (let k = 0; k <= 8; k++)
                            mask.addColorStopRGBA(k / 8, 0, 0, 0, 1 - (k / 8) ** 2);
                        cr.mask(mask);
                    } else {
                        cr.setSource(fadeOf(z.across ?? z.down, Boolean(z.across), [r, g, b]));
                        outline(cr, ox, oy, w, h, corners, flares, cuts);
                        cr.stroke();
                    }
                    cr.restore();
                }
            }
        }
        cr.$dispose();
    }

    /** Draws `shape` (see shape.js; stage px). The blur covers `area` (default: all the shape covers); while the area
     * stays the same, only the shape cut from it changes and nothing is blurred again. */
    place(shape, area = null) {
        const s = scale();
        shape = fitted(shape);
        const outer = bounds(shape);
        const x = Math.round(outer.x), y = Math.round(outer.y);
        const outerWidth = Math.max(1, Math.round(outer.width)), outerHeight = Math.max(1, Math.round(outer.height));
        const key = [x, y, outerWidth, outerHeight, shape.x, shape.y, shape.width, shape.height, ...shape.corners,
            ...shape.cuts, ...shape.flares, ...shape.flush].map(v => v.toFixed(1)).join();
        if (key !== this._shapeKey) {
            this._shapeKey = key;
            this._shape = {ox: shape.x - x, oy: shape.y - y, width: shape.width, height: shape.height,
                corners: shape.corners, flares: shape.flares, cuts: shape.cuts, flush: shape.flush, outerWidth, outerHeight};
            this.fill.set_position(x, y);
            this.fill.set_size(outerWidth, outerHeight);
            this.fill.queue_repaint();
        }
        if (!this.backdrop || !this._look.blur)
            return;
        area ??= outer;
        const a = {x: Math.round(area.x), y: Math.round(area.y), width: Math.round(area.width), height: Math.round(area.height)};
        if (!this._area || ['x', 'y', 'width', 'height'].some(k => this._area[k] !== a[k])) {
            this._area = a;
            this.backdrop.set_position(a.x, a.y);
        }
        const c = shape.corners;
        // Isle's own cut, if kept, as near as it comes: one radius below, one above, shoulders along the top.
        const shoulder = shape.flares[TL] === ALONG_EDGE && shape.flares[TR] === ALONG_EDGE
            ? Math.max(0, -Math.min(c[TL], c[TR])) : 0;
        this.backdrop.place({
            stageX: a.x, stageY: a.y, width: a.width, height: a.height,
            drop: shape.y - a.y, bottom: shape.height, left: shape.x - a.x, right: shape.x - a.x + shape.width,
            radius: this._mask ? 0 : Math.max(0, Math.min(c[BR], c[BL])),
            crown: this._mask ? 0 : Math.max(0, Math.min(c[TL], c[TR])),
            shoulder: this._mask ? 0 : shoulder, reach: GLOW_REACH * s, open: 0,
        });
        // A Live workspace switch's shared blur, if it shows one, kept lined up with where it now is (overview.js).
        followShared(this.backdrop);
        // The body alone, flares left out: what the windows under the glass are told by (overview.js).
        const body = {stageX: shape.x, stageY: shape.y, width: shape.width, height: shape.height};
        const old = this.backdrop._panelIslandBody;
        this.backdrop._panelIslandBody = body;
        if (!old || ['stageX', 'stageY', 'width', 'height'].some(k => Math.round(old[k]) !== Math.round(body[k]))) {
            this.backdrop._places = null;
            this.backdrop._queueSync?.();
        }
        this._mask?.setUniforms({corners: shape.corners, flares: shape.flares, cuts: shape.cuts, flush: shape.flush,
            evenRim: this._look.evenRim ? 1 : 0, wholeAlpha: this._look.solidEdge ? 1 : 0});
    }

    destroy() {
        if (this.backdrop)
            this.backdrop.look = null;
        this.actor.destroy();
    }
}

/** The capsule round one of the bar's boxes. */
class Capsule extends Glass {
    /** `shapeOf(extent)`: its shape round the items from `extent[0]` to `extent[1]` (stage x). */
    constructor(box, GlassBackdrop, Mask, shapeOf) {
        super(GlassBackdrop, Mask);
        this.box = box;
        this._shapeOf = shapeOf;
        this.rect = null;
        this._key = null;
        /** While its menu is open the capsule is that menu's glass (see `Morph`): its own is not drawn. */
        this._held = false;
        /** Settings → its side's capsule. Off, its side looks and opens as GNOME's. */
        this._enabled = true;
        // Drawn once and kept: the bar redrawn round it (Isle's island animating as media plays, 90 times a second)
        // paints the kept picture, not its blur, cut and fill again each time. Anything in it changing (what is
        // blurred, its shape, its look) makes it anew. Our capsules only; a menu's glass moves, and is left as it is.
        try {
            this.actor.offscreen_redirect = Clutter.OffscreenRedirect.ALWAYS;
        } catch (e) {
            console.warn(`[panel-island] Capsule drawn each time, not kept: ${e}`);
        }
        /** Settings → Attention glow: its edge lit, on a layer of its own above it (added beside it, not in it, so
         * its pulse fades that layer alone and the kept picture of the glass is not made anew each frame). */
        this.glow = new St.DrawingArea({reactive: false, visible: false});
        this.glow.connect('repaint', area => this._paintGlow(area));
        /** {rgb, width (CSS px), pulse}, or null; and its breathing. */
        this._glow = null;
        this._pulse = null;
    }

    /** Lights its edge (`glow`: {rgb, width, pulse}), or with null puts it out. */
    setAttention(glow) {
        this._glow = glow;
        this._stopPulse();
        this.glow.opacity = 255;
        this._syncGlow();
        this.glow.queue_repaint();
        // A slow breath, unless animations are off. A timeline of its own, not `ease`: an endless ease would keep
        // fullscreen windows from being shown directly (it holds the compositor's unredirect off while it runs). Tied
        // to the glow, it stands still while the glow is not on screen.
        if (glow?.pulse && animating()) {
            const timeline = this._pulse = new Clutter.Timeline({actor: this.glow, duration: 1100, repeat_count: -1,
                auto_reverse: true, progress_mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
            timeline.connect('new-frame', () => (this.glow.opacity = Math.round(255 - 195 * timeline.get_progress())));
            timeline.start();
        }
    }

    _stopPulse() {
        if (!this._pulse)
            return;
        this._pulse.stop();
        this._pulse.run_dispose();
        this._pulse = null;
    }

    /** The glow over the capsule's glass, where it is, shown with it. */
    _syncGlow() {
        const on = Boolean(this._glow) && this.actor.visible && Boolean(this._shape);
        this.glow.visible = on;
        if (!on)
            return;
        this.glow.set_position(this.fill.x, this.fill.y);
        this.glow.set_size(this.fill.width, this.fill.height);
        const clip = this.actor.get_clip();
        if (this.actor.has_clip)
            this.glow.set_clip(clip[0] - this.fill.x, clip[1] - this.fill.y, clip[2], clip[3]);
    }

    /** The edge lit inside the outline, a crisp line and a soft glow within it, following every corner (not along
     * the screen's edges). */
    _paintGlow(area) {
        const cr = area.get_context();
        const shape = this._shape;
        if (shape && this._glow) {
            const {ox, oy, width: w, height: h, corners, flares, cuts, flush, outerWidth, outerHeight} = shape;
            const [r, g, b] = this._glow.rgb;
            // Stroked on the outline and cut to it: half of each line shows, inside.
            const line = 2 * Math.max(0.25, this._glow.width) * scale();
            const x0 = flush[3] ? ox + 1 : 0, y0 = flush[0] ? oy + 1 : 0;
            const x1 = flush[1] ? ox + w - 1 : outerWidth, y1 = flush[2] ? oy + h - 1 : outerHeight;
            cr.rectangle(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
            cr.clip();
            outline(cr, ox, oy, w, h, corners, flares, cuts);
            cr.clip();
            for (const [width, alpha] of [[line * 3, 0.16], [line * 1.8, 0.3], [line, 0.95]]) {
                cr.setSourceRGBA(r, g, b, alpha);
                cr.setLineWidth(width);
                outline(cr, ox, oy, w, h, corners, flares, cuts);
                cr.stroke();
            }
        }
        cr.$dispose();
    }

    destroy() {
        this._stopPulse();
        this.glow.destroy();
        super.destroy();
    }

    get enabled() {
        return this._enabled;
    }

    set enabled(enabled) {
        this._enabled = enabled;
        this.update();
    }

    setLook(look) {
        super.setLook(look);
        this._key = null;
    }

    set held(held) {
        this._held = held;
        this.update();
    }

    /** The stage x range the box's shown items cover, or null with none shown. */
    _extent() {
        let from = Infinity, to = -Infinity;
        for (const child of this.box.get_children()) {
            if (!child.visible || child.width <= 0 || child.height <= 0)
                continue;
            const [x] = child.get_transformed_position();
            const [width] = child.get_transformed_size();
            from = Math.min(from, x);
            to = Math.max(to, x + width);
        }
        return from < to ? [from, to] : null;
    }

    update() {
        let extent = this._extent();
        // During a workspace switch GNOME's workspace dots (the Activities button) grow and shrink with the slide, each
        // rounded to a whole pixel every frame: what they add up to wobbles by a pixel or two, and the items after them
        // with it. Held still through the switch, so the capsule does not dance (and, held still in Still mode, is not
        // blurred again for it); anything moving further, a real change, followed at once; exact again once it ends.
        const held = this._steadyExtent;
        if (extent && held && isSwitching() && !followingRealChange() && !countChangedThisSwitch()) {
            const slack = SWITCH_SLACK * scale();
            if (Math.abs(extent[0] - held[0]) <= slack && Math.abs(extent[1] - held[1]) <= slack)
                extent = held;
        }
        this._steadyExtent = extent;
        const panel = Main.panel;
        if (!extent || !panel.mapped || !this._enabled) {
            this.actor.hide();
            this._syncGlow();
            return;
        }
        this.rect = this._shapeOf(extent);
        this.actor.visible = !this._held;
        this._syncGlow();
        const key = JSON.stringify(this.rect);
        if (key !== this._key) {
            this._key = key;
            // Kept on the bar's monitor, as a menu's glass is: a top corner's flare runs past the screen's top.
            const monitor = Main.layoutManager.findMonitorForActor(panel) ?? Main.layoutManager.primaryMonitor;
            if (monitor)
                this.actor.set_clip(monitor.x, monitor.y, monitor.width, monitor.height);
            this.place(this.rect);
            this._syncGlow();
            this.glow.queue_repaint();
        }
    }
}

/** The glass a menu opens in: it grows from its button's place in the capsule to the menu, and back. */
class Morph extends Glass {
    constructor(GlassBackdrop, Mask) {
        super(GlassBackdrop, Mask);
        this.actor.hide();
        this.rect = null;
        this._from = this._to = null;
        this._timeline = null;
        this._pathArea = null;
        this._reveal = null;
        this._revealHad = null;
        /** The menu it is open for, cut to it as it follows that menu's changes (`retarget`); its timer. */
        this._follow = null;
        this._settle = 0;
    }

    get shown() {
        return this.actor.visible;
    }

    /** The blur's area: the whole path from `from` to `to` and some room round it, so it is blurred once per move. */
    _setPath(from, to) {
        const a = bounds(fitted(from)), b = bounds(fitted(to));
        const m = PATH_MARGIN * scale();
        const x = Math.max(0, Math.min(a.x, b.x) - m);
        // Hanging from the top of the screen, its top is the blur's top; standing on the bottom (Settings → Bar at
        // the bottom), its bottom is the blur's bottom.
        const top = from.flush[0] || to.flush[0];
        const floor = from.flush[2] || to.flush[2];
        const y = top ? Math.min(a.y, b.y) : Math.max(0, Math.min(a.y, b.y) - m);
        const right = Math.min(global.stage.width, Math.max(a.x + a.width, b.x + b.width) + m);
        const lowest = Math.max(a.y + a.height, b.y + b.height);
        const bottom = floor ? lowest : Math.min(global.stage.height, lowest + m);
        this._pathArea = {x, y, width: right - x, height: bottom - y};
    }

    _draw(rect) {
        const monitor = Main.layoutManager.findMonitorForActor(Main.panel) ?? Main.layoutManager.primaryMonitor;
        if (monitor) {
            // The body kept on the bar's monitor, reaching its edges if the menu does; a notch's shoulder past an
            // edge runs off it, cut by the clip (pulling the body in by a shoulder instead left the menu sticking
            // out of its glass on that side). The clip also keeps the overshoot off a monitor beside it. The
            // actor sits at the stage's origin, so the clip is in stage pixels.
            const x = Math.max(rect.x, monitor.x);
            const right = Math.min(rect.x + rect.width, monitor.x + monitor.width);
            rect = {...rect, x, width: Math.max(1, right - x)};
            this.actor.set_clip(monitor.x, monitor.y, monitor.width, monitor.height);
        }
        this.rect = rect;
        this.place(rect, this._pathArea);
        this._clipReveal(rect);
    }

    /** While the glass grows round it, what it opens round (`reveal`: a menu, Island Menu's panel) shown only where
     * the glass already is, as Isle's island shows its own: GNOME's menus come in at full size in a fraction of the
     * time the glass takes to grow, and were seen spread out ahead of their glass. In its own pixels, through any
     * slide or scale of its own; given back as it was once the glass has reached it. */
    _clipReveal(rect) {
        const actor = this._reveal;
        if (!actor)
            return;
        try {
            const [ax, ay] = actor.get_transformed_position();
            const [tw, th] = actor.get_transformed_size();
            const sx = actor.width > 0 ? tw / actor.width : 0, sy = actor.height > 0 ? th / actor.height : 0;
            if (!(sx > 0 && sy > 0))
                return;
            actor.set_clip((rect.x - ax) / sx, (rect.y - ay) / sy, rect.width / sx, rect.height / sy);
        } catch (e) {
            console.warn(`[panel-island] Menu shown whole as its glass grows: ${e}`);
            this._endReveal();
        }
    }

    _startReveal(actor) {
        this._endReveal();
        if (!(actor instanceof Clutter.Actor))
            return;
        this._reveal = actor;
        this._revealHad = actor.has_clip ? actor.get_clip() : null;
        actor.connectObject('destroy', () => {
            this._reveal = null;
            this._revealHad = null;
            if (this._follow === actor)
                this._endFollow();
        }, this);
    }

    _endReveal() {
        const actor = this._reveal;
        if (!actor)
            return;
        this._reveal = null;
        const had = this._revealHad;
        this._revealHad = null;
        try {
            actor.disconnectObject(this);
            if (had)
                actor.set_clip(...had);
            else
                actor.remove_clip();
        } catch {}
    }

    _stop() {
        if (this._timeline) {
            const timeline = this._timeline;
            this._timeline = null;
            timeline.stop();
            timeline.run_dispose();
        }
    }

    /** Moves from `from` to `to` over `ms` along `ease`; `fade` 'in' or 'out' brings its opacity with it. With
     * `target` (a function), where it goes is asked again every frame: a menu still being laid out or placed. */
    animate(from, to, {ms, ease, fade = null, onDone = null, target = null, reveal = null, follow = null}) {
        this._stop();
        this._endFollow();
        this._endReveal();
        this._follow = follow;
        this._from = from;
        this._to = to;
        this._target = target;
        this._setPath(from, to);
        this.actor.show();
        if (!animating() || ms <= 0) {
            this.actor.opacity = fade === 'out' ? 0 : 255;
            this._draw(to);
            onDone?.();
            return;
        }
        const opacityAt = t => fade === 'in' ? Math.min(1, t / 0.2) : fade === 'out' ? Math.min(1, (1 - t) / 0.35) : 1;
        this.actor.opacity = Math.round(255 * opacityAt(0));
        this._startReveal(reveal);
        this._draw(from);
        const timeline = this._timeline = new Clutter.Timeline({actor: this.actor, duration: ms});
        timeline.connect('new-frame', () => {
            const t = timeline.get_progress();
            this.actor.opacity = Math.round(255 * opacityAt(t));
            const now = this._target?.();
            if (now && now.width > 0 && now.height > 0) {
                this._to = now;
                // Blurred again only if it now goes past what was blurred.
                if (!holds(this._pathArea, now))
                    this._setPath(this._from, now);
            }
            this._draw(lerpShape(this._from, this._to, ease(t)));
        });
        timeline.connect('completed', () => {
            if (this._timeline !== timeline)
                return;
            this._timeline = null;
            // Freed once this frame is over (it is still emitting).
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                timeline.run_dispose();
                return GLib.SOURCE_REMOVE;
            });
            this.actor.opacity = fade === 'out' ? 0 : 255;
            const now = this._target?.();
            if (now && now.width > 0 && now.height > 0)
                this._to = now;
            this._setPath(this._to, this._to);
            this._endReveal();
            this._draw(this._to);
            onDone?.();
        });
        timeline.start();
    }

    /** The menu changed size while open (a submenu): follows it, at once or along the move under way. */
    retarget(to) {
        this._to = to;
        this._setPath(this._timeline ? this._from : to, to);
        if (this._timeline)
            return;
        // Measured as the last frame was laid out, so a frame behind what is growing (a Quick Settings submenu
        // opening): what it follows (`follow`) is cut to the glass meanwhile, its edge moving with the glass's, and
        // shown whole again once it has stopped changing.
        if (this._follow && this._reveal !== this._follow) {
            try {
                this._startReveal(this._follow);
            } catch {
                this._endFollow();
            }
        }
        this._draw(to);
        if (this._reveal) {
            if (this._settle)
                GLib.source_remove(this._settle);
            this._settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOLLOW_SETTLE_MS, () => {
                this._settle = 0;
                if (!this._timeline)
                    this._endReveal();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _endFollow() {
        if (this._settle)
            GLib.source_remove(this._settle);
        this._settle = 0;
        this._follow = null;
    }

    hide() {
        this._stop();
        this._endFollow();
        this._endReveal();
        this._target = null;
        this.actor.hide();
    }

    destroy() {
        this._stop();
        this._endFollow();
        this._endReveal();
        super.destroy();
    }
}

export default class PanelIslandExtension extends Extension {
    enable() {
        this._alive = true;
        this._load().catch(e => console.error(`[panel-island] ${e}\n${e.stack}`));
    }

    async _load() {
        let GlassBackdrop = null, shader = null;
        this._GlassBackdrop = null;
        this._theme = null;
        this._isleSettings = null;
        this._isleCalendar = null;
        /** Whether the glass is Isle's own (shared with it, and patched by Settings → Isle), else this extension's copy. */
        this._glassIsIsle = false;
        const isle = Main.extensionManager.lookup(ISLE_UUID);
        if (isle) {
            try {
                const src = isle.dir.get_child('src');
                ({GlassBackdrop} = await import(src.get_child('glass.js').get_uri()));
                this._theme = await import(src.get_child('theme.js').get_uri());
                this._glassIsIsle = true;
                // Isle's Calendar page and the helpers the weather on it uses (Settings → Weather on Isle's Calendar).
                try {
                    const uri = path => src.get_child(path).get_uri();
                    const [{CalendarPage}, {label}, {VERTICAL}, Format] = await Promise.all(
                        ['pages/calendar.js', 'widgets.js', 'compat.js', 'format.js'].map(path => import(uri(path))));
                    this._isleCalendar = {CalendarPage, helpers: {label, VERTICAL, Format}};
                    // Isle's music bars and lyrics, for Settings → Lighter blur updates (isleTuning.js).
                    try {
                        const [{Bars}, {LyricsPane}] = await Promise.all(
                            ['widgets.js', 'pages/lyrics.js'].map(path => import(uri(path))));
                        this._isleTunable = {Bars, LyricsPane};
                    } catch (e) {
                        console.warn(`[panel-island] Isle's bars and lyrics not reached, left as Isle has them: ${e}`);
                        this._isleTunable = null;
                    }
                    // Isle's island, for Settings → Light Isle (isleLight.js).
                    try {
                        this._isleIslandClass = (await import(uri('island.js'))).Island ?? null;
                        this._isleStylesheet = isle.dir.get_child('stylesheet.css');
                    } catch (e) {
                        console.warn(`[panel-island] Isle's island not reached, it stays dark: ${e}`);
                        this._isleIslandClass = null;
                    }
                    // Isle's springs, for Settings → Isle without bounce (isleCalm.js).
                    try {
                        const {Spring, SpringDriver} = await import(uri('spring.js'));
                        this._isleSprings = {Spring, SpringDriver};
                    } catch (e) {
                        console.warn(`[panel-island] Isle's springs not reached, its island bounces as it does: ${e}`);
                        this._isleSprings = null;
                    }
                } catch (e) {
                    console.warn(`[panel-island] Isle's Calendar page not reached, no weather on it: ${e}`);
                    this._isleCalendar = null;
                }
                try {
                    shader = await import(src.get_child('shader.js').get_uri());
                } catch (e) {
                    console.warn(`[panel-island] Per-corner glass not available, Isle's own cut used: ${e}`);
                }
                const schemas = Gio.SettingsSchemaSource.new_from_directory(isle.dir.get_child('schemas').get_path(),
                    Gio.SettingsSchemaSource.get_default(), false);
                this._isleSettings = new Gio.Settings({settings_schema: schemas.lookup(ISLE_SCHEMA, true)});
            } catch (e) {
                console.warn(`[panel-island] Isle's glass could not be loaded, using this extension's own: ${e}`);
                GlassBackdrop = shader = null;
                this._theme = this._isleSettings = this._isleCalendar = null;
                this._glassIsIsle = false;
            }
        }
        // Without Isle: the same glass, from this extension's own copy of Isle's (glass/).
        if (!GlassBackdrop) {
            try {
                ({GlassBackdrop} = await import('./glass/glass.js'));
                this._theme = await import('./glass/theme.js');
                shader = await import('./glass/shader.js');
            } catch (e) {
                console.warn(`[panel-island] The glass could not be loaded, using a plain pill: ${e}`);
                GlassBackdrop = shader = null;
                this._theme = null;
            }
        }
        let Mask = null;
        if (shader) {
            try {
                Mask = sideMask(shader.shaderEffect, shader.effectPoint);
            } catch (e) {
                console.warn(`[panel-island] Per-corner glass not available: ${e}`);
            }
        }
        if (!this._alive)
            return;
        this._GlassBackdrop = GlassBackdrop;
        this._Mask = Mask;

        this._dead = false;
        this._settings = this.getSettings();
        migrate(this._settings);
        this._container = new Clutter.Actor({reactive: false});
        Main.layoutManager.uiGroup.insert_child_below(this._container, Main.layoutManager.panelBox);
        this._boxes = [Main.panel._leftBox, Main.panel._rightBox, Main.panel._centerBox];
        // Logging out, the shell destroys the bar and all with it without disabling extensions first: nothing
        // queued may run on what is gone then.
        this._container.connect('destroy', () => this._died());
        for (const box of this._boxes)
            box.connectObject('destroy', () => this._died(), this);
        this._capsules = this._boxes.map(box => new Capsule(box, GlassBackdrop, Mask,
            extent => this._capsuleShape(box, extent)));
        this._capsules.forEach(capsule => this._container.add_child(capsule.actor));
        // Each capsule's attention glow above all of them (see `Capsule.setAttention`).
        this._capsules.forEach(capsule => this._container.add_child(capsule.glow));
        // Above the capsules: a menu's glass leaves its button over them.
        this._morph = new Morph(GlassBackdrop, Mask);
        this._container.add_child(this._morph.actor);
        // Island Menu's workspace peek: a glass of its own, growing out of the left capsule (workspaceGlass.js).
        this._peekGlass = new Morph(GlassBackdrop, Mask);
        this._container.add_child(this._peekGlass.actor);
        const left = () => this._capsules?.[0];
        this._workspaces = new WorkspaceGlass({
            glass: this._peekGlass,
            restRect: () => left()?.enabled && left().rect ? left().rect : null,
            openShape: rect => {
                const c = left().rect;
                return this._shape(Main.panel._leftBox, Math.min(rect.x, c.x),
                    Math.max(rect.x + rect.width, c.x + c.width), rect);
            },
            hold: on => {
                if (on) {
                    this._endClosing(this._peekGlass);
                    this._hold(left());
                } else if (this._leftFree(this._peekGlass)) {
                    this._hold(null);
                }
            },
            busy: () => Boolean(this._active) || this._morph.shown || Boolean(this._island?.shown),
            opening: () => ({ms: this._ms(OPEN_MS),
                ease: this._settings.get_boolean('bounce') ? easeOutBack : easeOutCubic}),
            closing: () => ({ms: this._ms(CLOSE_MS), ease: easeInOutCubic}),
            closeDelay: () => this._settings.get_int('close-delay'),
            // Its edge lit in the accent colour (`Capsule.setAttention`).
            setAttention: glow => left()?.setAttention(glow ? {...glow, rgb: accent()} : null),
            strength: () => this._tint(),
            // Light or dark as Island Menu asks (its own Style), the left capsule's text with it; null: as ours.
            setLight: light => {
                this._peekLight = light ?? null;
                const looks = this._lookSet;
                if (looks)
                    this._peekGlass.setLook((this._peekLight ?? this._capsulesLight()) ? looks.light : looks.dark);
                this._leftLight = this._peekLight;
                this._applyTextStyle();
            },
        });
        // Glass for another extension's panel, grown out of the left capsule, or the middle one (Settings → Island Menu
        // opens from) while it is shown (island.js: Island Menu's launcher).
        this._islandGlass = new Morph(GlassBackdrop, Mask);
        this._container.add_child(this._islandGlass.actor);
        this._island = new IslandService({
            glass: this._islandGlass,
            capsule: () => this._islandCapsule(),
            leftRect: () => left()?.enabled && left().rect ? left().rect : null,
            restRect: () => {
                const c = this._islandCapsule();
                return c?.enabled && c.rect ? c.rect : null;
            },
            openShape: rect => {
                const capsule = this._islandCapsule();
                const c = capsule.rect;
                return this._shape(capsule.box, Math.min(rect.x, c.x), Math.max(rect.x + rect.width, c.x + c.width), rect);
            },
            hold: on => {
                const capsule = this._islandCapsule();
                if (on) {
                    this._endClosing(this._islandGlass);
                    this._hold(capsule);
                } else if (capsule === left() ? this._leftFree(this._islandGlass)
                    : this._heldCapsule === capsule && !this._active) {
                    this._hold(null);
                }
            },
            opening: () => ({ms: this._ms(OPEN_MS),
                ease: this._settings.get_boolean('bounce') ? easeOutBack : easeOutCubic}),
            closing: () => ({ms: this._ms(CLOSE_MS), ease: easeInOutCubic}),
            closePeek: () => this._workspaces?.close(true, 'an island panel opened'),
            // Light or dark as the panel on it asks (its text drawn for one or the other), else as the capsules are.
            isLight: () => this._capsulesLight(),
            // The capsule's text and icons with it, so they read on that glass (`_applyTextStyle`); null: as the
            // capsules are again (it closed).
            setLight: light => {
                const looks = this._lookSet;
                if (looks)
                    this._islandGlass.setLook(light ?? this._capsulesLight() ? looks.light : looks.dark);
                this._islandLight = light ?? null;
                this._islandSide = Math.max(0, this._capsules?.indexOf(this._islandCapsule()) ?? 0);
                this._applyTextStyle();
            },
        });
        this._island.api.workspaces = this._workspaces.api;

        this._leftLight = null;
        this._peekLight = null;
        this._islandLight = null;
        this._islandSide = 0;
        /** The capsule an island panel opened from, kept until it has closed (`_islandCapsule`). */
        this._islandFrom = null;
        this._watched = new Set();
        this._menus = new Map();
        this._cleared = new Set();
        this._restores = new Map();
        // Menus drawn light or dark as the capsules are, whatever GNOME's own style (menuScheme.js).
        try {
            this._menuSchemes = loadMenuSchemes();
        } catch (e) {
            console.warn(`[panel-island] Menus keep GNOME's own style: ${e}`);
            this._menuSchemes = null;
        }
        this._active = null;
        this._heldCapsule = null;
        this._hoverMode = false;
        this._hoverOpenedAt = 0;
        this._hoverTimer = 0;
        this._leaveTimer = 0;
        this._later = 0;
        this._menuLater = 0;
        const queue = () => this._queue();
        for (const box of this._boxes)
            box.connectObject('child-added', () => this._watchChildren(), 'child-removed', () => this._watchChildren(), this);
        this._watchChildren();
        Main.panel.connectObject('notify::allocation', queue, 'notify::mapped', queue, this);
        Main.layoutManager.panelBox.connectObject('notify::allocation', queue, 'notify::translation-y', queue,
            'notify::visible', queue, 'notify::opacity', queue, this);
        Main.layoutManager.connectObject('monitors-changed', queue, this);
        // A workspace added or taken away (GNOME's dynamic workspaces, often with no switch at all): the left capsule's
        // items (GNOME's workspace dots, Island Menu's numbers) change width, the dots over a short animation. Measured
        // again at once and as that animation settles, so the capsule never keeps its old size.
        global.workspace_manager.connectObject('notify::n-workspaces', () => this._remeasureSoon(), this);
        this._watchDots();
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', queue, this);
        // GNOME's style switched (Settings → Appearance): the glass with it, where it follows it.
        St.Settings.get().connectObject('notify::color-scheme', () => this._applyTheme(), this);
        this._isleSettings?.connectObject('changed::top-bar-color', () => this._applyBar(),
            'changed::top-bar-opacity', () => this._applyBar(),
            'changed::top-bar-style', () => this._applyBar(),
            'changed::island-theme', () => this._applyTheme(),
            'changed::glass-tint', () => this._applyTheme(),
            'changed::island-shape', () => this._applyShape(), this);
        this._settings.connectObject('changed::left-capsule', () => this._applySides(),
            'changed::right-capsule', () => this._applySides(),
            'changed::centre-capsule', () => this._applySides(),
            'changed::top-bar', () => this._applyBar(),
            'changed::keep-activities', () => this._applyActivities(),
            'changed::bar-at-bottom', () => this._applyBarPosition(),
            'changed::top-bar-opacity', () => this._applyBar(),
            'changed::flat-buttons', () => this._applyFlat(),
            'changed::theme', () => this._applyTheme(),
            'changed::tint-like-isle', () => this._applyTheme(),
            'changed::glass-tint', () => this._applyTheme(),
            'changed::edge-light', () => this._applyTheme(),
            'changed::color-style', () => this._applyTheme(),
            'changed::edge-blur', () => this._applyTheme(),
            'changed::shape', () => this._applyShape(),
            'changed::reach-edges', () => this._applyShape(),
            'changed::edge-radius', () => this._applyShape(),
            'changed::match-windows', () => this._applyShape(),
            'changed::window-radius-auto', () => this._applyShape(),
            'changed::window-radius', () => this._applyShape(),
            'changed::top-same-as-bottom', () => this._applyShape(),
            'changed::top-edge-radius', () => this._applyShape(),
            'changed::top-match-windows', () => this._applyShape(),
            'changed::top-window-radius-auto', () => this._applyShape(),
            'changed::top-window-radius', () => this._applyShape(),
            'changed::patch-isle-overview', () => this._applyIslePatch(),
            'changed::patch-isle-corners', () => this._applyIslePatch(),
            'changed::isle-weather', () => this._applyIslePatch(),
            'changed::isle-edge-blur', () => this._applyIslePatch(),
            'changed::patch-isle-lighter', () => this._applyIslePatch(),
            'changed::patch-isle-calm', () => this._applyIslePatch(),
            'changed::patch-isle-light', () => this._applyIslePatch(),
            'changed::switch-glass', () => setSwitchGlass(this._settings.get_string('switch-glass')), this);
        setSwitchGlass(this._settings.get_string('switch-glass'));
        // A switch starting or ending: the capsules looked at again (exact once it is over, see `Capsule.update`).
        this._unwatchSwitch = onSwitch(() => {
            this._steadyActivities(isSwitching());
            this._queue();
        });
        // Isle turned on or off: the middle capsule gives the clock to Isle's island, or takes it back.
        Main.extensionManager.connectObject('extension-state-changed', (_manager, extension) => {
            if (extension?.uuid === ISLE_UUID) {
                this._applySides();
                this._applyBar();
            }
        }, this);
        this._applyIslePatch();
        this._watchWindowRadius();
        this._applyTheme();
        this._applySides();
        this._applyFlat();
        keepBar(true);
        this._applyBar();
        this._applyActivities();
        this._applyBarPosition();
        // Settings → Clock (clock.js): GNOME's clock drawn anew in a capsule.
        try {
            this._clock = new CapsuleClock(this._settings, () => this._queue());
        } catch (e) {
            console.warn(`[panel-island] The capsule clock could not start, GNOME's clock left as it is: ${e}`);
            this._clock = null;
        }
        // Settings → Weather (capsuleWeather.js): the weather in a capsule, its sky on that capsule's glass.
        try {
            this._weather = new CapsuleWeather(this._settings, {
                onSky: (place, sky) => {
                    const capsule = this._capsules?.[place === 'centre' ? 2 : 0];
                    if (capsule)
                        capsule.sky = sky;
                },
                onMoved: () => this._queue(),
            });
        } catch (e) {
            console.warn(`[panel-island] The capsule weather could not start: ${e}`);
            this._weather = null;
        }
        // Island Menu's workspace features told the capsule's glass is there (workspaceGlass.js).
        this._workspaces.announce();
        // Logging in, the shell is still setting itself up as extensions start: the bar coloured again once it is done.
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._applyBar(), this);
    }

    /** Settings → Bar at the bottom (barPosition.js): the bar moved, then every shape made again for where it is,
     * an open menu's glass with it; the middle capsule round the clock Isle gives back off the top. */
    _applyBarPosition() {
        if (this._dead)
            return;
        const wanted = this._settings.get_boolean('bar-at-bottom');
        if (wanted === atBottom())
            return;
        this._active?.close?.();
        setBarAtBottom(wanted);
        this._applySides();
        this._applyBar();
        // Drawn anew once the bar is laid out where it now is (its allocation queues that, see `_load`), not now from
        // where it was.
        this._capsules.forEach(capsule => (capsule._key = null));
    }

    /** Settings → Keep GNOME's Activities button (activities.js). */
    _applyActivities() {
        if (this._dead)
            return;
        keepActivities(this._settings.get_boolean('keep-activities'));
    }

    /** Settings → Top bar, while Isle is off (Isle on colours it itself): as Isle's Settings colour it, as set here,
     * or as the theme has it. Isle colours it only at the top: with the bar at the bottom it hands it back to the
     * theme (an opaque bar, over the capsules' glass), so it is coloured here then too. */
    _applyBar() {
        if (this._dead)
            return;
        setBar(isleRunning() && !atBottom() ? null : this._barOpacity());
    }

    /** The bar's opacity in % as Settings → Top bar says, or null for the theme's own colour. */
    _barOpacity() {
        const mode = this._settings.get_string('top-bar');
        if (mode === 'theme')
            return null;
        const isle = this._isleSettings;
        if (mode === 'isle' && isle) {
            if (!isle.get_boolean('top-bar-color'))
                return null;
            if (isle.get_user_value('top-bar-opacity'))
                return isle.get_int('top-bar-opacity');
            return isle.get_string('top-bar-style') === 'black' ? 100 : 0;
        }
        return this._settings.get_int('top-bar-opacity');
    }

    /** Settings → each side's capsule. A side turned off while its menu is open: that menu goes back to GNOME's. */
    _applySides() {
        if (this._dead)
            return;
        const on = [this._settings.get_boolean('left-capsule'), this._settings.get_boolean('right-capsule'),
            this._centreOn()];
        this._capsules.forEach((capsule, i) => (capsule.enabled = on[i]));
        this._applyFlat();
        this._applyTextStyle();
        const active = this._active;
        if (active && !this._sideOn(this._menus.get(active))) {
            this._active = null;
            this._morph.hide();
            this._hold(null);
            this._restore(active);
        }
    }

    /** Settings → Middle capsule: round the clock always, never, or (automatic) only while Isle's island is not
     * there to hold it. */
    _centreOn() {
        const mode = this._settings.get_string('centre-capsule');
        if (mode === 'on' || mode === 'off')
            return mode === 'on';
        // Isle gives the clock back to the bar once the bar leaves the top.
        return !isleRunning() || atBottom();
    }

    /** Dark text and icons on light capsules: each side's while its capsule is on and light (stylesheet.css). */
    _applyTextStyle() {
        if (this._dead)
            return;
        const capsules = this._capsulesLight();
        ['left', 'right', 'centre'].forEach((side, i) => {
            const name = `panel-island-light-${side}`;
            // A capsule as light or dark as a panel grown out of it asks (island.js, the workspace peek), while open.
            const light = this._islandLight !== null && i === this._islandSide ? this._islandLight
                : i === 0 && this._leftLight !== null ? this._leftLight : capsules;
            light && this._capsules?.[i]?.enabled ? Main.panel.add_style_class_name(name) : Main.panel.remove_style_class_name(name);
        });
    }

    /** Settings → flat buttons: GNOME's hover and pressed shading off on the buttons in capsules (see stylesheet.css). */
    _applyFlat() {
        if (this._dead)
            return;
        const flat = this._settings.get_boolean('flat-buttons');
        const set = (name, on) => on ? Main.panel.add_style_class_name(name) : Main.panel.remove_style_class_name(name);
        // Each side only while its capsule is on: one turned off looks and opens as GNOME's.
        ['left', 'right', 'centre'].forEach((side, i) =>
            set(`panel-island-flat-${side}`, flat && Boolean(this._capsules?.[i]?.enabled)));
    }

    /** The capsule an island panel (Island Menu's launcher) grows out of: the middle one if Settings say so and it is
     * shown, else the left one. Kept while a panel is open or still shrinking back, so one never moves between two. */
    _islandCapsule() {
        const left = this._capsules?.[0] ?? null;
        if (this._islandFrom && (this._island?.shown || this._islandGlass?.shown))
            return this._islandFrom;
        const centre = this._capsules?.[2];
        const wanted = this._settings?.get_string('island-panel-from') === 'centre' && centre?.enabled && centre.rect
            ? centre : left;
        this._islandFrom = wanted;
        return wanted;
    }

    /** Whether `button`'s side has its capsule on. */
    _sideOn(button) {
        return button ? this._capsuleOf(button)?.enabled ?? false : false;
    }

    /** Settings → animation speed: `ms` at the speed set. */
    _ms(ms) {
        return Math.round(ms / Math.max(0.5, this._settings.get_double('animation-speed')));
    }

    /** The shell is taking the bar down (logging out): every timer and queued update stops. */
    _died() {
        if (this._dead)
            return;
        this._dead = true;
        const laters = global.compositor?.get_laters();
        if (this._later)
            laters?.remove(this._later);
        if (this._menuLater)
            laters?.remove(this._menuLater);
        this._later = this._menuLater = 0;
        this._cancelHoverOpen();
        this._stopLeaveWatch();
        this._restores.forEach(id => GLib.source_remove(id));
        this._restores.clear();
        this._active = null;
        try {
            this._island?.close(true);
            this._workspaces?.destroy();
        } catch (e) {
            console.warn(`[panel-island] The left capsule's panels not stopped cleanly: ${e}`);
        }
    }

    /** Follows every item in both boxes: one that resizes, shows or hides moves the capsule's ends. */
    _watchChildren() {
        if (this._dead)
            return;
        this._watched.forEach(child => child.disconnectObject(this));
        this._watched.clear();
        for (const box of this._boxes) {
            for (const child of box.get_children()) {
                this._watched.add(child);
                // A size told during GNOME's layout step: measured right after it (`_measureSoon`), not "before the next
                // redraw", which GNOME, already drawing this frame, does not ask for, so it waited for anything else
                // to redraw the screen (the capsule a moment or more behind what it holds).
                child.connectObject('notify::allocation', () => this._measureSoon(), 'notify::visible', () => this._queue(),
                    'destroy', () => this._watched.delete(child), this);
            }
        }
        this._watchMenus();
        this._workspaces?.watchTriggers();
        this._queue();
    }

    /** GNOME's workspace dots (the Activities button's row of them): a dot taken away shrinks to nothing first and only
     * then leaves the row, half a second after the workspace went, the row a dot narrower in that frame. Nothing else
     * says so in time (the capsule stayed a dot too wide until it was measured again), so a dot coming or going is
     * measured right after that frame's layout. */
    _watchDots() {
        this._dotRow?.disconnectObject(this);
        this._dotRow = null;
        const find = actor => {
            for (const child of actor?.get_children?.() ?? []) {
                if (child.get_children().some(dot => dot.constructor?.name === 'WorkspaceDot'))
                    return child;
                const found = find(child);
                if (found)
                    return found;
            }
            return null;
        };
        const row = find(Main.panel.statusArea?.activities);
        if (!row)
            return;
        this._dotRow = row;
        const measure = () => this._measureSoon();
        row.connectObject('child-added', measure, 'child-removed', measure, 'destroy', () => (this._dotRow = null), this);
    }

    /** Every menu of a button in the left or right box. */
    _watchMenus() {
        for (const button of Object.values(Main.panel.statusArea)) {
            const menu = button?.menu;
            if (!menu?.actor || !menu.box || !button.container || this._menus.has(menu))
                continue;
            if (!this._boxes.includes(button.container.get_parent()))
                continue;
            this._menus.set(menu, button);
            // `hover` is kept by St for the button and everything in it (panel buttons track it).
            button.connectObject('notify::hover', () => this._hovered(button),
                'event', (_actor, event) => this._buttonEvent(button, event), this);
            menu.connectObject('open-state-changed', (_menu, open) => open ? this._opened(menu, button) : this._closed(menu, button),
                'destroy', () => this._forget(menu), this);
        }
    }

    _forget(menu) {
        this._menus.get(menu)?.disconnectObject?.(this);
        menu.disconnectObject?.(this);
        menu.box?.disconnectObject?.(this);
        menu.actor?.disconnectObject?.(this);
        this._menus.delete(menu);
        this._cleared.delete(menu);
        const id = this._restores.get(menu);
        if (id)
            GLib.source_remove(id);
        this._restores.delete(menu);
        if (this._active === menu) {
            this._active = null;
            this._morph.hide();
            this._hold(null);
        }
    }

    /** The capsule `button` sits in. */
    _capsuleOf(button) {
        return this._capsules.find(c => c.box === button.container.get_parent()) ?? null;
    }

    /** Where `button` lies in its capsule: a start for the glass with no capsule drawn. */
    _buttonRect(button) {
        const [x] = button.container.get_transformed_position();
        const [width] = button.container.get_transformed_size();
        return this._shape(button.container.get_parent(), x, x + width);
    }

    /** The capsule's shape now, or its button's place without one. */
    _restRect(button) {
        return this._capsuleOf(button)?.rect ?? this._buttonRect(button);
    }

    /** All the menu draws: its rounded body and whatever in it reaches further (two levels down: the quick settings'
     * grid and its toggles), where each is on the screen now. */
    _menuRect(menu) {
        const box = menu.box;
        let [x1, y1] = box.get_transformed_position();
        const [w, h] = box.get_transformed_size();
        let x2 = x1 + w, y2 = y1 + h;
        const take = (actor, depth) => {
            for (const child of actor.get_children()) {
                if (!child.visible || child.opacity === 0 || child.width <= 0 || child.height <= 0)
                    continue;
                const [cx, cy] = child.get_transformed_position();
                const [cw, ch] = child.get_transformed_size();
                // A child not laid out (or laid out wrong) has no place: it would make the whole glass none.
                if (![cx, cy, cw, ch].every(Number.isFinite))
                    continue;
                x1 = Math.min(x1, cx);
                y1 = Math.min(y1, cy);
                x2 = Math.max(x2, cx + cw);
                y2 = Math.max(y2, cy + ch);
                if (depth > 1)
                    take(child, depth - 1);
            }
        };
        take(box, 2);
        const radius = box.get_theme_node().get_border_radius(St.Corner.BOTTOMLEFT);
        return {x: x1, y: y1, width: x2 - x1, height: y2 - y1, radius};
    }

    /** Whether the side shapes are notches (Settings → Shape, or Isle's island's own), else pills. */
    _notch() {
        const mode = this._settings?.get_string('shape') ?? 'isle';
        const shape = mode === 'isle' ? this._isleSettings?.get_string('island-shape') ?? 'pill' : mode;
        return shape === 'notch';
    }

    /** The shape changed: the capsules drawn anew, an open menu's glass with them. */
    _applyShape() {
        if (this._dead)
            return;
        this._capsules.forEach(capsule => (capsule._key = null));
        this._update();
        const menu = this._active;
        if (menu && this._morph.shown)
            this._morph.retarget(this._openRect(menu, this._menus.get(menu)));
    }

    /** Settings → Window radius, automatic: Rounded Window Corners' own radius (its custom style's), followed as it
     * changes. */
    _watchWindowRadius() {
        this._rwcSettings = null;
        const rwc = Main.extensionManager.lookup(RWC_UUID);
        if (!rwc)
            return;
        try {
            const schemas = Gio.SettingsSchemaSource.new_from_directory(rwc.dir.get_child('schemas').get_path(),
                Gio.SettingsSchemaSource.get_default(), false);
            const schema = schemas.lookup(RWC_SCHEMA, true);
            if (!schema?.has_key('corner-radius'))
                return;
            this._rwcSettings = new Gio.Settings({settings_schema: schema});
            this._rwcSettings.connectObject('changed::corner-radius', () => this._applyShape(),
                'changed::custom-style', () => this._applyShape(), this);
        } catch (e) {
            console.warn(`[panel-island] Rounded Window Corners' radius could not be read: ${e}`);
            this._rwcSettings = null;
        }
    }

    /** The windows' corner radius, in CSS px, for the corner whose settings start with `prefix` ('' the bottom's,
     * 'top-' the top's): Settings', or Rounded Window Corners' (with its custom style on), else libadwaita's. */
    _windowRadius(prefix = '') {
        if (!this._settings.get_boolean(`${prefix}window-radius-auto`))
            return this._settings.get_int(`${prefix}window-radius`);
        const rwc = this._rwcSettings;
        if (rwc && (!rwc.settings_schema.has_key('custom-style') || rwc.get_boolean('custom-style')))
            return rwc.get_int('corner-radius');
        return ADWAITA_WINDOW_RADIUS;
    }

    /** Settings for the corner at the screen's edge, `top` or the bottom: {radius (CSS px), match, windowRadius}.
     * The top's are the bottom's while Settings → Same for the top corner is on. */
    _edgeCorner(top) {
        const prefix = top && !this._settings.get_boolean('top-same-as-bottom') ? 'top-' : '';
        return {
            radius: this._settings.get_int(`${prefix}edge-radius`),
            match: this._settings.get_boolean(`${prefix}match-windows`),
            windowRadius: this._windowRadius(prefix),
        };
    }

    /** Settings → Keep Isle's glass in the overview: Isle's own glass class wrapped as it runs (overview.js), never
     * its files; put on only if Isle still has what it changes, taken off as this goes or the setting does. */
    _applyIslePatch() {
        // Settings → Keep Isle's glass in the overview, Lighter blur updates: one wrap on Isle's class for both, each
        // part on as its setting says (overview.js), the wrap itself on while either is.
        const overview = Boolean(this._settings?.get_boolean('patch-isle-overview'));
        const lighter = Boolean(this._settings?.get_boolean('patch-isle-lighter'));
        if (!this._dead)
            setIsleBehaviour({overview, lighter});
        const want = !this._dead && (overview || lighter) && this._glassIsIsle && this._GlassBackdrop;
        if (want && !this._unpatchIsle) {
            this._unpatchIsle = keepInOverview(this._GlassBackdrop.prototype);
            if (!this._unpatchIsle)
                console.warn("[panel-island] Isle's glass has changed: it is left as it is in the overview");
        } else if (!want && this._unpatchIsle) {
            this._unpatchIsle();
            this._unpatchIsle = null;
        }
        // Settings → Isle's edge blur: with Isle's glass cut by ours, as Isle thins it at the screen's edge, or solid.
        setIsleSolidEdge(this._settings?.get_string('isle-edge-blur') === 'solid');
        // Settings → Smooth Isle's notch corners: Isle's glass cut with ours, its whole outline taken (isleCorners.js).
        const corners = !this._dead && this._settings?.get_boolean('patch-isle-corners') && this._glassIsIsle &&
            this._GlassBackdrop &&
            this._Mask;
        if (corners && !this._unsmoothIsle) {
            this._unsmoothIsle = smoothIsleCorners(this._GlassBackdrop.prototype, this._Mask);
            if (!this._unsmoothIsle)
                console.warn("[panel-island] Isle's glass has changed: its corners are left as Isle draws them");
        } else if (!corners && this._unsmoothIsle) {
            this._unsmoothIsle();
            this._unsmoothIsle = null;
        }
        // Settings → Lighter blur updates, for Isle's music bars and lyrics too (isleTuning.js).
        const tune = !this._dead && lighter && this._isleTunable;
        if (tune && !this._untuneIsle) {
            this._untuneIsle = tuneIsle(this._isleTunable);
            if (!this._untuneIsle)
                console.warn("[panel-island] Isle's bars and lyrics have changed: left as Isle has them");
        } else if (!tune && this._untuneIsle) {
            this._untuneIsle();
            this._untuneIsle = null;
        }
        // Settings → Isle without bounce: the island's springs damped not to overshoot (isleCalm.js).
        const calm = !this._dead && this._settings?.get_boolean('patch-isle-calm') && this._isleSprings;
        if (calm && !this._uncalmIsle) {
            this._uncalmIsle = calmIsle(this._isleSprings);
            if (!this._uncalmIsle)
                console.warn("[panel-island] Isle's springs have changed: its island bounces as it does");
        } else if (!calm && this._uncalmIsle) {
            this._uncalmIsle();
            this._uncalmIsle = null;
        }
        // Settings → Light Isle: Isle's island light as Panel Island's Style says (isleLight.js).
        const light = !this._dead && this._settings?.get_boolean('patch-isle-light') && this._glassIsIsle &&
            this._isleIslandClass && this._theme;
        if (light && !this._unlightIsle) {
            this._unlightIsle = lightIsle(this._isleIslandClass, this._theme, this._isleStylesheet,
                () => this._capsulesLight(), () => this._tint());
            if (!this._unlightIsle)
                console.warn("[panel-island] Isle's island has changed: it stays dark");
        } else if (!light && this._unlightIsle) {
            this._unlightIsle.undo();
            this._unlightIsle = null;
        }
        // Settings → Weather on Isle's Calendar page: Isle's own branch's weather, added as it runs (isleWeather.js).
        const weather = !this._dead && this._settings?.get_boolean('isle-weather') && this._isleCalendar;
        if (weather && !this._unweatherIsle) {
            this._unweatherIsle = addIsleWeather(this._isleCalendar.CalendarPage, this._isleCalendar.helpers);
            if (!this._unweatherIsle)
                console.warn("[panel-island] Isle's Calendar page has changed: no weather is added to it");
        } else if (!weather && this._unweatherIsle) {
            this._unweatherIsle();
            this._unweatherIsle = null;
        }
    }

    /** The monitor the bar is on. */
    _monitor() {
        return Main.layoutManager.findMonitorForActor(Main.panel) ?? Main.layoutManager.primaryMonitor;
    }

    /** The capsule round `box`'s items from `extent[0]` to `extent[1]` (stage x): a little past them, kept off the
     * screen's edges unless it reaches them (Settings → Reach screen edges). */
    _capsuleShape(box, extent) {
        const s = scale();
        const [panelX] = Main.panel.get_transformed_position();
        const [panelWidth] = Main.panel.get_transformed_size();
        const inset = Math.round((this._notch() ? NOTCH_SHOULDER : GAP) * s);
        const x1 = Math.round(Math.max(panelX + inset, extent[0] - SIDE_PAD * s));
        const x2 = Math.round(Math.min(panelX + panelWidth - inset, extent[1] + SIDE_PAD * s));
        return this._shape(box, x1, x2);
    }

    /**
     * The side shape for `box` from `x1` to `x2` (stage x): its capsule, or with `menu` ({x, y, width, height,
     * radius}) the glass that menu opens in, down round it. A pill floats in the bar, round all over; a notch hangs from
     * the top of the screen, its shoulders flaring along it, its bottom corners round; open, its shoulders grow as
     * Isle's open island's. Reaching the screen's edge (Settings), its outer side is the screen's edge and its outer
     * corners as Settings says: round in (+), square (0) or flaring out down the screen's side (−).
     */
    _shape(box, x1, x2, menu = null) {
        const s = scale();
        let [, panelY] = Main.panel.get_transformed_position();
        const [, panelHeight] = Main.panel.get_transformed_size();
        const monitor = this._monitor();
        // Bar at the bottom: worked out as if the bar were at the top of the monitor turned upside down, then turned
        // back (shape.js `flipped`). Menus open upwards then, so the same steps fit them.
        const axis = atBottom() && monitor ? 2 * monitor.y + monitor.height : null;
        if (axis !== null) {
            panelY = axis - panelY - panelHeight;
            if (menu)
                menu = {...menu, y: axis - menu.y - menu.height};
        }
        const done = shape => axis === null ? shape : flipped(shape, axis);
        const gap = Math.round(GAP * s);
        const notch = this._notch();
        const leftSide = box === Main.panel._leftBox;
        const centre = box === Main.panel._centerBox;
        const capsuleHeight = Math.max(1, Math.round(notch ? panelHeight - gap : panelHeight - 2 * gap));
        const y = Math.round(notch ? panelY : panelY + gap);
        const height = menu ? Math.max(capsuleHeight, Math.round(menu.y + menu.height - y)) : capsuleHeight;
        // The inner side's corners: as Isle's island, closed or open.
        let top, bottom;
        if (notch) {
            top = -Math.round((menu ? NOTCH_OPEN_SHOULDER : NOTCH_SHOULDER) * s);
            bottom = menu ? menu.radius : Math.min(capsuleHeight / 2, NOTCH_RADIUS * s);
        } else {
            top = capsuleHeight / 2;
            bottom = menu ? Math.max(menu.radius, capsuleHeight / 2) : capsuleHeight / 2;
        }
        let outerTop = top, outerBottom = bottom, outerFlare = ALONG_EDGE, outerCut = 0, outerTopCut = 0;
        const reach = !centre && this._settings.get_boolean('reach-edges') && monitor;
        if (reach) {
            if (leftSide)
                x1 = monitor.x;
            else
                x2 = monitor.x + monitor.width;
            const topCorner = this._edgeCorner(true), bottomCorner = this._edgeCorner(false);
            outerFlare = DOWN_SIDE;
            // Match window corners: the corner's size from the windows' corners, its radius's sign picking which way
            // it goes (+ round, − flared, 0 square).
            const sign = v => Math.sign(v);
            // The top corner: round as a window's corner, or its radius. Flared, it mirrors the bottom's flare across
            // the capsule, its whole curve kept: by its own radius, as the bottom's is; matching the windows, as big as
            // a window's corner and the gap above (a pill's; none for a notch), about a centre cut in by that gap, as
            // the bottom's round the window below. What reaches past the screen's top is cut off by the clip.
            const topGap = Math.max(0, y - monitor.y);
            if (topCorner.match && topCorner.radius < 0) {
                outerTop = -(Math.max(0, topCorner.windowRadius) * s + topGap);
                outerTopCut = topGap;
            } else {
                outerTop = topCorner.match ? sign(topCorner.radius) * Math.max(0, topCorner.windowRadius) * s
                    : topCorner.radius * s;
            }
            // The bottom corner, closed, matching a window right below the bar: round, as round as the window's corner
            // (the two curves mirroring each other across the gap); or flared, following the window's corner at an
            // even gap: a flare as big as that corner and the gap, about the same centre (cut in by the gap), meeting
            // the screen's side where the window's corner does. Open, the menu's bottom is far from any window: its
            // radius.
            outerBottom = bottomCorner.radius * s;
            if (!menu && bottomCorner.match) {
                const windowRadius = Math.max(0, bottomCorner.windowRadius) * s;
                if (bottomCorner.radius > 0) {
                    outerBottom = windowRadius;
                } else if (bottomCorner.radius < 0) {
                    const g = Math.max(0, panelY + panelHeight - (y + capsuleHeight));
                    outerBottom = -(windowRadius + g);
                    outerCut = g;
                } else {
                    outerBottom = 0;
                }
            }
        }
        if (centre) {
            return done({x: x1, y, width: Math.max(capsuleHeight, x2 - x1), height, corners: [top, top, bottom, bottom],
                flares: [ALONG_EDGE, ALONG_EDGE, ALONG_EDGE, ALONG_EDGE], cuts: [0, 0, 0, 0], flush: [notch ? 1 : 0, 0, 0, 0]});
        }
        const corners = leftSide ? [outerTop, top, bottom, outerBottom] : [top, outerTop, outerBottom, bottom];
        const flares = leftSide ? [outerFlare, ALONG_EDGE, ALONG_EDGE, outerFlare]
            : [ALONG_EDGE, outerFlare, outerFlare, ALONG_EDGE];
        const cuts = leftSide ? [outerTopCut, 0, 0, outerCut] : [0, outerTopCut, outerCut, 0];
        const flush = [notch ? 1 : 0, reach && !leftSide ? 1 : 0, 0, reach && leftSide ? 1 : 0];
        return done({x: x1, y, width: Math.max(capsuleHeight, x2 - x1), height, corners, flares, cuts, flush});
    }

    /** The open menu's glass, as Isle's island opens: one shape from the top of its capsule, which stays its top,
     * down round the whole menu (see `_shape`). The menu is moved sideways to the middle of that shape: centred under
     * a capsule wider than it, or, wider itself, moved only as far as it takes to reach over the whole capsule. */
    _openRect(menu, button) {
        const box = menu.box;
        const c = this._restRect(button);
        const placed = this._menuRect(menu);
        const natural = {...placed, x: placed.x - box.translation_x};
        let shift = 0;
        if (!this._settings.get_boolean('centre-menus'))
            shift = 0;
        else if (natural.width <= c.width)
            shift = c.x + c.width / 2 - (natural.x + natural.width / 2);
        else if (natural.x > c.x)
            shift = c.x - natural.x;
        else if (natural.x + natural.width < c.x + c.width)
            shift = c.x + c.width - (natural.x + natural.width);
        shift = Math.round(shift);
        if (box.translation_x !== shift)
            box.translation_x = shift;
        const m = {...natural, x: natural.x + shift};
        const x1 = Math.min(m.x, c.x), x2 = Math.max(m.x + m.width, c.x + c.width);
        return this._shape(button.container.get_parent(), x1, x2, m);
    }

    /** The menu drawn without its own background: the glass under it is (see stylesheet.css). */
    _clear(menu) {
        const id = this._restores.get(menu);
        if (id) {
            GLib.source_remove(id);
            this._restores.delete(menu);
        }
        this._cleared.add(menu);
        menu.box.add_style_class_name('panel-island-clear');
        menu.actor.add_style_class_name('panel-island-menu');
        this._schemeMenu(menu);
    }

    /** A menu on the glass light or dark as the capsules are (Settings → Style): its toggles, buttons and cards
     * see-through on the glass (stylesheet.css), and, when GNOME's own style is the other one, drawn in this one's
     * colours (menuScheme.js). */
    _schemeMenu(menu) {
        const light = this._capsulesLight();
        if (light)
            menu.box.add_style_class_name('panel-island-glass-light');
        else
            menu.box.remove_style_class_name('panel-island-glass-light');
        const forced = this._menuSchemes && light !== gnomeLight() ? SCHEME_CLASS[light ? 'light' : 'dark'] : null;
        for (const cls of Object.values(SCHEME_CLASS)) {
            if (cls === forced)
                menu.actor.add_style_class_name(cls);
            else
                menu.actor.remove_style_class_name(cls);
        }
    }

    /** Its own background back, and its place (see `_openRect`). */
    _restore(menu) {
        if (!this._cleared.delete(menu))
            return;
        menu.box.remove_style_class_name('panel-island-clear');
        menu.box.remove_style_class_name('panel-island-glass-light');
        menu.box.translation_x = 0;
        menu.actor.remove_style_class_name('panel-island-menu');
        Object.values(SCHEME_CLASS).forEach(cls => menu.actor.remove_style_class_name(cls));
    }

    /** The glasses drawn over the left capsule, each with whether what it is for is still open (a menu of the bar, Island
     * Menu's workspace peek, an island panel such as its launcher). */
    _leftGlasses() {
        return [[this._morph, Boolean(this._active)], [this._peekGlass, Boolean(this._workspaces?.shown)],
            [this._islandGlass, Boolean(this._island?.shown)]].filter(([glass]) => glass);
    }

    /** Whether the left capsule may show its own glass again as `leaving` goes: held by it, and no other glass over
     * it, open or still shrinking back. */
    _leftFree(leaving) {
        return this._heldCapsule === this._capsules?.[0] &&
            this._leftGlasses().every(([glass, open]) => glass === leaving || (!open && !glass.shown));
    }

    /** `taking` takes a capsule: every other glass only shrinking back (what it was for already closed) put away at
     * once, so two glasses are never drawn over one capsule, one growing as the other goes. */
    _endClosing(taking) {
        for (const [glass, open] of this._leftGlasses()) {
            if (glass !== taking && !open && glass.shown)
                glass.hide();
        }
    }

    /** Hands holding the capsule (its own glass not drawn) to `capsule`, or to none. */
    _hold(capsule) {
        if (this._heldCapsule === capsule)
            return;
        if (this._heldCapsule)
            this._heldCapsule.held = false;
        this._heldCapsule = capsule;
        if (capsule)
            capsule.held = true;
    }

    /** Whether menus open on hover, and after how long a rest, in ms: as Settings says, or as Isle's island opens. */
    _openOn() {
        const mode = this._settings.get_string('open-on');
        if (mode === 'hover')
            return {hover: true, delay: this._settings.get_int('hover-delay')};
        if (mode === 'click')
            return {hover: false, delay: 0};
        const isle = this._isleSettings;
        return {
            hover: (isle?.get_string('open-on') ?? 'hover') === 'hover',
            delay: isle?.get_int('hover-delay') ?? HOVER_DELAY_MS,
        };
    }

    _cancelHoverOpen() {
        if (this._hoverTimer)
            GLib.source_remove(this._hoverTimer);
        this._hoverTimer = 0;
    }

    /** The pointer came onto (or left) a button: with no menu of the bar open, its menu opens once it rests there. */
    _hovered(button) {
        this._cancelHoverOpen();
        if (this._dead)
            return;
        const {hover, delay} = this._openOn();
        if (!hover || !button.hover || Main.panel.menuManager.activeMenu || !this._sideOn(button))
            return;
        this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hoverTimer = 0;
            if (button.hover && !Main.panel.menuManager.activeMenu && !button.menu.isOpen && button.reactive) {
                this._hoverMode = true;
                this._hoverOpenedAt = GLib.get_monotonic_time();
                button.menu.open(BoxPointer.PopupAnimation.FULL);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** A click on a button: no hover opening after it; just after a hover opened its menu, it keeps the menu open. */
    _buttonEvent(button, event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        this._cancelHoverOpen();
        if (this._hoverMode && this._active === button.menu &&
            GLib.get_monotonic_time() - this._hoverOpenedAt < PIN_WINDOW_MS * 1000) {
            this._hoverMode = false;
            this._stopLeaveWatch();
            return Clutter.EVENT_STOP;
        }
        // Clicked open (or shut): the menu stays until closed as GNOME's do.
        this._hoverMode = false;
        this._stopLeaveWatch();
        return Clutter.EVENT_PROPAGATE;
    }

    /** While a menu opened on hover is open: it closes once the pointer has been off its button and its glass for
     * Settings' close delay. Polled, as the menu's grab keeps crossing events from the bar. */
    _startLeaveWatch() {
        if (this._leaveTimer)
            return;
        this._outsideSince = 0;
        this._leaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_CHECK_MS, () => {
            const menu = this._active;
            if (!menu || !this._hoverMode) {
                this._leaveTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._pointerOn(menu)) {
                this._outsideSince = 0;
                return GLib.SOURCE_CONTINUE;
            }
            const now = GLib.get_monotonic_time();
            this._outsideSince ||= now;
            if (now - this._outsideSince < this._settings.get_int('close-delay') * 1000)
                return GLib.SOURCE_CONTINUE;
            this._leaveTimer = 0;
            menu.close(BoxPointer.PopupAnimation.FULL);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopLeaveWatch() {
        if (this._leaveTimer)
            GLib.source_remove(this._leaveTimer);
        this._leaveTimer = 0;
    }

    /** Whether the pointer is on `menu`'s button, its glass or the menu itself (a part reaching out of the glass). */
    _pointerOn(menu) {
        const [px, py] = global.get_pointer();
        const slack = LEAVE_SLACK * scale();
        const on = r => r && px >= r.x - slack && px <= r.x + r.width + slack && py >= r.y - slack && py <= r.y + r.height + slack;
        const button = this._menus.get(menu);
        const [bx, by] = button.get_transformed_position();
        const [bw, bh] = button.get_transformed_size();
        if (on({x: bx, y: by, width: bw, height: bh}) || on(this._morph.shown ? this._morph.rect : null) ||
            on(this._menuRect(menu)))
            return true;
        // On a menu of its own that reaches out of it (a right-click menu in ArcMenu, a submenu beside it).
        for (let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px, py); actor; actor = actor.get_parent()) {
            if (actor === menu.actor || actor.has_style_class_name?.('popup-menu-boxpointer'))
                return true;
        }
        return false;
    }

    _opened(menu, button) {
        this._cancelHoverOpen();
        // A menu opening takes the glass: the workspace peek goes at once.
        this._workspaces?.close(true, 'a menu opened');
        if (this._dead)
            return;
        if (!this._sideOn(button)) {
            // Its side's capsule is off: GNOME's own menu. Another of the bar's, open on glass, closes as it does.
            this._active = null;
            return;
        }
        if (this._hoverMode)
            this._startLeaveWatch();
        this._active = menu;
        // Emitted before GNOME places and shows the menu, which then fades in as GNOME's own do.
        this._clear(menu);
        const pointer = menu.actor;
        // Its size (a submenu opening) and its place (set as the menu is laid out) are followed.
        const follow = () => this._queueMenu(menu, button, false);
        menu.box.connectObject('notify::allocation', follow, this);
        pointer.connectObject('notify::allocation', follow, this);
        this._queueMenu(menu, button, true);
    }

    /** Once the menu is laid out where it opens: the glass grows to it (`start`), or follows it (a new size). */
    _queueMenu(menu, button, start) {
        if (this._dead)
            return;
        if (this._menuLater)
            global.compositor.get_laters().remove(this._menuLater);
        this._pendingStart = start || this._pendingStart;
        this._menuLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._menuLater = 0;
            if (this._active !== menu) {
                this._pendingStart = false;
                return false;
            }
            const to = this._openRect(menu, button);
            // Not laid out yet (opened for the first time): the start waits for its first size.
            if (to.width <= 0 || to.height <= 0)
                return false;
            const begin = this._pendingStart;
            this._pendingStart = false;
            if (begin) {
                // From where the glass is (another menu closing, this one reopening), else from the capsule itself.
                const from = this._morph.shown && this._morph.rect ? this._morph.rect : this._restRect(button);
                const target = () => this._active === menu ? this._openRect(menu, button) : null;
                const ease = this._settings.get_boolean('bounce') ? easeOutBack : easeOutCubic;
                // Any other glass still shrinking away (the workspace peek, an island panel) gone at once: two
                // never show over one capsule.
                this._endClosing(this._morph);
                this._morph.animate(from, to, {ms: this._ms(OPEN_MS), ease, target, reveal: menu.actor,
                    follow: menu.actor});
                // The glass is drawn where the capsule is: the capsule's own can go.
                this._hold(this._capsuleOf(button));
            } else {
                this._morph.retarget(to);
            }
            return false;
        });
    }

    _closed(menu, button) {
        if (this._dead)
            return;
        menu.box.disconnectObject(this);
        menu.actor.disconnectObject(this);
        // Given back once the menu has faded out (its own close animation, shorter than the glass's).
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._ms(CLOSE_MS) + 50, () => {
            this._restores.delete(menu);
            if (!menu.isOpen)
                this._restore(menu);
            return GLib.SOURCE_REMOVE;
        });
        this._restores.set(menu, id);
        if (this._active !== menu)
            return;
        this._active = null;
        if (!this._morph.shown || !this._morph.rect) {
            this._hoverMode = false;
            this._stopLeaveWatch();
            this._morph.hide();
            this._hold(null);
            return;
        }
        // Not straight away: another menu of the bar may be opening in its place (the pointer moving along the bar).
        GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            if (this._dead || this._active || !this._morph)
                return GLib.SOURCE_REMOVE;
            // No menu of the bar open now: the next one opens as the user opens it.
            this._hoverMode = false;
            this._stopLeaveWatch();
            // Back into the capsule, which shows again where the glass ends; the menu, fading out as GNOME closes it,
            // cut to the glass as it shrinks, never left showing past it.
            this._morph.animate(this._morph.rect, this._restRect(button), {ms: this._ms(CLOSE_MS), ease: easeInOutCubic,
                target: () => this._restRect(button), reveal: menu.actor,
                onDone: () => {
                    if (this._active)
                        return;
                    // Not if another glass has the left capsule now (it gives it back as it goes).
                    if (this._heldCapsule !== this._capsules?.[0] || this._leftFree(this._morph))
                        this._hold(null);
                    this._morph.hide();
                }});
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Isle's look now: its glass (with its tint) or black. Set as Isle sets it, so it is right whichever enables first. */
    /** The side shapes' look: Settings → Look (glass, as strong as Isle's or as Settings → Glass strength says, or
     * black), or Isle's island's own. Isle's theme
     * module keeps one look, Isle's: another is read by setting it and at once setting Isle's back, with nothing of
     * Isle's running between. */
    _look() {
        const theme = this._theme;
        if (!theme)
            return {fill: FALLBACK_FILL, edge: PILL_EDGE, blur: null};
        const evenRim = (this._settings?.get_string('edge-light') ?? 'even') === 'even';
        // Settings → Edge blur: thinning into clear glass towards the screen's edge as Isle's, or solid up to it.
        const solidEdge = (this._settings?.get_string('edge-blur') ?? 'fade') === 'solid';
        const read = () => ({fill: [...theme.fill()], edge: theme.edge() ? {...theme.edge()} : null,
            blur: theme.blur() ? {...theme.blur()} : null, evenRim, solidEdge});
        const {name: isleName, tint: isleTint} = this._isleLook();
        const mode = this._settings?.get_string('theme') ?? 'isle';
        const name = mode === 'isle' ? isleName : mode;
        // Without Isle, Settings → Glass strength alone.
        const likeIsle = this._isleSettings && (this._settings?.get_boolean('tint-like-isle') ?? true);
        const tint = likeIsle ? isleTint : this._settings.get_int('glass-tint');
        if (name === isleName && (name !== 'glass' || tint === isleTint))
            return read();
        try {
            theme.setTheme(name, tint);
            return read();
        } finally {
            theme.setTheme(isleName, isleTint);
        }
    }

    /** Isle's look as its Settings say ({name, tint}); without Isle, the look Isle starts with: clear glass. */
    _isleLook() {
        const isle = this._isleSettings;
        return isle ? {name: isle.get_string('island-theme'), tint: isle.get_int('glass-tint')} : {name: 'glass', tint: 0};
    }

    /** Settings → Style: whether the capsules are light (Light, Dark, or as GNOME's own style is). */
    _capsulesLight() {
        const style = this._settings?.get_string('color-style') ?? 'auto';
        return style === 'auto' ? gnomeLight() : style === 'light';
    }

    /** The dark and light looks, and which the capsules use (`_capsulesLight`). */
    _looks() {
        const dark = this._look();
        return {dark, light: lightLook(dark, this._tint())};
    }

    /** Settings → Glass strength (or Isle's Glass tint, followed), 0 clear to 100 dark or frosted. */
    _tint() {
        const likeIsle = this._isleSettings && (this._settings?.get_boolean('tint-like-isle') ?? true);
        return likeIsle ? this._isleLook().tint : this._settings?.get_int('glass-tint') ?? 0;
    }

    _applyTheme() {
        if (this._theme) {
            const {name, tint} = this._isleLook();
            this._theme.setTheme(name, tint);
        }
        const looks = this._looks();
        this._lookSet = looks;
        // Isle's island light or dark with the capsules (Settings → Light Isle).
        this._unlightIsle?.sync();
        const look = this._capsulesLight() ? looks.light : looks.dark;
        this._capsules.forEach(capsule => capsule.setLook(look));
        // A menu's glass as light or dark as the capsules, the menu on it drawn the same (`_schemeMenu`), so its text
        // stays readable; as GNOME's own style if the menus can't be drawn otherwise.
        this._morph.setLook((this._menuSchemes ? this._capsulesLight() : gnomeLight()) ? looks.light : looks.dark);
        // The other style's stylesheet loaded only while menus are drawn in it (menuScheme.js).
        const light = this._capsulesLight();
        this._menuSchemes?.use(light !== gnomeLight() ? (light ? 'light' : 'dark') : null);
        this._cleared.forEach(menu => this._schemeMenu(menu));
        this._peekGlass?.setLook((this._peekLight ?? this._capsulesLight()) ? looks.light : looks.dark);
        // Island Menu's numbers shaded as strongly as the glass is now (its workspaces.js).
        try {
            global.island_menu_workspaces?.lookChanged?.();
        } catch {}
        this._islandGlass?.setLook(look);
        this._applyTextStyle();
        if (this._morph.shown && this._morph.rect)
            this._morph.retarget(this._morph.rect);
        this._queue();
    }

    /**
     * The bar's items after GNOME's Activities button (its workspace dots) kept still through a workspace switch (`on`),
     * let go as it ends. Its dots grow and shrink with the slide, each rounded to a whole pixel every frame: from three
     * workspaces on (GNOME widens the shown one by a factor whose pixels do not add up evenly then) the button's width
     * flips a pixel back and forth, and everything after it shook with it. Each of them is moved back by just that much
     * as it flips, so it stays where it was; the button and its dots are left to GNOME, drawn as GNOME draws them (held
     * at one width instead, GNOME squeezed its dots into it, and they shook within it).
     */
    _steadyActivities(on) {
        const button = Main.panel.statusArea?.activities?.container;
        if (on) {
            if (!button || this._steadied || !button.mapped)
                return;
            const held = this._steadied = {button, width: button.width, moved: new Map()};
            switchCount = global.workspace_manager.n_workspaces;
            const follow = () => {
                if (this._steadied !== held)
                    return;
                try {
                    // A real change (a workspace added or taken away during the switch: its dots growing or shrinking,
                    // a whole dot over a few frames): not a wobble to hide. Followed as it goes: the items given back
                    // their own place, held anew from this width, and the capsule measured again, so it grows or
                    // shrinks with it, every frame.
                    if (followingRealChange() || countChangedThisSwitch() ||
                        Math.abs(held.width - button.width) > SWITCH_SLACK * scale()) {
                        for (const [item, own] of held.moved) {
                            if (item.translation_x !== own)
                                item.translation_x = own;
                        }
                        held.width = button.width;
                        this._measureSoon();
                        return;
                    }
                    const delta = held.width - button.width;
                    const parent = button.get_parent();
                    const after = parent ? parent.get_children().slice(parent.get_children().indexOf(button) + 1) : [];
                    for (const item of after) {
                        if (!held.moved.has(item)) {
                            // Its own sideways shift, if any, kept under ours and given back.
                            held.moved.set(item, item.translation_x);
                            item.connectObject('destroy', () => held.moved.delete(item), this);
                        }
                        const want = held.moved.get(item) + delta;
                        if (item.translation_x !== want)
                            item.translation_x = want;
                    }
                } catch (e) {
                    console.warn(`[panel-island] The bar's items left to shake with the workspace dots: ${e}`);
                }
            };
            button.connectObject('notify::width', follow, 'destroy', () => this._steadyActivities(false), this);
            follow();
            return;
        }
        const held = this._steadied;
        this._steadied = null;
        switchCount = -1;
        if (!held)
            return;
        try {
            held.button.disconnectObject(this);
        } catch {}
        for (const [item, own] of held.moved) {
            try {
                item.disconnectObject(this);
                item.translation_x = own;
            } catch {}
        }
        held.moved.clear();
        // Put back where they are: a shift, not a new allocation, so nothing else tells the capsule; measured again here.
        this._queue();
    }

    _queue() {
        if (this._dead || this._later || !this._container)
            return;
        this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            this._update();
            return false;
        });
    }

    /** The capsules measured again now and twice more as GNOME's workspace dots settle (a later step of their animation
     * could otherwise go unnoticed); if the left one was still at its old size by then, put right and said in the log. */
    _remeasureSoon() {
        // Followed every frame while the dots change (see `followUntil`), then measured once more as they settle.
        followUntil = GLib.get_monotonic_time() + FOLLOW_MS * 1000;
        this._queue();
        (this._remeasureIds ??= []).forEach(id => GLib.source_remove(id));
        this._remeasureIds = [FOLLOW_MS + 100].map(ms => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._remeasureIds = this._remeasureIds.filter(other => other !== id);
                if (this._dead || !this._capsules)
                    return GLib.SOURCE_REMOVE;
                const left = this._capsules[0];
                const before = left?.rect ? `${Math.round(left.rect.x)}+${Math.round(left.rect.width)}` : '';
                this._update();
                const after = left?.rect ? `${Math.round(left.rect.x)}+${Math.round(left.rect.width)}` : '';
                if (before && after && before !== after)
                    console.log(`[panel-island] The left capsule was still at its old size after a workspace change: ${before} → ${after}`);
                return GLib.SOURCE_REMOVE;
            });
            return id;
        });
    }

    /** Measured once GNOME has laid the bar out (a high-priority idle runs right after the frame's layout), so the
     * capsule takes its new size in the very next frame. */
    _measureSoon() {
        if (this._dead || this._measureId || !this._container)
            return;
        this._measureId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            this._measureId = 0;
            if (!this._dead && this._container)
                this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const panelBox = Main.layoutManager.panelBox;
        this._container.visible = panelBox.visible;
        this._container.opacity = panelBox.opacity;
        if (!panelBox.visible)
            return;
        this._capsules.forEach(capsule => capsule.update());
    }

    disable() {
        this._alive = false;
        (this._remeasureIds ?? []).forEach(id => GLib.source_remove(id));
        this._remeasureIds = [];
        if (this._measureId)
            GLib.source_remove(this._measureId);
        this._measureId = 0;
        global.workspace_manager.disconnectObject(this);
        this._dotRow?.disconnectObject(this);
        this._dotRow = null;
        // Isle as it was, whatever else.
        this._unpatchIsle?.();
        this._unpatchIsle = null;
        this._unsmoothIsle?.();
        this._unsmoothIsle = null;
        this._unweatherIsle?.();
        this._unweatherIsle = null;
        this._unlightIsle?.undo();
        this._unlightIsle = null;
        this._untuneIsle?.();
        this._untuneIsle = null;
        this._uncalmIsle?.();
        this._uncalmIsle = null;
        this._isleSprings = null;
        this._menuSchemes?.unload();
        this._menuSchemes = null;
        this._isleIslandClass = null;
        this._isleCalendar = null;
        this._Mask = null;
        this._GlassBackdrop = null;
        this._unwatchSwitch?.();
        this._unwatchSwitch = null;
        this._steadyActivities(false);
        releaseOverview();
        // GNOME's clock as it was, and the bar back at the top, whatever else.
        for (const feature of [this._clock, this._weather]) {
            try {
                feature?.destroy();
            } catch (e) {
                console.warn(`[panel-island] The capsule clock or weather was not taken down cleanly: ${e}`);
            }
        }
        this._clock = this._weather = null;
        setBarAtBottom(false);
        if (this._dead) {
            // Already gone with the shell's bar: only what is ours to drop.
            Main.extensionManager.disconnectObject(this);
            St.Settings.get().disconnectObject(this);
            keepBar(false);
            keepActivities(false);
            this._isleSettings?.disconnectObject(this);
            this._rwcSettings?.disconnectObject(this);
            this._rwcSettings = null;
            this._settings?.disconnectObject(this);
            this._settings = null;
            this._menus?.clear();
            if (global.panel_island === this._island?.api)
                delete global.panel_island;
            this._workspaces = this._peekGlass = null;
            this._island = this._islandGlass = null;
            this._capsules = this._morph = this._container = this._isleSettings = this._theme = null;
            return;
        }
        const laters = global.compositor.get_laters();
        if (this._later)
            laters.remove(this._later);
        if (this._menuLater)
            laters.remove(this._menuLater);
        this._later = this._menuLater = 0;
        for (const object of [Main.panel._leftBox, Main.panel._rightBox, Main.panel._centerBox, Main.panel,
            Main.layoutManager.panelBox, Main.layoutManager, Main.extensionManager, St.ThemeContext.get_for_stage(global.stage),
            St.Settings.get()])
            object.disconnectObject(this);
        this._isleSettings?.disconnectObject(this);
        this._rwcSettings?.disconnectObject(this);
        this._rwcSettings = null;
        this._settings?.disconnectObject(this);
        for (const side of ['left', 'right', 'centre']) {
            Main.panel.remove_style_class_name(`panel-island-flat-${side}`);
            Main.panel.remove_style_class_name(`panel-island-light-${side}`);
        }
        keepBar(false);
        setBar(null);
        keepActivities(false);
        this._settings = null;
        this._watched?.forEach(child => child.disconnectObject(this));
        this._watched?.clear();
        this._cancelHoverOpen();
        this._stopLeaveWatch();
        this._restores?.forEach(id => GLib.source_remove(id));
        this._restores?.clear();
        for (const [menu, button] of this._menus ?? []) {
            button.disconnectObject(this);
            menu.disconnectObject(this);
            menu.box?.disconnectObject(this);
            menu.actor?.disconnectObject(this);
            this._restore(menu);
        }
        this._menus?.clear();
        this._active = null;
        this._workspaces?.destroy();
        this._workspaces = null;
        this._peekGlass?.destroy();
        this._peekGlass = null;
        this._island?.destroy();
        this._island = null;
        this._islandGlass?.destroy();
        this._islandGlass = null;
        this._morph?.destroy();
        this._morph = null;
        this._capsules?.forEach(capsule => capsule.destroy());
        this._capsules = null;
        this._container?.destroy();
        this._container = null;
        this._isleSettings = null;
        this._theme = null;
    }
}
