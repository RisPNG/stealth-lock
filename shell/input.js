import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class PasswordInput {
    constructor({stealth, onSubmit, onActivity}) {
        this._stealth = stealth;
        this._onActivity = onActivity;
        this.actor = new St.PasswordEntry({
            name: 'stealthLockPasswordInput',
            style_class: stealth ? 'stealth-lock-hidden-input' : 'stealth-lock-password-entry',
            can_focus: true,
            reactive: true,
            show_peek_icon: !stealth,
            x_expand: !stealth,
        });
        this.actor.clutter_text.set_max_length(512);

        if (stealth) {
            this.actor.set_size(1, 1);
            this.actor.opacity = 0;
        }

        this.actor.clutter_text.connectObject(
            'activate', () => onSubmit(),
            'text-changed', () => onActivity(),
            this.actor
        );
    }

    handleEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS) {
            const key = event.get_key_symbol();
            const state = event.get_state();
            const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
            const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
            if (control && !alt && (key === Clutter.KEY_r || key === Clutter.KEY_R)) {
                if (!this._stealth && !St.Settings.get().disable_show_password)
                    this.actor.password_visible = !this.actor.password_visible;
                return Clutter.EVENT_STOP;
            }
            if (control && !alt && (key === Clutter.KEY_u || key === Clutter.KEY_U)) {
                this.discardPassword();
                return Clutter.EVENT_STOP;
            }
            if ((state & Clutter.ModifierType.SHIFT_MASK) && key === Clutter.KEY_Insert)
                return Clutter.EVENT_STOP;
            if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R ||
                (state & (Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.META_MASK)) || control)
                return Clutter.EVENT_STOP;
            if (alt && event.get_key_unicode() === 0)
                return Clutter.EVENT_STOP;
            this.actor.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.KEY_RELEASE) {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R || key === Clutter.KEY_Meta_L || key === Clutter.KEY_Meta_R)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.IM_COMMIT || type === Clutter.EventType.IM_DELETE || type === Clutter.EventType.IM_PREEDIT)
            return Clutter.EVENT_PROPAGATE;
        if ((type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE) &&
            event.get_button() === 1 && !this._stealth && !St.Settings.get().disable_show_password) {
            const source = event.get_source();
            const peek = this.actor.get_secondary_icon();
            if (peek && source && (source === peek || peek.contains(source)))
                return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    takePassword() {
        const password = this.actor.text;
        this.discardPassword();
        return password;
    }

    discardPassword() {
        const stage = this.actor.get_stage();
        const focus = stage?.get_key_focus();
        const focused = focus && (focus === this.actor || this.actor.contains(focus));
        if (focused)
            stage.set_key_focus(null);
        this.actor.text = '';
        this.actor.password_visible = false;
        this._onActivity();
        if (focused)
            this.actor.grab_key_focus();
    }

    destroy() {
        this.actor.clutter_text.disconnectObject(this.actor);
        this.discardPassword();
        this.actor.destroy();
    }
}
