// SPDX-License-Identifier: GPL-3.0-or-later
//
// The top bar's colour while Isle is off (Settings → Top bar). Isle on colours the bar itself (from glass to black,
// its text white); turned off, it hands the bar back to the theme. This keeps it as it was: the same see-through or
// black bar round the capsules. Only one declaration of the bar's style is ours, added and taken off by its text, so
// what the theme or another extension (Isle included) writes there is left as it is.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Isle's own: under this opacity (%) the bar's text casts a shadow, to read on a light wallpaper. */
const SHADOW_BELOW = 50;
const BAR_CLASS = 'panel-island-bar';
const GLASS_BAR_CLASS = 'panel-island-glass-bar';

let ours = null;
/** Our opacity now, or null; and when we put it back after others took it off (see `keepBar`). */
let wanted = null;
let restores = [];
let yielded = false;
let writing = false;
/** Past this many times a second, another extension is fighting over the bar's style: we stop putting ours back. */
const MAX_RESTORES_PER_SECOND = 5;

/** Black at `opacity` %, as one declaration. */
function rule(opacity) {
    if (opacity <= 0)
        return 'background-color: transparent;';
    return opacity >= 100 ? 'background-color: #000000;' : `background-color: rgba(0, 0, 0, ${opacity / 100});`;
}

/** The bar's style without our declaration. */
function without(style) {
    if (!ours || !style)
        return style ?? '';
    const at = style.lastIndexOf(ours);
    return at < 0 ? style : (style.slice(0, at) + style.slice(at + ours.length)).trim();
}

/** Colours the bar black at `opacity` % (0 see-through, 100 black), or with null gives it back to the theme. */
export function setBar(opacity) {
    wanted = opacity;
    yielded = false;
    restores = [];
    apply(opacity);
}

/** Puts our colour back if the bar's style lost it; gives up on a fight. GNOME's overview sets the bar's whole style
 * as it opens and closes (overview.js: its transition, then none), and the shell starts in it at login. */
function keep() {
    if (writing || wanted === null || yielded)
        return;
    const style = Main.panel.get_style() ?? '';
    if (ours && style.includes(ours))
        return;
    const now = Date.now();
    restores = restores.filter(at => now - at < 1000);
    restores.push(now);
    if (restores.length > MAX_RESTORES_PER_SECOND) {
        yielded = true;
        console.warn("[panel-island] Another extension keeps changing the top bar's style: its colour is left to it");
        return;
    }
    ours = null;
    apply(wanted);
}

/** Follows the bar's style while on; `false` stops. */
export function keepBar(on) {
    Main.panel.disconnectObject(KEEPER);
    if (on)
        Main.panel.connectObject('notify::style', () => keep(), KEEPER);
}
const KEEPER = {};

function apply(opacity) {
    const panel = Main.panel;
    const base = without(panel.get_style());
    ours = opacity === null ? null : rule(opacity);
    const style = ours ? `${base}${base && !base.endsWith(';') ? ';' : ''}${base ? ' ' : ''}${ours}` : base;
    if (style !== (panel.get_style() ?? '')) {
        writing = true;
        try {
            panel.set_style(style || null);
        } finally {
            writing = false;
        }
    }
    const set = (name, on) => on ? panel.add_style_class_name(name) : panel.remove_style_class_name(name);
    set(BAR_CLASS, opacity !== null);
    set(GLASS_BAR_CLASS, opacity !== null && opacity < SHADOW_BELOW);
}
