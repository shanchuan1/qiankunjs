
export { loadMicroApp , registerMicroApps, start } from './apis';
export { initGlobalState } from './globalState';
export { getCurrentRunningApp as __internalGetCurrentRunningApp } from './sandbox';
export * from './errorHandler';
export * from './effects';
// export * from './interfaces';
export { prefetchImmediately as prefetchApps } from './prefetch';




/* ------------------------API------------------------------ */
export { prefetchApps as prefetchAppsFn } from './API/prefetchApps';
