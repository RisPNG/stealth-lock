const CLOCK_DEFAULTS = {
    visible: false,
    format24h: true,
    seconds: true,
    date: true,
    align: 'center',
    topRatio: 0.14,
    offsetY: 0,
    fontSize: 64,
    dateFontSize: 20,
    monitor: 'settings',
};

const EFFECT_DEFAULTS = {
    blur: {radius: 20, brightness: 1},
    'neo-rain': {
        fontSize: 16,
        fontFamily: 'monospace',
        characters: 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789',
        density: 0.7,
        maxDrops: 3,
        speedMin: 0.3,
        speedMax: 1.2,
        lengthMin: 4,
        lengthMax: 40,
        fadeAlpha: 0.06,
    },
    'city-grow': {
        scale: 3,
        startBranches: 3,
        lineWidth: 2,
        fillBlocks: true,
        fillAlpha: 0.25,
        reverse: true,
        reversePoints: 50,
        restartDelayMs: 1000,
        branchSpeedMultiplier: 1.2,
        palette: null,
    },
};

const NUMBER_RANGES = {
    intervalMs: [33, 1000, true],
    radius: [0, 100, false],
    brightness: [0, 1, false],
    fontSize: [8, 64, true],
    density: [0, 1, false],
    maxDrops: [1, 8, true],
    speedMin: [0.05, 3, false],
    speedMax: [0.05, 3, false],
    lengthMin: [1, 100, true],
    lengthMax: [1, 100, true],
    fadeAlpha: [0.01, 1, false],
    scale: [1, 16, true],
    startBranches: [1, 32, true],
    lineWidth: [0.25, 8, false],
    fillAlpha: [0, 1, false],
    reversePoints: [1, 512, true],
    restartDelayMs: [0, 30000, true],
    branchSpeedMultiplier: [0.1, 3, false],
};

const CLOCK_NUMBER_RANGES = {
    topRatio: [0, 1, false],
    offsetY: [-2147483648, 2147483647, true],
    fontSize: [8, 160, true],
    dateFontSize: [8, 64, true],
};

export function validateEffectConfig(code) {
    if (typeof code !== 'string')
        throw new Error('Effect configuration must be JSON text');
    let config;
    try {
        config = JSON.parse(code);
    } catch {
        throw new Error('Effect configuration is not valid JSON');
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config))
        throw new Error('Effect configuration must be an object');
    for (const key of Object.keys(config)) {
        if (key !== 'effect' && key !== 'knobs')
            throw new Error(`Unknown effect configuration field: ${key}`);
    }
    if (typeof config.effect !== 'string' || !Object.hasOwn(EFFECT_DEFAULTS, config.effect))
        throw new Error('Effect must be blur, neo-rain, or city-grow');
    const knobs = config.knobs ?? {};
    if (typeof knobs !== 'object' || Array.isArray(knobs) || config.knobs === null)
        throw new Error('Effect knobs must be an object');
    const defaults = {intervalMs: 50, background: null, foreground: null, clock: {...CLOCK_DEFAULTS}, ...EFFECT_DEFAULTS[config.effect]};
    for (const [key, value] of Object.entries(knobs)) {
        if (!Object.hasOwn(defaults, key))
            throw new Error(`Unknown ${config.effect} knob: ${key}`);
        if (Object.hasOwn(NUMBER_RANGES, key)) {
            const [minimum, maximum, integer] = NUMBER_RANGES[key];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum ||
                (integer && !Number.isInteger(value)))
                throw new Error(`${key} must be ${integer ? 'an integer' : 'a number'} from ${minimum} to ${maximum}`);
        } else if (key === 'background' || key === 'foreground' || key === 'palette') {
            if (value === null)
                continue;
            const colors = key === 'palette' ? value : [value];
            if (!Array.isArray(colors) || colors.length < 1 || colors.length > 16)
                throw new Error('palette must contain 1 to 16 RGBA colors');
            for (const color of colors) {
                if (!Array.isArray(color) || color.length !== 4 ||
                    color.some(component => !Number.isInteger(component) || component < 0 || component > 255))
                    throw new Error(`${key} must use RGBA arrays of four bytes from 0 to 255`);
            }
        } else if (key === 'fontFamily') {
            if (typeof value !== 'string' || !value.trim() || [...value].length > 128 || /[\0\r\n\uD800-\uDFFF]/u.test(value))
                throw new Error('fontFamily must be nonempty Unicode text of at most 128 characters without NUL or line breaks');
        } else if (key === 'characters') {
            if (typeof value !== 'string' || !value || [...value].length > 256 || /[\0\r\n\uD800-\uDFFF]/u.test(value))
                throw new Error('characters must contain 1 to 256 Unicode characters without NUL or line breaks');
        } else if (key === 'clock') {
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                throw new Error('clock must be an object');
            for (const [clockKey, clockValue] of Object.entries(value)) {
                if (!Object.hasOwn(CLOCK_DEFAULTS, clockKey))
                    throw new Error(`Unknown clock field: ${clockKey}`);
                if (Object.hasOwn(CLOCK_NUMBER_RANGES, clockKey)) {
                    const [minimum, maximum, integer] = CLOCK_NUMBER_RANGES[clockKey];
                    if (typeof clockValue !== 'number' || !Number.isFinite(clockValue) || clockValue < minimum || clockValue > maximum ||
                        (integer && !Number.isInteger(clockValue)))
                        throw new Error(`clock.${clockKey} must be ${integer ? 'an integer' : 'a number'} from ${minimum} to ${maximum}`);
                } else if (clockKey === 'align') {
                    if (!['left', 'center', 'right'].includes(clockValue))
                        throw new Error('clock.align must be left, center, or right');
                } else if (clockKey === 'monitor') {
                    if (typeof clockValue !== 'string' || (!['settings', 'all'].includes(clockValue) && !/^\d+$/u.test(clockValue)))
                        throw new Error('clock.monitor must be settings, all, or a nonnegative monitor index string');
                } else if (typeof clockValue !== 'boolean') {
                    throw new Error(`clock.${clockKey} must be a boolean`);
                }
            }
        } else if (typeof value !== 'boolean') {
            throw new Error(`${key} must be a boolean`);
        }
    }
    const normalized = {effect: config.effect, knobs: {...defaults, ...knobs, clock: {...CLOCK_DEFAULTS, ...knobs.clock}}};
    if (config.effect === 'neo-rain') {
        if (normalized.knobs.speedMin > normalized.knobs.speedMax)
            throw new Error('speedMin must not exceed speedMax');
        if (normalized.knobs.lengthMin > normalized.knobs.lengthMax)
            throw new Error('lengthMin must not exceed lengthMax');
    }
    return normalized;
}

export const DEFAULT_EFFECT_PRESETS = [
    ['Dim and Blur', 'blur'],
    ['Neo Rain', 'neo-rain'],
    ['City Grow', 'city-grow'],
].map(([name, effect]) => ({
    name,
    code: JSON.stringify(validateEffectConfig(JSON.stringify({effect, knobs: {clock: {visible: effect === 'city-grow'}}})), null, 2),
}));

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
