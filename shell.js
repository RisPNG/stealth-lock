import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function restoreWhenShellReady(restore, owner) {
    const layout = Main.layoutManager;
    let idleId = 0;
    if (layout._startingUp) {
        layout.connectObject('startup-complete', () => {
            layout.disconnectObject(owner);
            idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                idleId = 0;
                restore();
                return GLib.SOURCE_REMOVE;
            });
        }, owner);
    } else {
        restore();
    }
    return () => {
        layout.disconnectObject(owner);
        if (idleId)
            GLib.Source.remove(idleId);
    };
}

export function handoffToSystemLock() {
    const shield = Main.screenShield;
    if (!shield)
        return false;
    shield.lock(false);
    return shield.locked && shield.active;
}

export function watchSystemLock(onChanged) {
    const shield = Main.screenShield;
    if (!shield)
        return () => {};
    const lockedId = shield.connect('locked-changed', () => {
        if (shield.locked || !shield.active)
            onChanged(shield.locked);
    });
    const activeId = shield.connect('active-changed', () => {
        if (shield.locked || !shield.active)
            onChanged(shield.locked);
    });
    return () => {
        shield.disconnect(activeId);
        shield.disconnect(lockedId);
    };
}
