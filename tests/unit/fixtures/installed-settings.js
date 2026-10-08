import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'keyfile')
    throw new Error('Installer fixture requires a private keyfile settings backend');
const [directory, values] = System.programArgs;
const source = Gio.SettingsSchemaSource.new_from_directory(directory, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.stealth-lock', false)});
for (const [key, value] of Object.entries(JSON.parse(values))) {
    if (!settings.set_value(key, new GLib.Variant(settings.get_value(key).get_type_string(), value)))
        throw new Error('Installer fixture could not write setting: ' + key);
}
Gio.Settings.sync();
globalThis.print(JSON.stringify(Object.fromEntries(settings.settings_schema.list_keys().map(key => [key, settings.get_value(key).deep_unpack()]))));
