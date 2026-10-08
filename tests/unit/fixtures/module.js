import transform, {
    value as input,
} from './dependency.js';
import * as dependency from './dependency.js';

export {value as forwarded} from './dependency.js';
export * from './dependency.js';
export * as namespace from './dependency.js';

globalThis.fixtureRuns = (globalThis.fixtureRuns ?? 0) + 1;

const result = await Promise.resolve(transform(input));
export {result as calculated};
export const executions = globalThis.fixtureRuns;
export const source = import.meta.url;
export default dependency;
