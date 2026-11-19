// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Isle's notch corners as smooth as ours: only the corners. Its glass otherwise as Isle draws it (its blur thinning
// towards the screen's edge, its light from the top left). Isle's glass (glass.js) works out its rim, glow and lens from its body
// alone: its shoulders (a notch's concave top corners) left out, the body's side taken on straight up past where it
// curves away into them. A line of rim crosses the glass there, and the shoulders' own glass has none: they look
// drawn on apart. Ours (shape.js sideMask) takes the whole outline, shoulders and all, and fades its rim along the
// screen's top edge.
//
// Done to Isle's own code as it runs, never to its files: the GlassBackdrop class's `place` is wrapped so each of
// Isle's backdrops cuts its blur with our mask, given the shape Isle asks for. Put on only if Isle still has `place`
// and its backdrops their mask; on any failure, that backdrop is given Isle's own mask back; taken off, every one is.

/** Isle's backdrops given our mask: each with Isle's own kept, to give back. */
const swapped = new Set();
/** Settings → Isle's edge blur: solid up to the screen's edge, overriding Isle's own thinning there. */
let solidEdge = false;

/** Isle's glass at the screen's edge: as Isle draws it (thinning into clear glass), or `solid`. Applied at once. */
export function setIsleSolidEdge(solid) {
    solidEdge = Boolean(solid);
    for (const backdrop of swapped) {
        try {
            backdrop._mask?.setUniforms?.({wholeAlpha: solidEdge ? 1 : 0});
        } catch {}
    }
}

/** Our mask in place of Isle's on `backdrop`, Isle's kept. */
function swapIn(backdrop, Mask) {
    const own = backdrop._mask;
    if (!own || typeof backdrop.remove_effect !== 'function')
        throw new Error("Isle's glass has no mask to replace");
    const mask = new Mask();
    backdrop.remove_effect(own);
    backdrop.add_effect(mask);
    backdrop._panelIslandOwnMask = own;
    backdrop._mask = mask;
    swapped.add(backdrop);
    backdrop._panelIslandCornersGoneId ??= backdrop.connect('destroy', () => swapped.delete(backdrop));
}

/**
 * Isle's own mask back on `backdrop`, and all Isle's values sent to it again at once with `place` (Isle's own): Isle
 * sends a mask only the values that changed, and those it sent while ours was in never reached its own, put back
 * without them (the glass clear until something of Isle's next changed).
 */
function giveBack(backdrop, place) {
    const own = backdrop._panelIslandOwnMask;
    if (!own)
        return;
    const mask = backdrop._mask;
    try {
        mask?.stopCatchUp?.();
        if (mask)
            backdrop.remove_effect(mask);
    } catch {}
    backdrop.add_effect(own);
    backdrop._mask = own;
    backdrop._panelIslandOwnMask = null;
    swapped.delete(backdrop);
    const last = backdrop._panelIslandLastPlace;
    if (last && typeof place === 'function') {
        try {
            if (own._values && typeof own._values === 'object')
                own._values = {};
            place.call(backdrop, last);
        } catch (e) {
            console.warn(`[panel-island] Isle's glass could not be redrawn at once: ${e}`);
        }
    }
    backdrop.queue_redraw?.();
}

/**
 * The shape Isle's `place` asks for ({left, right, bottom, radius, crown, shoulder}, as glass.js reads them) as our
 * mask's corners: the bottom ones `radius` round; the top ones `crown` round (a pill), or shoulders flaring along the
 * top (a notch, its top the screen's edge: no rim there, as Isle has none).
 */
export function isleCorners(params) {
    const width = Math.max(0, (params.right ?? 0) - (params.left ?? 0));
    const height = Math.max(0, params.bottom ?? 0);
    const radius = Math.max(0, Math.min(params.radius ?? 0, width / 2, height));
    const crown = Math.max(0, Math.min(params.crown ?? 0, width / 2, height));
    const shoulder = Math.max(0, Math.min(params.shoulder ?? 0, height / 2));
    const top = shoulder > 0 ? -shoulder : crown;
    return {
        corners: [top, top, radius, radius],
        flares: [0, 0, 0, 0],
        cuts: [0, 0, 0, 0],
        flush: [crown > 0 ? 0 : 1, 0, 0, 0],
        // Isle's own light, from the top left.
        evenRim: 0,
        // Isle's own blur at the screen's edge (thinning towards it), or solid up to it (Settings).
        wholeAlpha: solidEdge ? 1 : 0,
    };
}

/**
 * Smooths the corners of Isle's glass: on `proto` (Isle's GlassBackdrop class's prototype), with `Mask` (shape.js
 * sideMask). Our own backdrops (marked `_panelIslandOwn`) are left alone: they set their shape themselves. Returns how
 * to take it off again, or null when Isle has not what this needs (nothing done then).
 */
export function smoothIsleCorners(proto, Mask) {
    const place = proto?.place;
    if (typeof place !== 'function' || typeof Mask !== 'function')
        return null;
    const before = Object.getOwnPropertyDescriptor(proto, 'place');

    proto.place = function (params) {
        let ours = false;
        // Once failed, an island stays as Isle draws it (not tried again every frame).
        if (!this._panelIslandOwn && !this._panelIslandCornersFailed) {
            try {
                if (!this._panelIslandOwnMask)
                    swapIn(this, Mask);
                ours = true;
            } catch (e) {
                console.warn(`[panel-island] Isle's corners left as Isle draws them: ${e}`);
                this._panelIslandCornersFailed = true;
            }
        }
        // Kept, to redraw Isle's own glass at once should its mask be given back.
        this._panelIslandLastPlace = params;
        // Isle's own: its tone, lens and shape uniforms, set on whichever mask is in place. Failing with ours in,
        // Isle's own mask goes back and Isle's place runs again on it: nothing of this ever breaks Isle's own.
        let result;
        try {
            result = place.call(this, params);
        } catch (e) {
            if (!ours)
                throw e;
            console.warn(`[panel-island] Isle's corners given back to Isle: ${e}`);
            this._panelIslandCornersFailed = true;
            try {
                giveBack(this);
            } catch {}
            if (this._mask?._values)
                this._mask._values = {};
            return place.call(this, params);
        }
        if (ours && this._panelIslandOwnMask) {
            try {
                this._mask.setUniforms(isleCorners(params ?? {}));
            } catch (e) {
                console.warn(`[panel-island] Isle's corners given back to Isle: ${e}`);
                this._panelIslandCornersFailed = true;
                try {
                    giveBack(this, place);
                } catch {}
            }
        }
        return result;
    };

    return () => {
        if (before)
            Object.defineProperty(proto, 'place', before);
        else
            delete proto.place;
        for (const backdrop of [...swapped]) {
            try {
                giveBack(backdrop, place);
            } catch (e) {
                console.warn(`[panel-island] Isle's own corners could not be given back: ${e}`);
            }
        }
        swapped.clear();
    };
}
