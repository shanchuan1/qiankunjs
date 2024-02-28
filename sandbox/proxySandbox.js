import { without } from "lodash";
import { isPropertyFrozen, nativeGlobal, nextTask } from "../utils";
import {
    clearCurrentRunningApp,
    getCurrentRunningApp,
    rebindTarget2Fn,
    setCurrentRunningApp,
} from "./common";
import { globalsInBrowser, globalsInES2015 } from "./globals";

/**
 * 最快（大多数时间）的唯一数组方法
 * @see https://jsperf.com/array-filter-unique/30
 */
function uniq(array) {
    return array.filter(function filter(element) {
        return element in this ? false : (this[element] = true);
    }, Object.create(null));
}

/**
 * 将数组转换为对象，以便使用 in 运算符进行更快的元素检查
 * @param array
 */
function array2TruthyObject(array) {
    return array.reduce((acc, key) => {
        acc[key] = true;
        return acc;
    }, Object.create(null));
}

const cachedGlobalsInBrowser = array2TruthyObject(
    globalsInBrowser.concat(
        process.env.NODE_ENV === "test" ? ["mockNativeWindowFunction"] : []
    )
);
function isNativeGlobalProp(prop) {
    return prop in cachedGlobalsInBrowser;
}

// zone.js 会覆盖 Object.defineProperty
const rawObjectDefineProperty = Object.defineProperty;

const variableWhiteListInDev =
    process.env.NODE_ENV === "test" ||
        process.env.NODE_ENV === "development" ||
        window.__QIANKUN_DEVELOPMENT__
        ? [
            // 用于 React 热重载
            // 参见 https://github.com/facebook/create-react-app/blob/66bf7dfc43350249e2f09d138a20840dae8a0a4a/packages/react-error-overlay/src/index.js#L180
            "__REACT_ERROR_OVERLAY_GLOBAL_HOOK__",
            // 用于解决 React 开发环境事件问题，参见 https://github.com/umijs/qiankun/issues/2375
            "event",
        ]
        : [];
// 能够逃逸沙箱的变量白名单
const globalVariableWhiteList = [
    // FIXME System.js 使用了 eval 的间接调用，会导致其作用域逃逸到全局
    // 为了使 System.js 正常工作，我们将其暂时写回全局 window
    // 参见 https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/evaluate.js#L106
    "System",

    // 参见 https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/instantiate.js#L357
    "__cjsWrapper",
    ...variableWhiteListInDev,
];

const inTest = process.env.NODE_ENV === "test";
const mockSafariTop = "mockSafariTop";
const mockTop = "mockTop";
const mockGlobalThis = "mockGlobalThis";

// these globals should be recorded while accessing every time
const accessingSpiedGlobals = ["document", "top", "parent", "eval"];
const overwrittenGlobals = [
    "window",
    "self",
    "globalThis",
    "hasOwnProperty",
].concat(inTest ? [mockGlobalThis] : []);
export const cachedGlobals = Array.from(
    new Set(
        without(
            globalsInES2015
                .concat(overwrittenGlobals)
                .concat("requestAnimationFrame"),
            ...accessingSpiedGlobals
        )
    )
);

const cachedGlobalObjects = array2TruthyObject(cachedGlobals);

/*
 Variables who are impossible to be overwritten need to be escaped from proxy sandbox for performance reasons.
 But overwritten globals must not be escaped, otherwise they will be leaked to the global scope.
 see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/unscopables
 */
const unscopables = array2TruthyObject(
    without(cachedGlobals, ...accessingSpiedGlobals.concat(overwrittenGlobals))
);

const useNativeWindowForBindingsProps = new Map([
    ["fetch", true],
    ["mockDomAPIInBlackList", process.env.NODE_ENV === "test"],
]);

function createFakeWindow(globalContext, speedy) {
    // map always has the fastest performance in has checked scenario
    // see https://jsperf.com/array-indexof-vs-set-has/23
    const propertiesWithGetter = new Map();
    const fakeWindow = {};

    /*
       copy the non-configurable property of global to fakeWindow
       see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
       > A property cannot be reported as non-configurable, if it does not exist as an own property of the target object or if it exists as a configurable own property of the target object.
       */
    Object.getOwnPropertyNames(globalContext)
        .filter((p) => {
            const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
            return !descriptor?.configurable;
        })
        .forEach((p) => {
            const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
            if (descriptor) {
                const hasGetter = Object.prototype.hasOwnProperty.call(
                    descriptor,
                    "get"
                );

                /*
                   make top/self/window property configurable and writable, otherwise it will cause TypeError while get trap return.
                   see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/get
                   > The value reported for a property must be the same as the value of the corresponding target object property if the target object property is a non-writable, non-configurable data property.
                   */
                if (
                    p === "top" ||
                    p === "parent" ||
                    p === "self" ||
                    p === "window" ||
                    // window.document is overwriting in speedy mode
                    (p === "document" && speedy) ||
                    (inTest && (p === mockTop || p === mockSafariTop))
                ) {
                    descriptor.configurable = true;
                    /*
                       The descriptor of window.window/window.top/window.self in Safari/FF are accessor descriptors, we need to avoid adding a data descriptor while it was
                       Example:
                        Safari/FF: Object.getOwnPropertyDescriptor(window, 'top') -> {get: function, set: undefined, enumerable: true, configurable: false}
                        Chrome: Object.getOwnPropertyDescriptor(window, 'top') -> {value: Window, writable: false, enumerable: true, configurable: false}
                       */
                    if (!hasGetter) {
                        descriptor.writable = true;
                    }
                }

                if (hasGetter) propertiesWithGetter.set(p, true);

                // freeze the descriptor to avoid being modified by zone.js
                // see https://github.com/angular/zone.js/blob/a5fe09b0fac27ac5df1fa746042f96f05ccb6a00/lib/browser/define-property.ts#L71
                rawObjectDefineProperty(fakeWindow, p, Object.freeze(descriptor));
            }
        });

    return {
        fakeWindow,
        propertiesWithGetter,
    };
}

let activeSandboxCount = 0;


/**
 * 基于 Proxy 实现的沙箱
 */
// export default class ProxySandbox {
//     /** window 值变更记录 */
//     updatedValueSet = new Set();
//     document = document;
//     name;
//     type;
//     proxy;
//     sandboxRunning = true;
//     latestSetProp = null;

//     active() {
//         if (!this.sandboxRunning)
//             activeSandboxCount++;
//         this.sandboxRunning = true;
//     }

//     inactive() {
//         if (process.env.NODE_ENV === 'development') {
//             console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
//                 ...this.updatedValueSet.keys(),
//             ]);
//         }

//         if (inTest || --activeSandboxCount === 0) {
//             // reset the global value to the prev value
//             Object.keys(this.globalWhitelistPrevDescriptor).forEach((p) => {
//                 const descriptor = this.globalWhitelistPrevDescriptor[p];
//                 if (descriptor) {
//                     Object.defineProperty(this.globalContext, p, descriptor);
//                 } else {
//                     delete this.globalContext[p];
//                 }
//             });
//         }

//         this.sandboxRunning = false;
//     }

//     patchDocument(doc) {
//         this.document = doc;
//     }

//     constructor(name, globalContext = window, opts) {
//         this.updatedValueSet = new Set();
//         this.document = document;
//         this.sandboxRunning = true;
//         this.latestSetProp = null;
//         this.globalWhitelistPrevDescriptor = {};
//         this.name = name;
//         this.globalContext = globalContext;
//         this.type = 'Proxy';
//         const { speedy } = opts || {};
//         const { fakeWindow, propertiesWithGetter } = createFakeWindow(globalContext, !!speedy);
//         const descriptorTargetMap = new Map();
//         const proxy = new Proxy(fakeWindow, {
//             set: function (target, p, value) {
//                 if (this.sandboxRunning) {
//                     // this.registerRunningApp(name, proxy);
//                     registerRunningApp(name, proxy);
//                     if (typeof p === 'string' && globalVariableWhiteList.indexOf(p) !== -1) {
//                         this.globalWhitelistPrevDescriptor[p] = Object.getOwnPropertyDescriptor(globalContext, p);
//                         globalContext[p] = value;
//                     } else {
//                         if (!target.hasOwnProperty(p) && globalContext.hasOwnProperty(p)) {
//                             const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
//                             const { writable, configurable, enumerable, set } = descriptor || {};
//                             if (writable || set) {
//                                 Object.defineProperty(target, p, { configurable, enumerable, writable: true, value });
//                             }
//                         } else {
//                             target[p] = value;
//                         }
//                     }
//                     this.updatedValueSet.add(p);
//                     this.latestSetProp = p;
//                     return true;
//                 }
//                 if (process.env.NODE_ENV === 'development') {
//                     console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
//                 }
//                 return true;
//             },
//             get: function (target, p) {
//                 console.log('this', this);
//                 this.registerRunningApp(name, proxy);
//                 if (p === Symbol.unscopables)
//                     return unscopables;
//                 if (p === 'window' || p === 'self')
//                     return proxy;
//                 if (p === 'globalThis' || (inTest && p === mockGlobalThis))
//                     return proxy;
//                 if (p === 'top' || p === 'parent' || (inTest && (p === mockTop || p === mockSafariTop))) {
//                     if (globalContext === globalContext.parent)
//                         return proxy;
//                     return globalContext[p];
//                 }
//                 if (p === 'hasOwnProperty')
//                     return hasOwnProperty;
//                 if (p === 'document')
//                     return this.document;
//                 if (p === 'eval')
//                     return eval;
//                 if (p === 'string' && globalVariableWhiteList.indexOf(p) !== -1)
//                     return globalContext[p];
//                 const actualTarget = propertiesWithGetter.has(p) ? globalContext : p in target ? target : globalContext;
//                 const value = actualTarget[p];
//                 if (isPropertyFrozen(actualTarget, p))
//                     return value;
//                 if (!isNativeGlobalProp(p) && !useNativeWindowForBindingsProps.has(p))
//                     return value;
//                 const boundTarget = useNativeWindowForBindingsProps.get(p) ? nativeGlobal : globalContext;
//                 return rebindTarget2Fn(boundTarget, value);
//             },
//             has: function (target, p) {
//                 return p in cachedGlobalObjects || p in target || p in globalContext;
//             },
//             getOwnPropertyDescriptor: function (target, p) {
//                 if (target.hasOwnProperty(p)) {
//                     const descriptor = Object.getOwnPropertyDescriptor(target, p);
//                     descriptorTargetMap.set(p, 'target');
//                     return descriptor;
//                 }
//                 if (globalContext.hasOwnProperty(p)) {
//                     const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
//                     descriptorTargetMap.set(p, 'globalContext');
//                     if (descriptor && !descriptor.configurable)
//                         descriptor.configurable = true;
//                     return descriptor;
//                 }
//                 return undefined;
//             },
//             ownKeys: function (target) {
//                 return uniq(Reflect.ownKeys(globalContext).concat(Reflect.ownKeys(target)));
//             },
//             defineProperty: function (target, p, attributes) {
//                 const from = descriptorTargetMap.get(p);
//                 switch (from) {
//                     case 'globalContext':
//                         return Reflect.defineProperty(globalContext, p, attributes);
//                     default:
//                         return Reflect.defineProperty(target, p, attributes);
//                 }
//             },
//             deleteProperty: function (target, p) {
//                 this.registerRunningApp(name, proxy);
//                 if (target.hasOwnProperty(p)) {
//                     delete target[p];
//                     updatedValueSet.delete(p);
//                     return true;
//                 }
//                 return true;
//             },
//             getPrototypeOf: function () {
//                 return Reflect.getPrototypeOf(globalContext);
//             },
//         });
//         this.proxy = proxy;
//         activeSandboxCount++;
//         function hasOwnProperty(key) {
//             if (this !== proxy && this !== null && typeof this === 'object') {
//                 return Object.prototype.hasOwnProperty.call(this, key);
//             }
//             return fakeWindow.hasOwnProperty(key) || globalContext.hasOwnProperty(key);
//         }
//     }


//     registerRunningApp(name, proxy) {
//         if (this.sandboxRunning) {
//             const currentRunningApp = getCurrentRunningApp();
//             if (!currentRunningApp || currentRunningApp.name !== name) {
//                 setCurrentRunningApp({ name, window: proxy });
//             }
//             // FIXME if you have any other good ideas
//             // remove the mark in next tick, thus we can identify whether it in micro app or not
//             // this approach is just a workaround, it could not cover all complex cases, such as the micro app runs in the same task context with master in some case
//             nextTask(clearCurrentRunningApp);
//         }
//     }
// }


export default class ProxySandbox {
    constructor(name, globalContext = window, opts) {
        this.updatedValueSet = new Set();
        this.document = document;
        this.sandboxRunning = true;
        this.latestSetProp = null;
        this.type = undefined;
        this.proxy = undefined;

        this.name = name;
        this.globalContext = globalContext;
        this.type = 'Proxy';
        const { updatedValueSet } = this;
        const { speedy } = opts || {};

        const { fakeWindow, propertiesWithGetter } = createFakeWindow(globalContext, !!speedy);

        const descriptorTargetMap = new Map();

        const proxy = new Proxy(fakeWindow, {
            set: (target, p, value) => {
                if (this.sandboxRunning) {
                    this.registerRunningApp(name, proxy);

                    // sync the property to globalContext
                    if (typeof p === 'string' && globalVariableWhiteList.indexOf(p) !== -1) {
                        this.globalWhitelistPrevDescriptor[p] = Object.getOwnPropertyDescriptor(globalContext, p);
                        // @ts-ignore
                        globalContext[p] = value;
                    } else {
                        // We must keep its description while the property existed in globalContext before
                        if (!target.hasOwnProperty(p) && globalContext.hasOwnProperty(p)) {
                            const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
                            const { writable, configurable, enumerable, set } = descriptor;
                            // only writable property can be overwritten
                            // here we ignored accessor descriptor of globalContext as it makes no sense to trigger its logic(which might make sandbox escaping instead)
                            // we force to set value by data descriptor
                            if (writable || set) {
                                Object.defineProperty(target, p, { configurable, enumerable, writable: true, value });
                            }
                        } else {
                            target[p] = value;
                        }
                    }

                    updatedValueSet.add(p);

                    this.latestSetProp = p;

                    return true;
                }

                if (process.env.NODE_ENV === 'development') {
                    console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
                }

                // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，在沙箱卸载的情况下应该忽略错误
                return true;
            },

            get: (target, p) => {
                this.registerRunningApp(name, proxy);

                if (p === Symbol.unscopables) return unscopables;
                // avoid who using window.window or window.self to escape the sandbox environment to touch the real window
                // see https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js#L13
                if (p === 'window' || p === 'self') {
                    return proxy;
                }

                // hijack globalWindow accessing with globalThis keyword
                if (p === 'globalThis' || (inTest && p === mockGlobalThis)) {
                    return proxy;
                }

                if (p === 'top' || p === 'parent' || (inTest && (p === mockTop || p === mockSafariTop))) {
                    // if your master app in an iframe context, allow these props escape the sandbox
                    if (globalContext === globalContext.parent) {
                        return proxy;
                    }
                    return (globalContext)[p];
                }

                // proxy.hasOwnProperty would invoke getter firstly, then its value represented as globalContext.hasOwnProperty
                if (p === 'hasOwnProperty') {
                    return hasOwnProperty;
                }

                if (p === 'document') {
                    return this.document;
                }

                if (p === 'eval') {
                    return eval;
                }

                if (p === 'string' && globalVariableWhiteList.indexOf(p) !== -1) {
                    // @ts-ignore
                    return globalContext[p];
                }

                const actualTarget = propertiesWithGetter.has(p) ? globalContext : p in target ? target : globalContext;
                const value = actualTarget[p];

                // frozen value should return directly, see https://github.com/umijs/qiankun/issues/2015
                if (isPropertyFrozen(actualTarget, p)) {
                    return value;
                }

                // non-native property return directly to avoid rebind
                if (!isNativeGlobalProp(p) && !useNativeWindowForBindingsProps.has(p)) {
                    return value;
                }

                /* Some dom api must be bound to native window, otherwise it would cause exception like 'TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation'
                   See this code:
                     const proxy = new Proxy(window, {});
                     // in nest sandbox fetch will be bind to proxy rather than window in master
                     const proxyFetch = fetch.bind(proxy);
                     proxyFetch('https://qiankun.com');
                */
                const boundTarget = useNativeWindowForBindingsProps.get(p) ? nativeGlobal : globalContext;
                return rebindTarget2Fn(boundTarget, value);
            },

            // trap in operator
            // see https://github.com/styled-components/styled-components/blob/master/packages/styled-components/src/constants.js#L12
            has(target, p) {
                // property in cachedGlobalObjects must return true to avoid escape from get trap
                return p in cachedGlobalObjects || p in target || p in globalContext;
            },

            getOwnPropertyDescriptor(target, p) {
                /*
                 as the descriptor of top/self/window/mockTop in raw window are configurable but not in proxy target, we need to get it from target to avoid TypeError
                 see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
                 > A property cannot be reported as non-configurable, if it does not exist as an own property of the target object or if it exists as a configurable own property of the target object.
                 */
                if (target.hasOwnProperty(p)) {
                    const descriptor = Object.getOwnPropertyDescriptor(target, p);
                    descriptorTargetMap.set(p, 'target');
                    return descriptor;
                }

                if (globalContext.hasOwnProperty(p)) {
                    const descriptor = Object.getOwnPropertyDescriptor(globalContext, p);
                    descriptorTargetMap.set(p, 'globalContext');
                    // A property cannot be reported as non-configurable, if it does not exist as an own property of the target object
                    if (descriptor && !descriptor.configurable) {
                        descriptor.configurable = true;
                    }
                    return descriptor;
                }

                return undefined;
            },

            // trap to support iterator with sandbox
            ownKeys(target) {
                return uniq(Reflect.ownKeys(globalContext).concat(Reflect.ownKeys(target)));
            },

            defineProperty: (target, p, attributes) => {
                const from = descriptorTargetMap.get(p);
                /*
                 Descriptor must be defined to native window while it comes from native window via Object.getOwnPropertyDescriptor(window, p),
                 otherwise it would cause a TypeError with illegal invocation.
                 */
                switch (from) {
                    case 'globalContext':
                        return Reflect.defineProperty(globalContext, p, attributes);
                    default:
                        return Reflect.defineProperty(target, p, attributes);
                }
            },

            deleteProperty: (target, p) => {
                this.registerRunningApp(name, proxy);
                if (target.hasOwnProperty(p)) {
                    // @ts-ignore
                    delete target[p];
                    updatedValueSet.delete(p);

                    return true;
                }

                return true;
            },

            // makes sure `window instanceof Window` returns truthy in micro app
            getPrototypeOf() {
                return Reflect.getPrototypeOf(globalContext);
            },
        });

        this.proxy = proxy;

        activeSandboxCount++;

        function hasOwnProperty(that, key) {
            // calling from hasOwnProperty.call(obj, key)
            if (that !== proxy && that !== null && typeof that === 'object') {
                return Object.prototype.hasOwnProperty.call(that, key);
            }

            return fakeWindow.hasOwnProperty(key) || globalContext.hasOwnProperty(key);
        }
    }

    active() {
        if (!this.sandboxRunning) activeSandboxCount++;
        this.sandboxRunning = true;
    }

    inactive() {
        if (process.env.NODE_ENV === 'development') {
            console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
                ...this.updatedValueSet.keys(),
            ]);
        }

        if (inTest || --activeSandboxCount === 0) {
            Object.keys(this.globalWhitelistPrevDescriptor).forEach((p) => {
                const descriptor = this.globalWhitelistPrevDescriptor[p];
                if (descriptor) {
                    Object.defineProperty(this.globalContext, p, descriptor);
                } else {
                    delete this.globalContext[p];
                }
            });
        }

        this.sandboxRunning = false;
    }

    patchDocument(doc) {
        this.document = doc;
    }

    registerRunningApp(name, proxy) {
        if (this.sandboxRunning) {
          const currentRunningApp = getCurrentRunningApp();
          if (!currentRunningApp || currentRunningApp.name !== name) {
            setCurrentRunningApp({ name, window: proxy });
          }
          // FIXME if you have any other good ideas
          // remove the mark in next tick, thus we can identify whether it in micro app or not
          // this approach is just a workanextTaskround, it could not cover all complex cases, such as the micro app runs in the same task context with master in some case
          nextTask(clearCurrentRunningApp);
        }
    }
}
