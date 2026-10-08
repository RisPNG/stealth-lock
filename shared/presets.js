import {DEFAULT_EFFECT_PRESETS} from './starter-programs.js';

export {DEFAULT_EFFECT_PRESETS};

export function validateVisualProgramSource(code) {
    if (typeof code !== 'string' || !code.trim())
        throw new Error('Visual program must contain JavaScript text');
    if (code.includes('\0'))
        throw new Error('Visual program must not contain NUL');
    if (new TextEncoder().encode(code).length > 512 * 1024)
        throw new Error('Visual program must not exceed 512 KiB of UTF-8 text');
    return code;
}

export function initializeEffectPresets(settings) {
    if (settings.get_boolean('visual-effect-initialized'))
        return true;
    const libraryExists = settings.get_user_value('visual-effect-presets') !== null ||
        settings.get_user_value('visual-effect-active') !== null;
    if (!libraryExists && !settings.set_string('visual-effect-presets', JSON.stringify(DEFAULT_EFFECT_PRESETS)))
        return false;
    return settings.set_boolean('visual-effect-initialized', true);
}

export function readSavedEntries(settings, key) {
    let entries;
    try {
        entries = JSON.parse(settings.get_string(key));
    } catch {
        throw new Error('Saved entries are not valid JSON');
    }
    if (!Array.isArray(entries))
        throw new Error('Saved entries must be an array');
    const names = new Set();
    for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
            typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.code !== 'string' ||
            Object.keys(entry).some(key => key !== 'name' && key !== 'code'))
            throw new Error('Each saved entry must contain a nonempty name and code text');
        const name = entry.name.trim().toLowerCase();
        if (names.has(name))
            throw new Error(`Saved entry names must be unique: ${entry.name}`);
        names.add(name);
    }
    return entries;
}

if (Array.isArray(globalThis.ARGV)) {
    const System = await import('system');
    const {default: Gio} = await import('gi://Gio');
    if (Gio.File.new_for_path(System.programInvocationName).get_uri() === import.meta.url) {
        const [schemaDirectory] = System.programArgs;
        if (System.programArgs.length !== 1)
            throw new Error('Usage: gjs -m shared/presets.js <schemas-directory>');
        const source = Gio.SettingsSchemaSource.new_from_directory(schemaDirectory, Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup('org.gnome.shell.extensions.stealth-lock', false);
        if (!schema)
            throw new Error('Stealth Lock settings schema was not found');
        const settings = new Gio.Settings({settings_schema: schema});
        if (!initializeEffectPresets(settings))
            throw new Error('Could not initialize saved effect presets');
        Gio.Settings.sync();
    }
}
