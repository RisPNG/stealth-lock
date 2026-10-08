import fs from 'node:fs/promises';
import vm from 'node:vm';

export async function loadModule(filename, dependencies, globals = {}) {
    const url = new URL('../../' + filename, import.meta.url);
    const context = vm.createContext({console, ...globals});
    const modules = new Map();
    const module = new vm.SourceTextModule(await fs.readFile(url, 'utf8'), {
        context,
        identifier: url.href,
        initializeImportMeta(meta) { meta.url = url.href; },
    });
    await module.link(specifier => {
        if (!Object.hasOwn(dependencies, specifier))
            throw new Error('Unexpected dependency: ' + specifier);
        if (!modules.has(specifier)) {
            const values = dependencies[specifier];
            modules.set(specifier, new vm.SyntheticModule(Object.keys(values), function () {
                for (const [name, value] of Object.entries(values))
                    this.setExport(name, value);
            }, {context, identifier: specifier}));
        }
        return modules.get(specifier);
    });
    await module.evaluate();
    return module.namespace;
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
