// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
// Portions copyright (C) 2026 zickrian: the shader's tone, lens and rim, from Isle's glass.js
//
// The side glass's shape: a body whose four corners are each their own. A corner is round (a positive radius),
// square (0), or flares out concave (a negative one): along the top or bottom edge, as a notch's shoulders do, or
// down the side, where the body meets the screen's edge. Cairo draws its fill and rim from `outline`; the blur behind
// is cut to it by `sideMask`, a shader made from Isle's own (glass.js: its tone, lens and rim kept as they are, only
// the cut made per corner).
//
// A shape: {x, y, width, height} the body in stage px; corners [tl, tr, br, bl]; flares [tl, tr, br, bl], each
// ALONG_EDGE or DOWN_SIDE (which way a negative corner flares); flush [top, right, bottom, left], 1 where the body
// meets the screen's edge (no rim or lens there: the screen's edge is no edge); cuts [tl, tr, br, bl], optional,
// for a flare down the side: how far its circle's centre is moved in from the side, so the flare meets the side
// higher up, at an angle (with the window's corner radius r below a gap g: a flare r + g big cut by g follows the
// window's corner at an even g all round, both curves about one centre).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const TL = 0, TR = 1, BR = 2, BL = 3;
export const ALONG_EDGE = 0, DOWN_SIDE = 1;

const lerp = (a, b, t) => a + (b - a) * t;

/** `a` moved towards `b` by `t` (0..1, past 1 for an overshoot); which way corners flare is `b`'s. */
export function lerpShape(a, b, t) {
    return {
        x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t),
        width: Math.max(1, lerp(a.width, b.width, t)), height: Math.max(1, lerp(a.height, b.height, t)),
        corners: a.corners.map((v, i) => lerp(v, b.corners[i], t)),
        cuts: (a.cuts ?? [0, 0, 0, 0]).map((v, i) => lerp(v, b.cuts?.[i] ?? 0, t)),
        flares: b.flares, flush: b.flush,
    };
}

/** `shape` turned upside down about the line y = `axis` / 2 (a monitor's middle: `axis` its top twice plus its
 * height): a shape made for a bar at the top, for one at the bottom. Each corner trades places with the one above or
 * below it, and the screen's edge it meets goes from the top to the bottom. */
export function flipped(shape, axis) {
    const swap = v => [v[BL], v[BR], v[TR], v[TL]];
    const [top, right, bottom, left] = shape.flush;
    return {
        ...shape,
        y: axis - shape.y - shape.height,
        corners: swap(shape.corners), flares: swap(shape.flares), cuts: swap(shape.cuts ?? [0, 0, 0, 0]),
        flush: [bottom, right, top, left],
    };
}

/** `shape` with corners it can hold. Round ones, as CSS fits border radii: shrunk only where those along one side
 * add up to more than it is long, and only as much as that takes (a round top corner over a flared or square bottom
 * one may be as big as the shape is tall; two round ones share the height). A flare along an edge: at most half the
 * height (as Isle's shoulders). */
export function fitted(shape) {
    const {width: w, height: h} = shape;
    const round = shape.corners.map(v => Math.max(0, v));
    const fit = (a, b, length) => round[a] + round[b] > length ? length / (round[a] + round[b]) : 1;
    const top = fit(TL, TR, w), bottom = fit(BL, BR, w), left = fit(TL, BL, h), right = fit(TR, BR, h);
    const scaleOf = [Math.min(top, left), Math.min(top, right), Math.min(bottom, right), Math.min(bottom, left)];
    const corners = shape.corners.map((v, i) => {
        if (v >= 0)
            return Math.min(v * scaleOf[i], w, h);
        return shape.flares[i] === ALONG_EDGE ? -Math.min(-v, h / 2) : v;
    });
    // A cut only for a flare down the side, and never past its centre.
    const cuts = corners.map((v, i) => v < 0 && shape.flares[i] === DOWN_SIDE
        ? Math.max(0, Math.min(shape.cuts?.[i] ?? 0, -v)) : 0);
    return {...shape, corners, cuts};
}

/** How far down the side a flare `s` big, its centre moved in by `cut`, reaches. */
function depth(s, cut) {
    const w = s - cut;
    return s - Math.sqrt(Math.max(0, s * s - w * w));
}

/** How far the flares reach past the body on each side. */
function reach(shape) {
    const size = i => Math.max(0, -shape.corners[i]);
    const along = i => shape.flares[i] === ALONG_EDGE ? size(i) : 0;
    const down = i => shape.flares[i] === DOWN_SIDE ? depth(size(i), shape.cuts?.[i] ?? 0) : 0;
    return {
        left: Math.max(along(TL), along(BL)), right: Math.max(along(TR), along(BR)),
        top: Math.max(down(TL), down(TR)), bottom: Math.max(down(BR), down(BL)),
    };
}

/** All `shape` covers, flares and all, as {x, y, width, height}. */
export function bounds(shape) {
    const r = reach(shape);
    return {x: shape.x - r.left, y: shape.y - r.top, width: shape.width + r.left + r.right, height: shape.height + r.top + r.bottom};
}

/**
 * Traces the outline of the body `w` × `h` at `ox`, `oy` with `corners`, `flares` and `cuts` (see above), clockwise
 * from its top left. Each corner: round (an arc inside the body), square, or a concave arc out along its edge or down
 * its side.
 */
export function outline(cr, ox, oy, w, h, corners, flares, cuts = [0, 0, 0, 0]) {
    const L = ox, T = oy, R = ox + w, B = oy + h;
    const [tl, tr, br, bl] = corners;
    const half = Math.PI / 2;
    // A flare down the side: from `start` to `end` about its centre, concave (anticlockwise on the screen).
    const downArc = (cx, cy, s, start, end) => {
        cr.lineTo(start[0], start[1]);
        cr.arcNegative(cx, cy, s, Math.atan2(start[1] - cy, start[0] - cx), Math.atan2(end[1] - cy, end[0] - cx));
    };
    const down = (s, cut) => [s - cut, depth(s, cut)];
    // Top left: coming up the left side.
    if (tl > 0) {
        cr.moveTo(L, T + tl);
        cr.arc(L + tl, T + tl, tl, Math.PI, 3 * half);
    } else if (tl < 0 && flares[TL] === ALONG_EDGE) {
        cr.moveTo(L, T - tl);
        cr.arcNegative(L + tl, T - tl, -tl, 0, -half);
    } else if (tl < 0) {
        const [wd, d] = down(-tl, cuts[TL]);
        cr.moveTo(L, T - d);
        downArc(L + wd, T + tl, -tl, [L, T - d], [L + wd, T]);
    } else {
        cr.moveTo(L, T);
    }
    // Top right: along the top, then down the right side.
    if (tr > 0) {
        cr.lineTo(R - tr, T);
        cr.arc(R - tr, T + tr, tr, -half, 0);
    } else if (tr < 0 && flares[TR] === ALONG_EDGE) {
        cr.lineTo(R - tr, T);
        cr.arcNegative(R - tr, T - tr, -tr, -half, -Math.PI);
    } else if (tr < 0) {
        const [wd, d] = down(-tr, cuts[TR]);
        downArc(R - wd, T + tr, -tr, [R - wd, T], [R, T - d]);
    } else {
        cr.lineTo(R, T);
    }
    // Bottom right: down the right side, then along the bottom.
    if (br > 0) {
        cr.lineTo(R, B - br);
        cr.arc(R - br, B - br, br, 0, half);
    } else if (br < 0 && flares[BR] === ALONG_EDGE) {
        cr.lineTo(R, B + br);
        cr.arcNegative(R - br, B + br, -br, Math.PI, half);
    } else if (br < 0) {
        const [wd, d] = down(-br, cuts[BR]);
        downArc(R - wd, B - br, -br, [R, B + d], [R - wd, B]);
    } else {
        cr.lineTo(R, B);
    }
    // Bottom left: along the bottom, then up the left side (closing).
    if (bl > 0) {
        cr.lineTo(L + bl, B);
        cr.arc(L + bl, B - bl, bl, half, Math.PI);
    } else if (bl < 0 && flares[BL] === ALONG_EDGE) {
        cr.lineTo(L + bl, B);
        cr.arcNegative(L + bl, B + bl, -bl, half, 0);
    } else if (bl < 0) {
        const [wd, d] = down(-bl, cuts[BL]);
        downArc(L + wd, B - bl, -bl, [L + wd, B], [L, B + d]);
    } else {
        cr.lineTo(L, B);
    }
    cr.closePath();
}

// Isle's own uniforms (glass.js SHAPE, TONE, LENS), all set by its GlassBackdrop as it places the glass.
const ISLE_UNIFORMS = ['width', 'height', 'bottom', 'left', 'right', 'radius', 'shoulder', 'crown', 'reach', 'drop',
    'saturation', 'lo', 'span', 'gamma', 'deep', 'sheen', 'glow', 'knee', 'lens', 'band', 'spread', 'rim', 'rimWidth'];

// p in the body's units: its top at 0, its bottom at `bottom`, its sides at `left` and `right`.
const FUNCTIONS = `
// The body's round corners (positive ones) taken into how far p is inside it, d.
float sideRound(vec2 p, float d) {
    float r = max(corners.x, 0.0);
    if (r > 0.0 && p.x < left + r && p.y < r)
        d = min(d, r - length(p - vec2(left + r, r)));
    r = max(corners.y, 0.0);
    if (r > 0.0 && p.x > right - r && p.y < r)
        d = min(d, r - length(p - vec2(right - r, r)));
    r = max(corners.z, 0.0);
    if (r > 0.0 && p.x > right - r && p.y > bottom - r)
        d = min(d, r - length(p - vec2(right - r, bottom - r)));
    r = max(corners.w, 0.0);
    if (r > 0.0 && p.x < left + r && p.y > bottom - r)
        d = min(d, r - length(p - vec2(left + r, bottom - r)));
    return d;
}
// The nearest edge to p that is an edge (not the screen's): how far p is inside from it, and which way it faces
// (out), worked out from the outline itself, not sampled (a difference of distances a pixel apart goes wrong where
// they jump, as where a round corner meets the screen's edge, drawing a line there). Near a concave corner the edge
// it flares from is that flare's arc, facing its circle's centre; in a round corner, the corner's arc.
vec3 sideEdge(vec2 p) {
    float far = 100000.0;
    vec3 l = flush.w > 0.5 ? vec3(far, -1.0, 0.0) : vec3(p.x - left, -1.0, 0.0);
    vec3 r = flush.y > 0.5 ? vec3(far, 1.0, 0.0) : vec3(right - p.x, 1.0, 0.0);
    vec3 t = flush.x > 0.5 ? vec3(far, 0.0, -1.0) : vec3(p.y, 0.0, -1.0);
    vec3 b = flush.z > 0.5 ? vec3(far, 0.0, 1.0) : vec3(bottom - p.y, 0.0, 1.0);
    vec2 c;
    vec2 q;
    float s = -corners.x;
    if (s > 0.0) {
        if (flares.x < 0.5) {
            if (p.y < s) {
                q = vec2(left - s, s) - p;
                l = vec3(length(q) - s, normalize(q + 1e-5));
            }
        } else if (p.x < left + s - cuts.x) {
            q = vec2(left + s - cuts.x, -s) - p;
            t = vec3(length(q) - s, normalize(q + 1e-5));
        }
    }
    s = -corners.y;
    if (s > 0.0) {
        if (flares.y < 0.5) {
            if (p.y < s) {
                q = vec2(right + s, s) - p;
                r = vec3(length(q) - s, normalize(q + 1e-5));
            }
        } else if (p.x > right - s + cuts.y) {
            q = vec2(right - s + cuts.y, -s) - p;
            t = vec3(length(q) - s, normalize(q + 1e-5));
        }
    }
    s = -corners.z;
    if (s > 0.0) {
        if (flares.z < 0.5) {
            if (p.y > bottom - s) {
                q = vec2(right + s, bottom - s) - p;
                r = vec3(length(q) - s, normalize(q + 1e-5));
            }
        } else if (p.x > right - s + cuts.z) {
            q = vec2(right - s + cuts.z, bottom + s) - p;
            b = vec3(length(q) - s, normalize(q + 1e-5));
        }
    }
    s = -corners.w;
    if (s > 0.0) {
        if (flares.w < 0.5) {
            if (p.y > bottom - s) {
                q = vec2(left - s, bottom - s) - p;
                l = vec3(length(q) - s, normalize(q + 1e-5));
            }
        } else if (p.x < left + s - cuts.w) {
            q = vec2(left + s - cuts.w, bottom + s) - p;
            b = vec3(length(q) - s, normalize(q + 1e-5));
        }
    }
    vec3 e = l;
    if (r.x < e.x)
        e = r;
    if (t.x < e.x)
        e = t;
    if (b.x < e.x)
        e = b;
    // Round corners: inside one, its arc is the edge.
    float k = max(corners.x, 0.0);
    if (k > 0.0 && p.x < left + k && p.y < k) {
        c = vec2(left + k, k);
        q = p - c;
        if (k - length(q) < e.x)
            e = vec3(k - length(q), normalize(q + 1e-5));
    }
    k = max(corners.y, 0.0);
    if (k > 0.0 && p.x > right - k && p.y < k) {
        c = vec2(right - k, k);
        q = p - c;
        if (k - length(q) < e.x)
            e = vec3(k - length(q), normalize(q + 1e-5));
    }
    k = max(corners.z, 0.0);
    if (k > 0.0 && p.x > right - k && p.y > bottom - k) {
        c = vec2(right - k, bottom - k);
        q = p - c;
        if (k - length(q) < e.x)
            e = vec3(k - length(q), normalize(q + 1e-5));
    }
    k = max(corners.w, 0.0);
    if (k > 0.0 && p.x < left + k && p.y > bottom - k) {
        c = vec2(left + k, bottom - k);
        q = p - c;
        if (k - length(q) < e.x)
            e = vec3(k - length(q), normalize(q + 1e-5));
    }
    return e;
}
// How much of the edge effects (rim, glow, lens) an edge facing \`facing\` (outwards) keeps: where the glass is cut
// by the screen's edge, an edge turning to run along it (a round corner meeting it) fades out as it turns, to none
// facing the screen's side itself, as the screen's edge has none. Facing away from every such side: all of it.
float sideFade(vec2 facing) {
    float k = 1.0;
    if (flush.x > 0.5)
        k *= 1.0 - pow(max(-facing.y, 0.0), 2.0);
    if (flush.y > 0.5)
        k *= 1.0 - pow(max(facing.x, 0.0), 2.0);
    if (flush.z > 0.5)
        k *= 1.0 - pow(max(facing.y, 0.0), 2.0);
    if (flush.w > 0.5)
        k *= 1.0 - pow(max(-facing.x, 0.0), 2.0);
    return k;
}
// Coverage of the concave flare s big at the corner k, sgn its outward signs, along its edge (v 0) or down its side
// (its centre moved in by cut).
float sideFlare(vec2 p, vec2 k, vec2 sgn, float s, float v, float cut) {
    if (s <= 0.0)
        return 0.0;
    vec2 c;
    vec2 a;
    vec2 b;
    if (v < 0.5) {
        c = vec2(k.x + sgn.x * s, k.y - sgn.y * s);
        a = vec2(k.x, k.y - sgn.y * s);
        b = vec2(k.x + sgn.x * s, k.y);
    } else {
        float w = s - cut;
        float depth = s - sqrt(max(s * s - w * w, 0.0));
        c = vec2(k.x - sgn.x * w, k.y + sgn.y * s);
        a = vec2(k.x - sgn.x * w, k.y);
        b = vec2(k.x, k.y + sgn.y * depth);
    }
    // A pixel into the body: where the flare meets it neither fades out (both faded there, half covered each,
    // showing a faint line across the glass). Its other sides stay: past them is the circle's, or off the screen.
    vec2 into = v < 0.5 ? vec2(-sgn.x, 0.0) : vec2(0.0, -sgn.y);
    vec2 boxLo = min(a, b) + min(into, vec2(0.0));
    vec2 boxHi = max(a, b) + max(into, vec2(0.0));
    float inBox = clamp(min(min(p.x - boxLo.x, boxHi.x - p.x), min(p.y - boxLo.y, boxHi.y - p.y)) + 0.5, 0.0, 1.0);
    return min(inBox, clamp(length(p - c) - s + 0.5, 0.0, 1.0));
}
`;

/** The cut and tone, per pixel: Isle's (glass.js CODE) with its shape made per corner. */
/** The even edge light: about what Isle's gives an edge facing down or straight across, between its brightest
 * (facing the light) and its faintest. */
const EVEN_LIT = '0.45';

const code = effectPoint => `
const float EVEN_LIT = ${EVEN_LIT};
vec2 p = ${effectPoint('vec2(width, height)')};
p.y -= drop;
float cover = clamp(sideRound(p, min(min(p.x - left, right - p.x), min(p.y, bottom - p.y))) + 0.5, 0.0, 1.0);
cover = max(cover, max(max(sideFlare(p, vec2(left, 0.0), vec2(-1.0, -1.0), -corners.x, flares.x, cuts.x),
        sideFlare(p, vec2(right, 0.0), vec2(1.0, -1.0), -corners.y, flares.y, cuts.y)),
    max(sideFlare(p, vec2(right, bottom), vec2(1.0, 1.0), -corners.z, flares.z, cuts.z),
        sideFlare(p, vec2(left, bottom), vec2(-1.0, 1.0), -corners.w, flares.w, cuts.w))));
// The nearest edge: how far in, which way it faces; its effects fade where it turns along the screen's edge.
vec3 edge = sideEdge(p);
vec2 facing = edge.yz;
float fade = sideFade(facing);
if (lens > 0.0) {
    float edgeIn = edge.x;
    if (edgeIn >= 0.0 && edgeIn < band) {
        vec2 n = -facing;
        vec2 shift = n * lens * fade * pow(1.0 - edgeIn / band, 2.0) / (vec2(width, height) + 3.0);
        vec2 uv = cogl_tex_coord_in[0].xy;
        vec4 bent = texture2D(cogl_sampler0, uv + shift);
        cogl_color_out = vec4(texture2D(cogl_sampler0, uv + shift * (1.0 + spread)).r, bent.g,
            texture2D(cogl_sampler0, uv + shift * (1.0 - spread)).b, bent.a) * cogl_color_in;
    }
}
// Past the screen's edge there is nothing to blur: near it the blur took in that emptiness, and its alpha dropped
// (the glass growing clear towards the edge, as far in as the blur reaches). Divided by that alpha, the colour is
// the blur of what is on the screen alone; drawn whole (below), the glass stays as solid up to the edge.
float alpha = max(cogl_color_out.a, 0.0001);
vec3 rgb = cogl_color_out.rgb / alpha;
float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
rgb = lo + span * pow(max(luma, 0.0), gamma) * (1.0 - deep * smoothstep(knee, 1.0, luma)) + (rgb - luma) * span * saturation;
rgb += sheen * (1.0 - clamp(p.y / max(bottom, 1.0), 0.0, 1.0));
float inner = edge.x;
if (inner >= 0.0)
    rgb += glow * fade * exp(-inner / reach) * (0.3 + 0.7 * clamp(p.y / max(bottom, 1.0), 0.0, 1.0));
if (rim > 0.0) {
    float e = edge.x;
    if (e >= 0.0 && e < rimWidth * 8.0) {
        vec2 light = normalize(vec2(-1.0, -1.25));
        // Isle's light, from the top left: an edge facing it lit most, one facing down and right less, one facing down
        // and left hardly at all (a concave corner turning that way fades). Even: every edge lit alike.
        float lit = evenRim > 0.5 ? EVEN_LIT
            : pow(max(dot(facing, light), 0.0), 1.6) + 0.6 * pow(max(dot(facing, -light), 0.0), 1.6);
        rgb += rim * fade * (0.22 + lit) * (exp(-e / rimWidth) + 0.3 * exp(-e / (rimWidth * 3.5)));
    }
}
// wholeAlpha: whole, as the copies under it are (the wallpaper covers all the screen), but for the paint's own
// opacity (the glass fading as a menu closes): as solid up to the screen's edge. Else as the blur has it, thinning
// towards the edge as Isle's own glass does (glass.js).
float shown = wholeAlpha > 0.5 ? cogl_color_in.a : cogl_color_out.a;
cogl_color_out = vec4(clamp(rgb, 0.0, 1.0) * shown, shown) * cover;
`;

/** As Isle's BackdropMask (glass.js): what changed under a resting shape is blurred again at most this often. */
const BACKDROP_FRAME_MS = 33;
const SETTLE_MS = 250;

let MaskClass = null;

/** The class of the mask cutting Isle's blur to a side shape, made once from Isle's `shaderEffect` and `effectPoint`
 * (shader.js). It takes Isle's uniforms as Isle's own mask does, and `corners`, `flares` and `flush`. */
export function sideMask(shaderEffect, effectPoint) {
    if (MaskClass)
        return MaskClass;
    const uniforms = {...Object.fromEntries(ISLE_UNIFORMS.map(name => [name, 1])), corners: 4, flares: 4, flush: 4,
        cuts: 4, evenRim: 1, wholeAlpha: 1};
    const Base = shaderEffect('PanelIslandMask', uniforms, code(effectPoint), FUNCTIONS);
    MaskClass = GObject.registerClass({GTypeName: 'PanelIslandBackdropMask'}, class extends Base {
        _init() {
            super._init();
            this._shapedAt = 0;
            this._blurredAt = 0;
            this._catchUp = 0;
            /** Least time between two blurs of what changed under it while it rests (ms): longer while GNOME
             * animates a scene of its own under it (overview.js), so its blur costs less every frame then. */
            this.frameMs = BACKDROP_FRAME_MS;
        }

        shaped() {
            this._shapedAt = GLib.get_monotonic_time();
        }

        vfunc_paint(node, paintContext, flags) {
            const now = GLib.get_monotonic_time();
            const dirty = flags & Clutter.EffectPaintFlags.ACTOR_DIRTY;
            const resting = now - this._shapedAt > SETTLE_MS * 1000;
            const wait = (this.frameMs ?? BACKDROP_FRAME_MS) * 1000 - (now - this._blurredAt);
            if (dirty && resting && wait > 0 && this._blurredAt) {
                this._queueCatchUp(Math.ceil(wait / 1000));
                super.vfunc_paint(node, paintContext, flags & ~Clutter.EffectPaintFlags.ACTOR_DIRTY);
                return;
            }
            if (dirty)
                this._blurredAt = now;
            super.vfunc_paint(node, paintContext, flags);
        }

        _queueCatchUp(ms) {
            if (this._catchUp)
                return;
            this._catchUp = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
                this._catchUp = 0;
                this.get_actor()?.queue_redraw();
                return GLib.SOURCE_REMOVE;
            });
        }

        stopCatchUp() {
            if (this._catchUp)
                GLib.source_remove(this._catchUp);
            this._catchUp = 0;
        }
    });
    return MaskClass;
}
