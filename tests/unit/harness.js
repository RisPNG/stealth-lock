import fs from 'node:fs/promises';
import vm from 'node:vm';

export async function loadModule(filename, dependencies, globals = {}) {
    const source = await fs.readFile(new URL('../../' + filename, import.meta.url), 'utf8');
    const exports = [];
    const script = source.replace(/^import (.+) from '([^']+)';$/gm, (_line, names, specifier) => {
        if (!dependencies[specifier])
            throw new Error('Unexpected dependency: ' + specifier);
        const target = `dependencies[${JSON.stringify(specifier)}]`;
        if (names.startsWith('* as '))
            return `const ${names.slice(5)} = ${target};`;
        if (names.startsWith('{'))
            return `const ${names.replace(/ as /g, ': ')} = ${target};`;
        return `const ${names} = ${target}.default;`;
    }).replace(/export (default )?(async )?(class|function|const) (\w+)/g, (_text, isDefault, async, kind, name) => {
        exports.push(`${isDefault ? 'default' : name}: ${name}`);
        return `${async ?? ''}${kind} ${name}`;
    });
    return vm.runInNewContext(script + '\n({' + exports.join(',') + '})', {console, dependencies, ...globals}, {filename});
}

export class Cancellable {
    constructor() {
        this.cancelled = false;
        this.handlers = new Map();
        this.nextId = 1;
    }

    connect(callback) {
        if (this.cancelled) {
            callback();
            return 0;
        }
        const id = this.nextId++;
        this.handlers.set(id, callback);
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    cancel() {
        this.cancelled = true;
        for (const callback of this.handlers.values())
            callback();
    }

    is_cancelled() {
        return this.cancelled;
    }

    set_error_if_cancelled() {
        if (this.cancelled)
            throw new Error('cancelled');
    }
}

export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((fulfilled, failed) => {
        resolve = fulfilled;
        reject = failed;
    });
    return {promise, resolve, reject};
}
