import assert from 'node:assert/strict';
import test from 'node:test';

import * as Presets from '../../presets.js';
import {loadModule} from './harness.js';

async function editor({key = 'visual-effect-active', library = '[]', active = ''} = {}) {
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
            for (const callback of this.handlers.get(signal) ?? [])
                callback(this, ...args);
        }
        append(child) { this.children.push(child); }
        set_child(child) { this.children = [child]; }
        set_margin_top() {}
        set_margin_bottom() {}
        set_margin_start() {}
        set_margin_end() {}
        set_spacing() {}
        get text() { return this._text ?? ''; }
        set text(value) { this._text = value; this.emit('changed'); }
        destroy() { this.destroyed = true; }
        present() { this.presented = true; }
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
        response(value) { this.emit('response', value); }
    }
    const Gtk = {
        Dialog, Label: Widget, Entry: Widget, Box: Widget, Button: Widget, DropDown: Selector,
        ScrolledWindow: Widget, TextView, StringList: {new: values => new Names(values)},
        Orientation: {HORIZONTAL: 0}, WrapMode: {NONE: 0}, ResponseType: {CANCEL: -6, OK: -5},
        INVALID_LIST_POSITION: 0xffffffff,
    };
    const {default: Preferences} = await loadModule('prefs.js', {
        'gi://Adw': {default: {}}, 'gi://Gdk': {default: {}}, 'gi://Gio': {default: {}},
        'gi://GLib': {default: {}}, 'gi://Gtk': {default: Gtk}, './presets.js': Presets,
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
    preferences._showSavedEntryEditor({}, settings, key, 'Test', 'Saved entries');
    const dialog = [...preferences._dialogs][0];
    const widgets = [];
    const visit = widget => { widgets.push(widget); widget.children.forEach(visit); };
    visit(dialog);
    const button = label => widgets.find(widget => widget.label === label && widget instanceof Widget);
    return {
        preferences, dialog, values, writes, entriesKey,
        buffer: widgets.find(widget => widget instanceof TextView).buffer,
        selector: widgets.find(widget => widget instanceof Selector),
        name: widgets.find(widget => widget.placeholder_text === 'Saved entry name'),
        validation: widgets.find(widget => widget.css_classes?.includes('error')),
        button,
        click(label) { assert.equal(button(label).sensitive, true, label + ' should be usable'); button(label).emit('clicked'); },
        apply() { dialog.response(Gtk.ResponseType.OK); },
        cancel() { dialog.response(Gtk.ResponseType.CANCEL); },
    };
}

test('starter presets use the same editable, renamable and deletable flow as user presets', async () => {
    const state = await editor({library: JSON.stringify(Presets.DEFAULT_EFFECT_PRESETS), active: 'Neo Rain'});
    assert.equal(state.selector.selected, 1);
    state.buffer.set_text(JSON.stringify({effect: 'blur', knobs: {radius: 4}}));
    state.click('Replace Saved');
    assert.deepEqual(JSON.parse(JSON.parse(state.values[state.entriesKey])[1].code), {effect: 'blur', knobs: {radius: 4}});
    state.name.text = 'My edited preset';
    state.click('Rename');
    assert.equal(state.values['visual-effect-active'], 'My edited preset');
    assert.equal(JSON.parse(state.values[state.entriesKey])[1].name, 'My edited preset');
    state.click('Delete');
    assert.equal(state.values['visual-effect-active'], '');
    assert.deepEqual(JSON.parse(state.values[state.entriesKey]).map(entry => entry.name), ['Dim and Blur', 'City Grow']);
    state.cancel();
    assert.equal(state.preferences._dialogs.size, 0);
    assert.equal(state.dialog.destroyed, true);
});

test('invalid configurations keep the dialog open and cannot overwrite or activate saved effects', async () => {
    const library = JSON.stringify([{name: 'Rain', code: '{"effect":"neo-rain"}'}]);
    const state = await editor({library});
    for (const code of ['not JSON', '{"effect":"neo-rain","knobs":{"script":"run()"}}']) {
        state.buffer.set_text(code);
        assert.equal(state.validation.visible, true);
        assert.equal(state.button('Apply').sensitive, false);
        assert.equal(state.button('Save As New').sensitive, false);
        assert.equal(state.button('Replace Saved').sensitive, false);
        state.apply();
        assert.equal(state.values[state.entriesKey], library);
        assert.equal(state.values['visual-effect-active'], '');
        assert.equal(state.dialog.destroyed, undefined);
    }
    state.buffer.set_text('{"effect":"city-grow","knobs":{"clock":{"visible":true}}}');
    assert.equal(state.validation.visible, false);
    state.apply();
    assert.equal(state.values['visual-effect-active'], 'Rain');
    assert.equal(JSON.parse(JSON.parse(state.values[state.entriesKey])[0].code).effect, 'city-grow');
    assert.equal(state.preferences._dialogs.size, 0);
});

test('malformed CSS and effect libraries retain their original stored values', async t => {
    for (const key of ['normal-prompt-css', 'visual-effect-active']) {
        for (const library of ['{bad JSON', '[{"name":"damaged","code":null}]']) {
            await t.test(key + ': ' + library, async () => {
                const state = await editor({key, library});
                state.name.text = 'Replacement';
                assert.equal(state.button('Save As New').sensitive, false);
                if (key === 'visual-effect-active') {
                    assert.equal(state.button('Apply').sensitive, false);
                    state.apply();
                    assert.equal(state.dialog.destroyed, undefined);
                } else {
                    state.buffer.set_text('padding: 4px;');
                    state.apply();
                    assert.equal(state.values[key], 'padding: 4px;');
                }
                assert.equal(state.values[state.entriesKey], library);
                state.cancel();
            });
        }
    }
});

test('cancelling an unsaved effect draft changes neither library nor selection', async () => {
    const state = await editor();
    assert.equal(state.values[state.entriesKey], '[]', 'opening the editor must not insert its sample');
    state.name.text = 'Unsaved effect';
    state.buffer.set_text('{"effect":"blur","knobs":{"radius":80}}');
    state.cancel();
    assert.deepEqual(state.writes, []);
    assert.equal(state.preferences._dialogs.size, 0);
    assert.equal(state.dialog.destroyed, true);
});

test('new effect names remain unique against stored names with whitespace or differing case', async () => {
    const state = await editor({library: JSON.stringify([{name: ' Rain ', code: '{"effect":"neo-rain"}'}])});
    state.name.text = 'rain';
    state.click('Save As New');
    const entries = JSON.parse(state.values[state.entriesKey]);
    assert.deepEqual(entries.map(entry => entry.name), [' Rain ', 'rain (2)']);
    assert.doesNotThrow(() => Presets.readEffectPresets({get_string: () => state.values[state.entriesKey]}));
    state.apply();
    assert.equal(state.values['visual-effect-active'], 'rain (2)');
});
