/*
 * @Author: zhongqifeng 1121021693@qq.com
 * @Date: 2024-02-26 18:18:32
 * @LastEditors: zhongqifeng 1121021693@qq.com
 * @LastEditTime: 2024-02-26 18:20:35
 * @FilePath: \qiankun-vue-demo\main\src\qiankunApi\sandbox\legacy\sandbox.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { rebindTarget2Fn } from '../common';

function isPropConfigurable(target, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(target, prop);
    return descriptor ? descriptor.configurable : true;
}


/**
 * 基于 Proxy 实现的沙箱
 * TODO: 为了兼容性 singular 模式下依旧使用该沙箱，等新沙箱稳定之后再切换
 */
class LegacySandbox {
    /** 沙箱期间新增的全局变量 */
    constructor(name, globalContext = window) {
        this.addedPropsMapInSandbox = new Map();
        /** 沙箱期间更新的全局变量 */
        this.modifiedPropsOriginalValueMapInSandbox = new Map();
        /** 持续记录更新的(新增和修改的)全局变量的 map，用于在任意时刻做 snapshot */
        this.currentUpdatedPropsValueMap = new Map();
        this.sandboxRunning = true;
        this.latestSetProp = null;
        this.name = name;
        this.globalContext = globalContext;
        this.type = SandBoxType.LegacyProxy;
        const { addedPropsMapInSandbox, modifiedPropsOriginalValueMapInSandbox, currentUpdatedPropsValueMap } = this;
        const rawWindow = globalContext;
        const fakeWindow = Object.create(null);
        const setTrap = (p, value, originalValue, sync2Window = true) => {
            if (this.sandboxRunning) {
                if (!rawWindow.hasOwnProperty(p)) {
                    addedPropsMapInSandbox.set(p, value);
                } else if (!modifiedPropsOriginalValueMapInSandbox.has(p)) {
                    modifiedPropsOriginalValueMapInSandbox.set(p, originalValue);
                }
                currentUpdatedPropsValueMap.set(p, value);
                if (sync2Window) {
                    rawWindow[p] = value;
                }
                this.latestSetProp = p;
                return true;
            }
            if (process.env.NODE_ENV === 'development') {
                console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
            }
            return true;
        };
        const proxy = new Proxy(fakeWindow, {
            set: (_, p, value) => {
                const originalValue = rawWindow[p];
                return setTrap(p, value, originalValue, true);
            },
            get: (_, p) => {
                if (p === 'top' || p === 'parent' || p === 'window' || p === 'self') {
                    return proxy;
                }
                const value = rawWindow[p];
                return rebindTarget2Fn(rawWindow, value);
            },
            has: (_, p) => {
                return p in rawWindow;
            },
            getOwnPropertyDescriptor: (_, p) => {
                const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
                if (descriptor && !descriptor.configurable) {
                    descriptor.configurable = true;
                }
                return descriptor;
            },
            defineProperty: (_, p, attributes) => {
                const originalValue = rawWindow[p];
                const done = Reflect.defineProperty(rawWindow, p, attributes);
                const value = rawWindow[p];
                setTrap(p, value, originalValue, false);
                return done;
            },
        });
        this.proxy = proxy;
    }
    active() {
        if (!this.sandboxRunning) {
            this.currentUpdatedPropsValueMap.forEach((v, p) => this.setWindowProp(p, v));
        }
        this.sandboxRunning = true;
    }
    inactive() {
        if (process.env.NODE_ENV === 'development') {
            console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
                ...this.addedPropsMapInSandbox.keys(),
                ...this.modifiedPropsOriginalValueMapInSandbox.keys(),
            ]);
        }
        this.modifiedPropsOriginalValueMapInSandbox.forEach((v, p) => this.setWindowProp(p, v));
        this.addedPropsMapInSandbox.forEach((_, p) => this.setWindowProp(p, undefined, true));
        this.sandboxRunning = false;
    }
    patchDocument() { }
    setWindowProp(prop, value, toDelete) {
        if (value === undefined && toDelete) {
            delete this.globalContext[prop];
        } else if (isPropConfigurable(this.globalContext, prop) && typeof prop !== 'symbol') {
            Object.defineProperty(this.globalContext, prop, { writable: true, configurable: true });
            this.globalContext[prop] = value;
        }
    }
}
export default LegacySandbox;
