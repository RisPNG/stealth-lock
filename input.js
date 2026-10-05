import St from 'gi://St';

export class PasswordInput {
    constructor({stealth, onSubmit, onActivity}) {
        this._onActivity = onActivity;
        this.actor = new St.PasswordEntry({
            name: 'stealthLockPasswordInput',
            style_class: stealth ? 'stealth-lock-hidden-input' : 'stealth-lock-password-entry',
            can_focus: true,
            reactive: true,
            show_peek_icon: !stealth,
            x_expand: !stealth,
        });

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
