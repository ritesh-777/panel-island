// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// The light glass, one for all Panel Island draws light: its capsules and menus, and Isle's island under Settings →
// Light Isle (isleLight.js), so they look alike. Frosted, what is behind still showing through: blurred, its lightness
// lifted into lo + span × l (Isle's glass.js; never held darker), most of its colour kept, under a thin white frost.
// Glass strength (`tint`, 0 clear to 100 frosted) only frosts it a little more: the blur already grows with it.

const clamp = t => Math.min(1, Math.max(0, t));

/** Isle's glass toning (`blur`, theme.js) made light, at Glass strength `tint`. */
export function lightBlur(blur, tint = 0) {
    if (!blur)
        return blur;
    const t = clamp(tint / 100);
    return {
        ...blur, brightness: 1, lo: 0.32 + 0.1 * t, span: 0.66 - 0.1 * t, gamma: 0.9, deep: 0, knee: 0,
        small: 1 - 0.1 * t, large: 1.05 - 0.1 * t, sheen: 0.04, glow: 0.05 - 0.01 * t, rim: (blur.rim ?? 0) * 0.6,
    };
}

/** The white frost over it, as RGBA in 0..1, at Glass strength `tint`. */
export function lightFill(tint = 0) {
    return [1, 1, 1, 0.16 + 0.12 * clamp(tint / 100)];
}

/** Its hairline: faint and dark. */
export const LIGHT_EDGE = {color: [0, 0, 0], top: 0.08, bottom: 0.14};
