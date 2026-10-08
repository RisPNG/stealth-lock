export const value = 'real dependency must not be loaded';
export default () => { throw new Error('Real dependency must not run'); };
