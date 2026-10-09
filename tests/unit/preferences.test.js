import assert from 'node:assert/strict';
import test from 'node:test';
import {compileFunction} from 'node:vm';

import * as Presets from '../../shared/presets.js';
import {Cancellable, deferred, loadModule} from './harness.js';

async function preferencesWindow({values = {}, autoResetRange = [0, 3600], monitors = []} = {}) {
    const widgets = [];
    class Widget {
        constructor(properties = {}) {
            this.handlers = new Map();
            this.nextId = 1;
            this.children = [];
            this.sensitive = true;
            widgets.push(this);
            Object.assign(this, properties);
        }
        connect(signal, callback) {
            const id = this.nextId++;
            this.handlers.set(id, {signal, callback});
            return id;
        }
        disconnect(id) { this.handlers.delete(id); }
        emit(signal, ...args) {
            for (const handler of [...this.handlers.values()]) {
                if (handler.signal === signal && !handler.blocked)
                    handler.callback(this, ...args);
            }
        }
        block_signal_handler(id) { this.handlers.get(id).blocked = true; }
        unblock_signal_handler(id) { this.handlers.get(id).blocked = false; }
        add(child) { this.children.push(child); }
        add_suffix(child) { this.children.push(child); }
        set_default_size() {}
        get active() { return this._active ?? false; }
        set active(value) {
            if (value !== this.active) {
                this._active = value;
                this.emit('notify::active');
            }
        }
        get selected() { return this._selected ?? 0; }
        set selected(value) {
            if (value !== this.selected) {
                this._selected = value;
                this.emit('notify::selected');
            }
        }
        get value() { return this._value ?? 0; }
        set value(value) {
            if (value !== this.value) {
                this._value = value;
                this.emit('notify::value');
            }
        }
        get text() { return this._text ?? ''; }
        set text(value) {
            if (value !== this.text) {
                this._text = value;
                this.emit('notify::text');
            }
        }
        destroy() { this.destroyed = true; }
    }
    const enumValues = {
        'cursor-mode': ['lock-icon', 'normal', 'hidden'],
        'authentication-mode': ['password', 'system'],
        'lock-type': ['stealth', 'normal'],
        'normal-prompt-cursor-anchor': ['br', 'tr', 'tl', 'bl'],
    };
    const current = {
        'visual-effect-initialized': true,
        'visual-effect-presets': '[]',
        'visual-effect-active': '',
        'lock-hotkey': ['<Super>l'],
        'debug-mode': false,
        'debug-show-info': false,
        'debug-abort-use-lock-hotkey': false,
        'debug-abort-hotkey': ['<Control>u'],
        'freeze-display': true,
        'pause-media': true,
        'auto-reset-seconds': 5,
        'authentication-mode': 'password',
        'pam-service': 'gdm-password',
        'retry-base-seconds': 1,
        'retry-max-seconds': 30,
        'password-reveal-timeout-seconds': 10,
        'password-audible-feedback': false,
        'cursor-mode': 'lock-icon',
        'lock-type': 'stealth',
        'normal-prompt-follow-cursor': false,
        'normal-prompt-cursor-anchor': 'br',
        'normal-prompt-monitor': '',
        'normal-prompt-offset-x': 12,
        'normal-prompt-offset-y': 12,
        'normal-prompt-fixed-x': -1,
        'normal-prompt-fixed-y': -1,
        'cursor-bitmap-path': '',
        'cursor-fg-rgba': [0, 0, 0, 255],
        'cursor-bg-rgba': [255, 255, 255, 255],
        ...values,
    };
    const settings = new Widget();
    const bindings = [];
    settings.settings_schema = {get_key: key => ({get_range: () => ({recursiveUnpack: () => [
        'range', {'auto-reset-seconds': autoResetRange, 'retry-base-seconds': [1, 30],
            'retry-max-seconds': [1, 300], 'password-reveal-timeout-seconds': [0, 300]}[key] ?? [-2147483648, 2147483647],
    ]})})};
    settings.get_string = settings.get_boolean = settings.get_strv = key => current[key];
    settings.get_enum = key => enumValues[key].indexOf(current[key]);
    settings.get_value = key => ({deep_unpack: () => current[key]});
    settings.set_string = settings.set_boolean = settings.set_strv = (key, value) => {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
            current[key] = value;
            settings.emit('changed', key);
        }
    };
    settings.set_enum = (key, value) => settings.set_string(key, enumValues[key][value]);
    settings.bind = (key, row, property, flags) => {
        bindings.push({key, row, property, flags});
        row[property] = current[key];
        settings.connect('changed', (_settings, changedKey) => {
            if (changedKey === key)
                row[property] = current[key];
        });
        if (!(flags & 1))
            row.connect('notify::' + property, () => settings.set_string(key, row[property]));
    };
    class Names {
        constructor(items) { this.items = items; }
        get_n_items() { return this.items.length; }
        append(item) { this.items.push(item); }
        splice(position, removed, additions) { this.items.splice(position, removed, ...additions); }
    }
    const {default: Preferences} = await loadModule('prefs.js', {
        'gi://Adw': {default: {
            PreferencesPage: Widget, PreferencesGroup: Widget, ActionRow: Widget,
            SwitchRow: Widget, SpinRow: Widget, ComboRow: Widget, EntryRow: Widget,
        }},
        'gi://Gdk': {default: {
            RGBA: Widget, Display: {get_default: () => ({get_monitors: () => ({get_n_items: () => monitors.length,
                get_item: index => ({get_connector: () => monitors[index].connector, get_model: () => monitors[index].model})})})},
        }},
        'gi://Gio': {default: {Cancellable, SettingsBindFlags: {DEFAULT: 0, GET: 1, NO_SENSITIVITY: 4}}},
        'gi://GLib': {default: {}},
        'gi://Gtk': {default: {
            ShortcutLabel: Widget, Button: Widget, Adjustment: Widget, ColorDialogButton: Widget,
            ColorDialog: Widget, StringList: {new: items => new Names(items)}, Align: {CENTER: 3},
        }},
        './shared/presets.js': Presets,
        './shared/visual-process.js': {VisualProcess: class {}},
        'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js': {ExtensionPreferences: class {},
            gettext: value => value.includes('%s') ? {format: replacement => value.replace('%s', replacement)} : value},
    });
    const preferences = new Preferences();
    preferences.getSettings = () => settings;
    const window = new Widget();
    preferences.fillPreferencesWindow(window);
    return {preferences, window, settings, current, bindings, widgets, row: title => widgets.find(widget => widget.title === title)};
}

async function editor({key = 'visual-effect-active', library = '[]', active = '', pauseChecks = false} = {}) {
    const workers = [];
    const checks = [];
    class VisualProcess {
        constructor(path, parent) {
            parent.set_error_if_cancelled();
            this.path = path;
            this.parent = parent;
            this.closed = false;
            this.parentSignal = parent.connect(() => this.destroy());
            workers.push(this);
        }
        async request(frame) {
            assert.equal(frame.event, 'check');
            compileFunction(frame.code, ['ctx']);
            if (pauseChecks) {
                this.pending = deferred();
                checks.push(this.pending);
                await this.pending.promise;
            }
            if (this.closed)
                throw new Error('visual check cancelled');
            return {valid: true};
        }
        destroy() {
            if (!this.closed) {
                this.closed = true;
                this.parent.disconnect(this.parentSignal);
                this.pending?.reject(new Error('visual check cancelled'));
            }
        }
    }
    class Widget {
        constructor(properties = {}) {
            this.handlers = new Map();
            this.children = [];
            this.sensitive = true;
            this.visible = true;
            Object.assign(this, properties);
        }
        connect(signal, callback) {
            if (!this.handlers.has(signal))
                this.handlers.set(signal, []);
            this.handlers.get(signal).push(callback);
        }
        emit(signal, ...args) {
            return Promise.all((this.handlers.get(signal) ?? []).map(callback => callback(this, ...args)));
        }
        append(child) { this.children.push(child); }
        set_child(child) { this.children = [child]; }
        set_margin_top() {}
        set_margin_bottom() {}
        set_margin_start() {}
        set_margin_end() {}
        set_spacing() {}
        add_css_class(name) {
            this.css_classes ??= [];
            if (!this.css_classes.includes(name))
                this.css_classes.push(name);
        }
        remove_css_class(name) { this.css_classes = this.css_classes?.filter(value => value !== name) ?? []; }
        get text() { return this._text ?? ''; }
        set text(value) { this._text = value; this.emit('changed'); }
        destroy() { this.destroyed = true; }
        set_visible(value) { this.visible = value; }
    }
    class Names {
        constructor(values) { this.values = values; this.selectors = new Set(); }
        get_n_items() { return this.values.length; }
        splice(position, removed, additions) {
            this.values.splice(position, removed, ...additions);
            for (const selector of this.selectors)
                selector.emit('notify::selected-item');
        }
    }
    class Selector extends Widget {
        constructor(properties) {
            super(properties);
            this._selected = properties.selected ?? (properties.model.values.length ? 0 : 0xffffffff);
            this.model.selectors.add(this);
        }
        get selected() { return this._selected; }
        set selected(value) { this._selected = value; this.emit('notify::selected-item'); }
    }
    class Buffer extends Widget {
        set_text(text) { this.text = text; }
        get_text() { return this.text; }
        get_start_iter() { return 0; }
        get_end_iter() { return this.text.length; }
    }
    class TextView extends Widget {
        constructor(properties) { super(properties); this.buffer = new Buffer(); }
        get_buffer() { return this.buffer; }
    }
    class Dialog extends Widget {
        constructor(properties) { super(properties); this.content = new Widget(); this.children.push(this.content); }
        get_content_area() { return this.content; }
        add_button(label, response) {
            const button = new Widget({label, response});
            this.children.push(button);
            return button;
        }
        response(value) { return this.emit('response', value); }
    }
    const Gtk = {
        Dialog, Label: Widget, Entry: Widget, Box: Widget, Button: Widget, DropDown: Selector,
        ScrolledWindow: Widget, TextView, StringList: {new: values => new Names(values)},
        Orientation: {HORIZONTAL: 0}, WrapMode: {NONE: 0}, ResponseType: {CANCEL: -6, OK: -5},
        INVALID_LIST_POSITION: 0xffffffff,
        Align: {START: 0},
    };
    const {default: Preferences} = await loadModule('prefs.js', {
        'gi://Adw': {default: {}}, 'gi://Gdk': {default: {}}, 'gi://Gio': {default: {Cancellable}},
        'gi://GLib': {default: {}}, 'gi://Gtk': {default: Gtk}, './shared/presets.js': Presets,
        './shared/visual-process.js': {VisualProcess},
        'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js': {ExtensionPreferences: class {}, gettext: value => value},
    }, {console: {error() {}}});
    const entriesKey = key === 'visual-effect-active' ? 'visual-effect-presets' : key + '-saved-entries';
    const values = {[entriesKey]: library, [key]: active};
    const writes = [];
    const settings = {
        get_string: name => values[name],
        set_string(name, value) { values[name] = value; writes.push([name, value]); },
    };
    const preferences = new Preferences();
    preferences._dialogs = new Set();
    preferences._cancellable = new Cancellable();
    preferences.path = '/installed-extension';
    preferences._showSavedEntryEditor({}, settings, key, 'Test', 'Saved entries');
    const dialog = [...preferences._dialogs][0];
    const widgets = [];
    const visit = widget => { widgets.push(widget); widget.children.forEach(visit); };
    visit(dialog);
    const button = label => widgets.find(widget => widget.label === label && widget instanceof Widget);
    return {
        preferences, dialog, values, writes, entriesKey, workers, checks,
        buffer: widgets.find(widget => widget instanceof TextView).buffer,
        selector: widgets.find(widget => widget instanceof Selector),
        name: widgets.find(widget => widget.placeholder_text === 'Saved entry name'),
        validation: widgets.find(widget => widget.css_classes?.includes('error')),
        button,
        click(label) { assert.equal(button(label).sensitive, true, label + ' should be usable'); return button(label).emit('clicked'); },
        apply() { return dialog.response(Gtk.ResponseType.OK); },
        cancel() { return dialog.response(Gtk.ResponseType.CANCEL); },
    };
}

test('prompt controls follow the same normal and cursor-position policy on opening and changes', async () => {
    const state = await preferencesWindow();
    const titles = ['Follow Cursor', 'Cursor Anchor', 'Monitor', 'Cursor Offset X', 'Cursor Offset Y', 'Fixed X', 'Fixed Y'];
    const availability = () => titles.map(title => state.row(title).sensitive);
    assert.deepEqual(availability(), [false, false, false, false, false, false, false]);

    state.row('Lock Type').selected = 1;
    assert.deepEqual(availability(), [true, false, true, false, false, true, true]);
    state.row('Follow Cursor').active = true;
    assert.deepEqual(availability(), [true, true, false, true, true, false, false]);
    state.settings.set_string('lock-type', 'stealth');
    assert.deepEqual(availability(), [false, false, false, false, false, false, false]);
    assert.equal(state.current['normal-prompt-follow-cursor'], true, 'hiding controls preserves the position choice');
    state.settings.set_string('lock-type', 'normal');
    assert.deepEqual(availability(), [true, true, false, true, true, false, false]);
    state.settings.set_boolean('normal-prompt-follow-cursor', false);
    assert.deepEqual(availability(), [true, false, true, false, false, true, true]);
    state.window.emit('close-request');

    const reopened = await preferencesWindow({values: {'lock-type': 'normal', 'normal-prompt-follow-cursor': true}});
    assert.deepEqual(titles.map(title => reopened.row(title).sensitive), [true, true, false, true, true, false, false]);
    reopened.window.emit('close-request');
});

test('debug controls use native sensitivity bindings and preserve the custom abort shortcut', async () => {
    const state = await preferencesWindow();
    const info = state.row('Show Debug Info');
    const shared = state.row('Abort Hotkey = Activation Hotkey');
    const abort = state.row('Abort Hotkey (Debug)');
    const availability = () => [info.sensitive, shared.sensitive, abort.sensitive];
    assert.deepEqual(availability(), [false, false, false]);
    for (const row of [info, shared]) {
        const binding = state.bindings.find(item => item.row === row && item.property === 'sensitive');
        assert.equal(binding.key, 'debug-mode');
        assert.equal(binding.flags, 5, 'sensitivity follows the setting without writing it or rebinding writability');
    }

    state.row('Enable Debug Mode').active = true;
    assert.deepEqual(availability(), [true, true, true]);
    shared.active = true;
    assert.deepEqual(availability(), [true, true, false]);
    assert.deepEqual(state.current['debug-abort-hotkey'], ['<Control>u']);
    assert.equal(abort.children[0].accelerator, '<Super>l');
    state.settings.set_strv('lock-hotkey', ['<Super>k']);
    assert.deepEqual(state.current['debug-abort-hotkey'], ['<Control>u']);
    assert.equal(abort.children[0].accelerator, '<Super>k');
    state.settings.set_strv('debug-abort-hotkey', ['<Control>i']);
    assert.equal(abort.children[0].accelerator, '<Super>k');
    shared.active = false;
    assert.deepEqual(availability(), [true, true, true]);
    assert.deepEqual(state.current['debug-abort-hotkey'], ['<Control>i']);
    assert.equal(abort.children[0].accelerator, '<Control>i');
    state.settings.set_boolean('debug-mode', false);
    assert.deepEqual(availability(), [false, false, false]);
    state.window.emit('close-request');

    const reopened = await preferencesWindow({values: {'debug-mode': true, 'debug-abort-use-lock-hotkey': true}});
    assert.equal(reopened.row('Show Debug Info').sensitive, true);
    assert.equal(reopened.row('Abort Hotkey = Activation Hotkey').sensitive, true);
    assert.equal(reopened.row('Abort Hotkey (Debug)').sensitive, false);
    assert.equal(reopened.row('Abort Hotkey (Debug)').children[0].accelerator, '<Super>l');
    reopened.window.emit('close-request');
});

test('spin rows honor schema ranges and window closure cancels owned dialogs and settings notifications', async () => {
    const state = await preferencesWindow({autoResetRange: [2, 42]});
    const autoReset = state.row('Auto Reset (seconds)');
    assert.equal(autoReset.adjustment.lower, 2);
    assert.equal(autoReset.adjustment.upper, 42);
    assert.equal(autoReset.value, 5);
    autoReset.value = 20;
    assert.equal(state.current['auto-reset-seconds'], 20);
    for (const title of ['Cursor Offset X', 'Cursor Offset Y', 'Fixed X', 'Fixed Y']) {
        assert.equal(state.row(title).adjustment.lower, -2147483648);
        assert.equal(state.row(title).adjustment.upper, 2147483647);
    }

    let destroyed = false;
    state.preferences._dialogs.add({destroy() { destroyed = true; }});
    const settingsListeners = state.settings.handlers.size;
    state.window.emit('close-request');
    assert.equal(state.preferences._cancellable.is_cancelled(), true);
    assert.equal(destroyed, true);
    assert.equal(state.preferences._dialogs.size, 0);
    assert.equal(state.settings.handlers.size, settingsListeners - 1, 'the preferences-owned changed listener is disconnected');
});

test('authentication service retry reveal and audible preferences persist through native settings bindings', async () => {
    const state = await preferencesWindow();
    assert.equal(state.row('Authentication').selected, 0);
    state.row('Authentication').selected = 1;
    assert.equal(state.current['authentication-mode'], 'system');
    state.settings.set_string('authentication-mode', 'password');
    assert.equal(state.row('Authentication').selected, 0);
    assert.equal(state.row('Password PAM Service').text, 'gdm-password');
    state.row('Password PAM Service').text = 'system-local-login';
    assert.equal(state.current['pam-service'], 'system-local-login');
    for (const [title, key, initial, range, changed] of [
        ['Initial Retry Delay', 'retry-base-seconds', 1, [1, 30], 7],
        ['Maximum Retry Delay', 'retry-max-seconds', 30, [1, 300], 100],
        ['Reveal Timeout', 'password-reveal-timeout-seconds', 10, [0, 300], 0],
    ]) {
        const row = state.row(title);
        assert.equal(row.value, initial);
        assert.deepEqual([row.adjustment.lower, row.adjustment.upper], range);
        row.value = changed;
        assert.equal(state.current[key], changed);
    }
    assert.equal(state.row('Audible Authentication Feedback').active, false);
    state.row('Audible Authentication Feedback').active = true;
    assert.equal(state.current['password-audible-feedback'], true);
    state.window.emit('close-request');
    const reopened = await preferencesWindow({values: state.current});
    assert.equal(reopened.row('Password PAM Service').text, 'system-local-login');
    assert.equal(reopened.row('Initial Retry Delay').value, 7);
    assert.equal(reopened.row('Maximum Retry Delay').value, 100);
    assert.equal(reopened.row('Reveal Timeout').value, 0);
    assert.equal(reopened.row('Audible Authentication Feedback').active, true);
    reopened.window.emit('close-request');
});

test('monitor selection stores stable connectors instead of the current display index', async () => {
    const state = await preferencesWindow({monitors: [
        {connector: 'DP-1', model: 'Primary display'}, {connector: 'HDMI-A-1', model: 'Secondary display'},
    ], values: {'normal-prompt-monitor': 'HDMI-A-1'}});
    assert.equal(state.row('Monitor').selected, 2);
    state.row('Monitor').selected = 1;
    assert.equal(state.current['normal-prompt-monitor'], 'DP-1');
    state.settings.set_string('normal-prompt-monitor', 'DP-7');
    assert.equal(state.row('Monitor').selected, 3);
    assert.equal(state.current['normal-prompt-monitor'], 'DP-7');
    assert.equal(state.row('Monitor').model.items[3], 'Monitor DP-7 (disconnected)');
    state.window.emit('close-request');
    const reordered = await preferencesWindow({monitors: [
        {connector: 'HDMI-A-1', model: 'Secondary display'}, {connector: 'DP-1', model: 'Primary display'},
    ], values: {'normal-prompt-monitor': 'DP-1'}});
    assert.equal(reordered.row('Monitor').selected, 2);
    assert.equal(reordered.current['normal-prompt-monitor'], 'DP-1');
    reordered.window.emit('close-request');
});

test('window cancellation kills an in-progress syntax checker and ignores its completion', async () => {
    const state = await editor({pauseChecks: true});
    const checking = state.click('Check JavaScript');
    assert.equal(state.workers.length, 1);
    assert.equal(state.button('Check JavaScript').sensitive, false);
    state.preferences._cancellable.cancel();
    state.dialog.destroy();
    state.preferences._dialogs.clear();
    await checking;
    assert.equal(state.workers[0].closed, true);
    assert.deepEqual(state.writes, []);
    assert.equal(state.preferences._cancellable.handlers.size, 0);
});

test('cancelling Apply releases its checker and never selects a program after the editor closes', async () => {
    const state = await editor({pauseChecks: true});
    state.name.text = 'New program';
    const applying = state.apply();
    assert.equal(state.workers.length, 1);
    assert.equal(state.button('Apply').sensitive, false);
    await state.cancel();
    await applying;
    assert.ok(state.workers.every(worker => worker.closed));
    assert.deepEqual(state.writes, []);
    assert.equal(state.preferences._dialogs.size, 0);
});

test('starter presets use the same editable, renamable and deletable flow as user presets', async () => {
    const state = await editor({library: JSON.stringify(Presets.DEFAULT_EFFECT_PRESETS), active: 'Neo Rain'});
    assert.equal(state.selector.selected, 1);
    state.buffer.set_text('ctx.blur(4);');
    state.click('Replace Saved');
    assert.equal(JSON.parse(state.values[state.entriesKey])[1].code, 'ctx.blur(4);');
    state.name.text = 'My edited preset';
    state.click('Rename');
    assert.equal(state.values['visual-effect-active'], 'My edited preset');
    assert.equal(JSON.parse(state.values[state.entriesKey])[1].name, 'My edited preset');
    state.click('Delete');
    assert.equal(state.values['visual-effect-active'], '');
    assert.deepEqual(JSON.parse(state.values[state.entriesKey]).map(entry => entry.name), ['Dim and Blur', 'City Grow']);
    await state.cancel();
    assert.equal(state.preferences._dialogs.size, 0);
    assert.equal(state.dialog.destroyed, true);
});

test('invalid JavaScript syntax keeps the editor open and cannot activate or replace a program through Apply', async () => {
    const library = JSON.stringify([{name: 'Rain', code: 'ctx.draw.paint();'}]);
    const state = await editor({library});
    for (const code of ['if (', 'const missing = ;']) {
        state.buffer.set_text(code);
        assert.equal(state.validation.visible, false, 'typing permits unfinished draft syntax');
        assert.equal(state.button('Save As New').sensitive, true);
        assert.equal(state.button('Replace Saved').sensitive, true);
        await state.click('Check JavaScript');
        assert.equal(state.validation.visible, true);
        assert.equal(state.validation.css_classes.includes('error'), true);
        await state.apply();
        assert.equal(state.values[state.entriesKey], library);
        assert.equal(state.values['visual-effect-active'], '');
        assert.equal(state.dialog.destroyed, undefined);
    }
    state.buffer.set_text('ctx.clock({visible:true});');
    assert.equal(state.validation.visible, false);
    await state.apply();
    assert.equal(state.values['visual-effect-active'], 'Rain');
    assert.equal(JSON.parse(state.values[state.entriesKey])[0].code, 'ctx.clock({visible:true});');
    assert.equal(state.preferences._dialogs.size, 0);
    assert.ok(state.workers.every(worker => worker.closed));
});

test('empty NUL and oversized JavaScript text cannot be saved or sent to the compiler', async () => {
    const state = await editor();
    for (const code of ['', '\0', 'x'.repeat(512 * 1024 + 1)]) {
        state.buffer.set_text(code);
        assert.equal(state.validation.visible, true);
        assert.equal(state.button('Apply').sensitive, false);
        assert.equal(state.button('Save As New').sensitive, false);
        assert.equal(state.button('Replace Saved').sensitive, false);
        await state.apply();
        assert.equal(state.values[state.entriesKey], '[]');
        assert.equal(state.values['visual-effect-active'], '');
        assert.equal(state.workers.length, 0);
    }
    await state.cancel();
});

test('Check verifies syntax without running source or changing saved entries and selection', async () => {
    const state = await editor();
    state.buffer.set_text('throw new Error("this must not run");');
    await state.click('Check JavaScript');
    assert.equal(state.validation.label, 'JavaScript syntax is valid');
    assert.equal(state.validation.css_classes.includes('error'), false);
    assert.equal(state.workers[0].path, '/installed-extension');
    assert.equal(state.workers[0].closed, true);
    assert.deepEqual(state.writes, []);
    assert.equal(state.button('Check JavaScript').sensitive, true);
    await state.cancel();
});

test('a pending Check disables editing and Apply until its own checker has completed', async () => {
    const state = await editor({pauseChecks: true});
    const checking = state.click('Check JavaScript');
    assert.equal(state.button('Apply').sensitive, false);
    assert.equal(state.dialog.content.sensitive, false);
    await state.apply();
    assert.equal(state.workers.length, 1, 'disabled Apply must not replace the current checker');
    state.checks[0].resolve();
    await checking;
    assert.equal(state.workers[0].closed, true);
    assert.equal(state.button('Apply').sensitive, true);
    assert.equal(state.dialog.content.sensitive, true);
    const applying = state.apply();
    assert.equal(state.workers.length, 2);
    state.checks[1].resolve();
    await applying;
    assert.equal(state.values['visual-effect-active'], 'New effect');
    assert.equal(state.dialog.destroyed, true);
    assert.ok(state.workers.every(worker => worker.closed));
});

test('ordinary saved entries may retain unfinished syntax drafts while activation remains independently checked', async () => {
    const state = await editor();
    state.name.text = 'Work in progress';
    state.buffer.set_text('if (');
    await state.click('Save As New');
    assert.deepEqual(JSON.parse(state.values[state.entriesKey]), [{name: 'Work in progress', code: 'if ('}]);
    assert.equal(state.values['visual-effect-active'], '');
    await state.apply();
    assert.equal(state.dialog.destroyed, undefined);
    assert.equal(state.values['visual-effect-active'], '');
    await state.cancel();
});

test('malformed CSS and effect libraries retain their original stored values', async t => {
    for (const key of ['normal-prompt-css', 'visual-effect-active']) {
        for (const library of [
            '{bad JSON',
            '[{"name":"damaged","code":null}]',
            '[{"name":"draft","code":"","extra":true}]',
            '[{"name":"Draft","code":""},{"name":" draft ","code":""}]',
        ]) {
            await t.test(key + ': ' + library, async () => {
                const state = await editor({key, library});
                state.name.text = 'Replacement';
                assert.equal(state.button('Save As New').sensitive, false);
                if (key === 'visual-effect-active') {
                    assert.equal(state.button('Apply').sensitive, false);
                    await state.apply();
                    assert.equal(state.dialog.destroyed, undefined);
                } else {
                    state.buffer.set_text('padding: 4px;');
                    await state.apply();
                    assert.equal(state.values[key], 'padding: 4px;');
                }
                assert.equal(state.values[state.entriesKey], library);
                await state.cancel();
            });
        }
    }
});

test('cancelling an unsaved effect draft changes neither library nor selection', async () => {
    const state = await editor();
    assert.equal(state.values[state.entriesKey], '[]', 'opening the editor must not insert its sample');
    state.name.text = 'Unsaved effect';
    state.buffer.set_text('ctx.blur(80);');
    await state.cancel();
    assert.deepEqual(state.writes, []);
    assert.equal(state.preferences._dialogs.size, 0);
    assert.equal(state.dialog.destroyed, true);
});

test('new effect names remain unique against stored names with whitespace or differing case', async () => {
    const state = await editor({library: JSON.stringify([{name: ' Rain ', code: 'ctx.draw.paint();'}])});
    state.name.text = 'rain';
    state.click('Save As New');
    const entries = JSON.parse(state.values[state.entriesKey]);
    assert.deepEqual(entries.map(entry => entry.name), [' Rain ', 'rain (2)']);
    assert.doesNotThrow(() => Presets.readSavedEntries({get_string: () => state.values[state.entriesKey]}, state.entriesKey));
    await state.apply();
    assert.equal(state.values['visual-effect-active'], 'rain (2)');
});
