import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import {
    Deferred,
    genAppInstanceIdByName,
    getContainer,
    getDefaultTplWrapper,
    getWrapperId,
    isEnableScopedCSS,
    performanceGetEntriesByName,
    performanceMark,
    performanceMeasure,
    toArray,
    validateExportLifecycle,
} from './utils';
import getAddOns from './addons';
import { QiankunError } from './error';
import { getMicroAppStateActions } from './globalState';
import { cachedGlobals } from './sandbox/proxySandbox';
import { createSandboxContainer, css } from './sandbox';

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;

function assertElementExist(element, msg) {
    if (!element) {
        if (msg) {
            throw new QiankunError(msg);
        }

        throw new QiankunError('element not existed!');
    }
}

function execHooksChain(
    hooks,
    app,
    global = window,
) {
    if (hooks.length) {
        return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
    }

    return Promise.resolve();
}

async function validateSingularMode(
    validate,
    app,
) {
    return typeof validate === 'function' ? validate(app) : !!validate;
}

function createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId) {
    const containerElement = document.createElement('div');
    containerElement.innerHTML = appContent;
    const appElement = containerElement.firstChild;
    if (strictStyleIsolation) {
        if (!supportShadowDOM) {
            console.warn(
                '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
            );
        } else {
            const { innerHTML } = appElement;
            appElement.innerHTML = '';
            let shadow;

            if (appElement.attachShadow) {
                shadow = appElement.attachShadow({ mode: 'open' });
            } else {
                shadow = appElement.createShadowRoot();
            }
            shadow.innerHTML = innerHTML;
        }
    }

    if (scopedCSS) {
        const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
        if (!attr) {
            appElement.setAttribute(css.QiankunCSSRewriteAttr, appInstanceId);
        }

        const styleNodes = appElement.querySelectorAll('style') || [];
        styleNodes.forEach((stylesheetElement) => {
            css.process(appElement, stylesheetElement, appInstanceId);
        });
    }
    console.log('🚀 ~ appElement:', appElement);
    return appElement;
}


/**
 * 获取渲染函数
 * 如果提供了传统的渲染函数，则使用它，否则我们将通过 qiankun 将应用元素插入目标容器
 * @param appInstanceId
 * @param appContent
 * @param legacyRender
 */
function getRender(appInstanceId, appContent, legacyRender) {
    const render = ({ element, loading, container }, phase) => {
        if (legacyRender) {
            if (process.env.NODE_ENV === 'development') {
                console.error(
                    '[qiankun] Custom rendering function is deprecated and will be removed in 3.0, you can use the container element setting instead!',
                );
            }

            return legacyRender({ loading, appContent: element ? appContent : '' });
        }

        const containerElement = getContainer(container);

        // The container might have be removed after micro app unmounted.
        // Such as the micro app unmount lifecycle called by a react componentWillUnmount lifecycle, after micro app unmounted, the react component might also be removed
        if (phase !== 'unmounted') {
            const errorMsg = (() => {
                switch (phase) {
                    case 'loading':
                    case 'mounting':
                        return `Target container with ${container} not existed while ${appInstanceId} ${phase}!`;

                    case 'mounted':
                        return `Target container with ${container} not existed after ${appInstanceId} ${phase}!`;

                    default:
                        return `Target container with ${container} not existed while ${appInstanceId} rendering!`;
                }
            })();
            assertElementExist(containerElement, errorMsg);
        }

        if (containerElement && !containerElement.contains(element)) {
            // clear the container
            while (containerElement.firstChild) {
                rawRemoveChild.call(containerElement, containerElement.firstChild);
            }

            // append the element to container if it exist
            if (element) {
                rawAppendChild.call(containerElement, element);
            }
        }

        return undefined;
    };

    return render;
}


/** 生成应用包装器 DOM 获取器 */
function getAppWrapperGetter(
    appInstanceId,
    useLegacyRender,
    strictStyleIsolation,
    scopedCSS,
    elementGetter
) {
    return () => {
        if (useLegacyRender) {
            if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
            if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');

            const appWrapper = document.getElementById(getWrapperId(appInstanceId));
            assertElementExist(appWrapper, `Wrapper element for ${appInstanceId} is not existed!`);
            return appWrapper;
        }

        const element = elementGetter();
        assertElementExist(element, `Wrapper element for ${appInstanceId} is not existed!`);

        if (strictStyleIsolation && supportShadowDOM) {
            return element.shadowRoot;
        }

        return element;
    };
}


function getLifecyclesFromExports(
    scriptExports,
    appName,
    global,
    globalLatestSetProp,
  ) {
    if (validateExportLifecycle(scriptExports)) {
      return scriptExports;
    }
  
    // fallback to sandbox latest set property if it had
    if (globalLatestSetProp) {
      const lifecycles = (global)[globalLatestSetProp];
      if (validateExportLifecycle(lifecycles)) {
        return lifecycles;
      }
    }
  
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
      );
    }
  
    // fallback to global variable who named with ${appName} while module exports not found
    const globalVariableExports = (global)[appName];
  
    if (validateExportLifecycle(globalVariableExports)) {
      return globalVariableExports;
    }
  
    throw new QiankunError(`You need to export lifecycle functions in ${appName} entry`);
  }



export async function loadApp(app, configuration = {}, lifeCycles) {
    console.log('🚀 ~ loadApp ~ configuration:', configuration)
    const { entry, name: appName } = app;
    const appInstanceId = genAppInstanceIdByName(appName);

    const markName = `[qiankun] App ${appInstanceId} Loading`;
    if (process.env.NODE_ENV === 'development') {
        performanceMark(markName);
    }

    const {
        singular = false,
        sandbox = true,
        excludeAssetFilter,
        globalContext = window,
        ...importEntryOpts
    } = configuration;

    const {
        template,
        execScripts,
        assetPublicPath,
        getExternalScripts
    } = await importEntry(entry, importEntryOpts);
    console.log('🚀 ~ template:', template);
    console.log('🚀 ~ execScripts:', execScripts);
    console.log('🚀 ~ assetPublicPath:', assetPublicPath);
    console.log('🚀 ~ getExternalScripts:', getExternalScripts);

    await getExternalScripts();

    if (await validateSingularMode(singular, app)) {
        await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
    }

    const appContent = getDefaultTplWrapper(appInstanceId, sandbox)(template);
    console.log('🚀 ~ appContent:', appContent);

    const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;
    const scopedCSS = isEnableScopedCSS(sandbox);
    console.log('🚀 ~ scopedCSS:', scopedCSS);
    let initialAppWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId);

    const initialContainer = 'container' in app ? app.container : undefined;
    const legacyRender = 'render' in app ? app.render : undefined;

    const render = getRender(appInstanceId, appContent, legacyRender);

    // 第一次加载设置应用可见区域 dom 结构
    // 确保每次应用加载前容器 dom 结构已经设置完毕
    render({ element: initialAppWrapperElement, loading: true, container: initialContainer }, 'loading');

    const initialAppWrapperGetter = getAppWrapperGetter(
        appInstanceId,
        !!legacyRender,
        strictStyleIsolation,
        scopedCSS,
        () => initialAppWrapperElement,
    );

    let global = globalContext;
    let mountSandbox = () => Promise.resolve();
    let unmountSandbox = () => Promise.resolve();
    const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
    const speedySandbox = typeof sandbox === 'object' ? sandbox.speedy !== false : true;
    let sandboxContainer;
    if (sandbox) {
        sandboxContainer = createSandboxContainer(
            appInstanceId,
            initialAppWrapperGetter,
            scopedCSS,
            useLooseSandbox,
            excludeAssetFilter,
            global,
            speedySandbox,
        );
        global = sandboxContainer.instance.proxy;
        mountSandbox = sandboxContainer.mount;
        unmountSandbox = sandboxContainer.unmount;
        console.log('🚀 ~ sandboxContainer:', sandboxContainer);
    }

    const {
        beforeUnmount = [],
        afterUnmount = [],
        afterMount = [],
        beforeMount = [],
        beforeLoad = [],
    } = mergeWith({}, getAddOns(global, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));

    await execHooksChain(toArray(beforeLoad), app, global);

    const scriptExports = await execScripts(global, sandbox && !useLooseSandbox, {
        scopedGlobalVariables: speedySandbox ? cachedGlobals : [],
    });
    const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(
        scriptExports,
        appName,
        global,
        sandboxContainer?.instance?.latestSetProp,
    );

    const { onGlobalStateChange, setGlobalState, offGlobalStateChange } = getMicroAppStateActions(appInstanceId);

    const syncAppWrapperElement2Sandbox = (element) => (initialAppWrapperElement = element);
    const parcelConfigGetter = (remountContainer = initialContainer) => {
        let appWrapperElement;
        let appWrapperGetter;

        const parcelConfig = {
            name: appInstanceId,
            bootstrap,
            mount: [
                async () => {
                    if (process.env.NODE_ENV === 'development') {
                        const marks = performanceGetEntriesByName(markName, 'mark');
                        if (marks && !marks.length) {
                            performanceMark(markName);
                        }
                    }
                },
                async () => {
                    if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
                        return prevAppUnmountedDeferred.promise;
                    }

                    return undefined;
                },
                async () => {
                    appWrapperElement = initialAppWrapperElement;
                    appWrapperGetter = getAppWrapperGetter(
                        appInstanceId,
                        !!legacyRender,
                        strictStyleIsolation,
                        scopedCSS,
                        () => appWrapperElement,
                    );
                },
                async () => {
                    const useNewContainer = remountContainer !== initialContainer;
                    if (useNewContainer || !appWrapperElement) {
                        appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appInstanceId);
                        syncAppWrapperElement2Sandbox(appWrapperElement);
                    }

                    render({ element: appWrapperElement, loading: true, container: remountContainer }, 'mounting');
                },
                mountSandbox,
                async () => execHooksChain(toArray(beforeMount), app, global),
                async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),
                async () => render({ element: appWrapperElement, loading: false, container: remountContainer }, 'mounted'),
                async () => execHooksChain(toArray(afterMount), app, global),
                async () => {
                    if (await validateSingularMode(singular, app)) {
                        prevAppUnmountedDeferred = new Deferred();
                    }
                },
                async () => {
                    if (process.env.NODE_ENV === 'development') {
                        const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
                        performanceMeasure(measureName, markName);
                    }
                },
            ],
            unmount: [
                async () => execHooksChain(toArray(beforeUnmount), app, global),
                async (props) => unmount({ ...props, container: appWrapperGetter() }),
                unmountSandbox,
                async () => execHooksChain(toArray(afterUnmount), app, global),
                async () => {
                    render({ element: null, loading: false, container: remountContainer }, 'unmounted');
                    offGlobalStateChange(appInstanceId);
                    appWrapperElement = null;
                    syncAppWrapperElement2Sandbox(appWrapperElement);
                },
                async () => {
                    if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
                        prevAppUnmountedDeferred.resolve();
                    }
                },
            ],
        };

        if (typeof update === 'function') {
            parcelConfig.update = update;
        }

        return parcelConfig;
    };


    console.log('🚀 loadApp ~ parcelConfigGetter:', parcelConfigGetter);
    return parcelConfigGetter;
}
