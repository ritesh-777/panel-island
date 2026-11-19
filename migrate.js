// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings carried over from an older version, once. Used by the extension and its settings window alike (no shell
// imports).

/** The old "Corners: top / bottom / both" choice, as the separate top and bottom corner settings that replace it:
 * "both" is the top the same as the bottom; "bottom" a square top; "top" the old radius for the top only, a square
 * bottom. Done once: the old choice is then reset. */
export function migrate(settings) {
    const old = settings.get_user_value('edge-corners')?.unpack();
    if (!old || old === 'both') {
        if (old)
            settings.reset('edge-corners');
        return;
    }
    const radius = settings.get_int('edge-radius');
    settings.set_boolean('top-same-as-bottom', false);
    if (old === 'bottom') {
        settings.set_int('top-edge-radius', 0);
        settings.set_boolean('top-match-windows', false);
    } else {
        settings.set_int('top-edge-radius', radius);
        settings.set_boolean('top-match-windows', false);
        settings.set_int('edge-radius', 0);
        settings.set_boolean('match-windows', false);
    }
    settings.reset('edge-corners');
}
