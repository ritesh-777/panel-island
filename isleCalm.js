// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Isle without bounce: Isle's island grows and shrinks on springs (spring.js) that overshoot a little and
// spring back. With this on, they are damped just enough not to overshoot (critically, as Isle's own corners already
// are): as quick to arrive, no going past and back. Done to Isle as it runs and never to its files; only the springs
// the island's driver moves (`SpringDriver`) are changed, Isle's other springs (its drop light's swell) left as they
// are; taken off as it was.

let calming = 0;
const calmed = new WeakMap();

/** The config `config` damped just enough not to overshoot, or `config` itself if it already does not. */
function calm(config) {
    const stiffness = config?.stiffness, damping = config?.damping;
    if (!Number.isFinite(stiffness) || !Number.isFinite(damping) || stiffness <= 0)
        return config;
    const critical = 2 * Math.sqrt(stiffness);
    if (damping >= critical)
        return config;
    let done = calmed.get(config);
    if (!done) {
        done = {...config, damping: critical};
        calmed.set(config, done);
    }
    return done;
}

/** Puts it on (`Spring`, `SpringDriver`: Isle's classes from spring.js). Returns how to take it off, or null if Isle
 * no longer has what it changes. */
export function calmIsle({Spring, SpringDriver} = {}) {
    const springs = Spring?.prototype, drivers = SpringDriver?.prototype;
    if (typeof springs?.step !== 'function' || typeof drivers?._tick !== 'function')
        return null;
    const savedStep = Object.getOwnPropertyDescriptor(springs, 'step');
    const savedTick = Object.getOwnPropertyDescriptor(drivers, '_tick');
    const step = savedStep.value, tick = savedTick.value;

    drivers._tick = function (...args) {
        calming++;
        try {
            return tick.apply(this, args);
        } finally {
            calming--;
        }
    };
    springs.step = function (...args) {
        if (!calming)
            return step.apply(this, args);
        const own = this.config;
        const quiet = calm(own);
        if (quiet === own)
            return step.apply(this, args);
        this.config = quiet;
        try {
            return step.apply(this, args);
        } finally {
            // Isle may have retargeted it with a config of its own meanwhile: that one kept.
            if (this.config === quiet)
                this.config = own;
        }
    };
    return () => {
        Object.defineProperty(springs, 'step', savedStep);
        Object.defineProperty(drivers, '_tick', savedTick);
    };
}
