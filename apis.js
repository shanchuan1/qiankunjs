import { noop } from 'lodash';
import { mountRootParcel, registerApplication, start as startSingleSpa } from 'single-spa';
import { loadApp } from './loader';
import { doPrefetchStrategy } from './prefetch';
import { Deferred, getContainerXPath, isConstDestructAssignmentSupported, toArray } from './utils';

let microApps = [];

export let frameworkConfiguration = {};

let started = false;
const defaultUrlRerouteOnly = true;

const frameworkStartedDefer = new Deferred();

/* 低版本浏览器的自动降级 */
const autoDowngradeForLowVersionBrowser = (configuration) => {
    const { sandbox = true, singular } = configuration;
    if (sandbox) {
        if (!window.Proxy) {
            console.warn('[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox');

            if (singular === false) {
                console.warn(
                    '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
                );
            }

            return { ...configuration, sandbox: typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true } };
        }

        if (
            !isConstDestructAssignmentSupported() &&
            (sandbox === true || (typeof sandbox === 'object' && sandbox.speedy !== false))
        ) {
            console.warn(
                '[qiankun] Speedy mode will turn off as const destruct assignment not supported in current browser!',
            );

            return {
                ...configuration,
                sandbox: typeof sandbox === 'object' ? { ...sandbox, speedy: false } : { speedy: false },
            };
        }
    }

    return configuration;
};


/*
 在主应用中调用微应用 基于路由配置
 当微应用信息注册完之后，一旦浏览器的 url 发生变化，便会自动触发 qiankun 的匹配逻辑，所有 activeRule 规则匹配上的微应用就会被插入到指定的 container 中，同时依次调用微应用暴露出的生命周期钩子
 基于single-spa库的registerApplication二次封装的函数registerMicroApps： 注册微应用 （重新规划定义函数的入参与调用的作用）
 例子：
 registerMicroApps([
    {
      name: 'react app', // app name registered
      entry: '//localhost:7100',
      container: '#yourContainer',
      activeRule: '/yourActiveRule',
    },
    {
      name: 'vue app',
      entry: { scripts: ['//localhost:7100/main.js'] },
      container: '#yourContainer2',
      activeRule: '/yourActiveRule2',
    },
  ]);
*/
export function registerMicroApps(
    apps,
    lifeCycles,
) {
    // Each app only needs to be registered once
    const unregisteredApps = apps.filter((app) => !microApps.some((registeredApp) => registeredApp.name === app.name));

    microApps = [...microApps, ...unregisteredApps];

    unregisteredApps.forEach((app) => {
        const { name, activeRule, loader = noop, props, ...appConfig } = app;

        registerApplication({
            name,
            app: async () => {
                loader(true);
                await frameworkStartedDefer.promise;
                console.log(
                    '🚀 ~ app: ~ { name, props, ...appConfig }, frameworkConfiguration, lifeCycles:',
                    { name, props, ...appConfig },
                    frameworkConfiguration,
                    lifeCycles,
                );
                const { mount, ...otherMicroAppConfigs } = (
                    await loadApp({ name, props, ...appConfig }, frameworkConfiguration, lifeCycles)
                )();

                return {
                    mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
                    ...otherMicroAppConfigs,
                };
            },
            activeWhen: activeRule,
            customProps: props,
        });
    });
}

const appConfigPromiseGetterMap = new Map();
const containerMicroAppsMap = new Map();


/*
如果微应用不是直接跟路由关联的时候，可以选择手动加载微应用
例子：
loadMicroApp({
  name: 'app',
  entry: '//localhost:7100',
  container: '#yourContainer',
});
*/
export function loadMicroApp(
    app,
    configuration,
    lifeCycles,
) {
    const { props, name } = app;

    const container = 'container' in app ? app.container : undefined;
    // Must compute the container xpath at beginning to keep it consist around app running
    // If we compute it every time, the container dom structure most probably been changed and result in a different xpath value
    const containerXPath = getContainerXPath(container);
    const appContainerXPathKey = `${name}-${containerXPath}`;

    let microApp;
    const wrapParcelConfigForRemount = (config) => {
        let microAppConfig = config;
        if (container) {
            if (containerXPath) {
                const containerMicroApps = containerMicroAppsMap.get(appContainerXPathKey);
                if (containerMicroApps?.length) {
                    const mount = [
                        async () => {
                            // While there are multiple micro apps mounted on the same container, we must wait until the prev instances all had unmounted
                            // Otherwise it will lead some concurrent issues
                            const prevLoadMicroApps = containerMicroApps.slice(0, containerMicroApps.indexOf(microApp));
                            const prevLoadMicroAppsWhichNotBroken = prevLoadMicroApps.filter(
                                (v) => v.getStatus() !== 'LOAD_ERROR' && v.getStatus() !== 'SKIP_BECAUSE_BROKEN',
                            );
                            await Promise.all(prevLoadMicroAppsWhichNotBroken.map((v) => v.unmountPromise));
                        },
                        ...toArray(microAppConfig.mount),
                    ];

                    microAppConfig = {
                        ...config,
                        mount,
                    };
                }
            }
        }

        return {
            ...microAppConfig,
            // empty bootstrap hook which should not run twice while it calling from cached micro app
            bootstrap: () => Promise.resolve(),
        };
    };

    /**
     * using name + container xpath as the micro app instance id, 使用名称+容器xpath作为微应用实例id
     * it means if you rendering a micro app to a dom which have been rendered before,
     * the micro app would not load and evaluate its lifecycles again
     */
    const memorizedLoadingFn = async () => {
        const userConfiguration = autoDowngradeForLowVersionBrowser(
            configuration ?? { ...frameworkConfiguration, singular: false },
        );
        const { $$cacheLifecycleByAppName } = userConfiguration;

        if (container) {
            // using appName as cache for internal experimental scenario
            if ($$cacheLifecycleByAppName) {
                const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(name);
                if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
            }

            if (containerXPath) {
                const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(appContainerXPathKey);
                if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
            }
        }

        const parcelConfigObjectGetterPromise = loadApp(app, userConfiguration, lifeCycles);
        console.log('🚀 ~ memorizedLoadingFn ~ parcelConfigObjectGetterPromise:', parcelConfigObjectGetterPromise)

        if (container) {
            if ($$cacheLifecycleByAppName) {
                appConfigPromiseGetterMap.set(name, parcelConfigObjectGetterPromise);
            } else if (containerXPath) appConfigPromiseGetterMap.set(appContainerXPathKey, parcelConfigObjectGetterPromise);
        }

        return (await parcelConfigObjectGetterPromise)(container);
    };

    if (!started && configuration?.autoStart !== false) {
        // We need to invoke start method of single-spa as the popstate event should be dispatched while the main app calling pushState/replaceState automatically,
        // but in single-spa it will check the start status before it dispatch popstate
        // see https://github.com/single-spa/single-spa/blob/f28b5963be1484583a072c8145ac0b5a28d91235/src/navigation/navigation-events.js#L101
        // ref https://github.com/umijs/qiankun/pull/1071
        startSingleSpa({ urlRerouteOnly: frameworkConfiguration.urlRerouteOnly ?? defaultUrlRerouteOnly });
    }

    microApp = mountRootParcel(memorizedLoadingFn, { domElement: document.createElement('div'), ...props });

    if (container) {
        if (containerXPath) {
            // Store the microApps which they mounted on the same container
            const microAppsRef = containerMicroAppsMap.get(appContainerXPathKey) || [];
            microAppsRef.push(microApp);
            containerMicroAppsMap.set(appContainerXPathKey, microAppsRef);

            const cleanup = () => {
                const index = microAppsRef.indexOf(microApp);
                microAppsRef.splice(index, 1);
                // @ts-ignore
                microApp = null;
            };

            // gc after unmount
            microApp.unmountPromise.then(cleanup).catch(cleanup);
        }
    }
    console.log('🚀 ~ microApp:', microApp);
    return microApp;
}




/*
  在调用 start 之前, 应用会被加载, 但不会初始化
  single-spa的start API
  加载完应用后初始化（挂载）
  */
export function start(opts) {
    frameworkConfiguration = { prefetch: true, singular: true, sandbox: true, ...opts };
    const { prefetch, urlRerouteOnly = defaultUrlRerouteOnly, ...importEntryOpts } = frameworkConfiguration;

    if (prefetch) {
        doPrefetchStrategy(microApps, prefetch, importEntryOpts);
    }

    frameworkConfiguration = autoDowngradeForLowVersionBrowser(frameworkConfiguration);

    startSingleSpa({ urlRerouteOnly });
    started = true;

    frameworkStartedDefer.resolve();
}
