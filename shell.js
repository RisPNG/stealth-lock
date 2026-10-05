import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function handoffToSystemLock() {
    Main.screenShield.lock(false);
    return Main.screenShield.locked && Main.screenShield.active;
}

export function watchSystemLock(onChanged) {
    const shield = Main.screenShield;
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
