import * as css from './css';
import { patchLooseSandbox, patchStrictSandbox } from './dynamicAppend';
import patchHistoryListener from './historyListener';
import patchInterval from './interval';
import patchWindowListener from './windowListener';
export { css };

const SandBoxType = {
    Proxy : 'Proxy',
    Snapshot : 'Snapshot',
  
    // for legacy sandbox
    // https://github.com/umijs/qiankun/blob/0d1d3f0c5ed1642f01854f96c3fabf0a2148bd26/src/sandbox/legacy/sandbox.ts#L22...L25
    LegacyProxy : 'LegacyProxy',
}

export function patchAtMounting(
    appName,
    elementGetter,
    sandbox,
    scopedCSS,
    excludeAssetFilter,
    speedySandBox
) {
    const basePatchers = [
        () => patchInterval(sandbox.proxy),
        () => patchWindowListener(sandbox.proxy),
        () => patchHistoryListener(),
    ];

    const patchersInSandbox = {
        [SandBoxType.LegacyProxy]: [
            ...basePatchers,
            () => patchLooseSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter),
        ],
        [SandBoxType.Proxy]: [
            ...basePatchers,
            () => patchStrictSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter, speedySandBox),
        ],
        [SandBoxType.Snapshot]: [
            ...basePatchers,
            () => patchLooseSandbox(appName, elementGetter, sandbox, true, scopedCSS, excludeAssetFilter),
        ],
    };

    return patchersInSandbox[sandbox.type]?.map((patch) => patch()) || [];
}

export function patchAtBootstrapping(
    appName,
    elementGetter,
    sandbox,
    scopedCSS,
    excludeAssetFilter,
    speedySandBox
) {
    const patchersInSandbox = {
        [SandBoxType.LegacyProxy]: [
            () => patchLooseSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter),
        ],
        [SandBoxType.Proxy]: [
            () => patchStrictSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter, speedySandBox),
        ],
        [SandBoxType.Snapshot]: [
            () => patchLooseSandbox(appName, elementGetter, sandbox, false, scopedCSS, excludeAssetFilter),
        ],
    };

    return patchersInSandbox[sandbox.type]?.map((patch) => patch()) || [];
}
