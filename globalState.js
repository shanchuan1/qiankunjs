import { cloneDeep } from 'lodash';

let globalState = {};

const deps = {};

// 触发全局监听
function emitGlobal(state, prevState) {
  Object.keys(deps).forEach((id) => {
    if (deps[id] instanceof Function) {
      deps[id](cloneDeep(state), cloneDeep(prevState));
    }
  });
}

/*
定义全局状态，并返回通信方法，建议在主应用使用，微应用通过 props 获取通信方法
*/
export function initGlobalState(state = {}) {
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[qiankun] globalState tools will be removed in 3.0, pls don't use it!`);
  }

  if (state === globalState) {
    console.warn('[qiankun] state has not changed！');
  } else {
    const prevGlobalState = cloneDeep(globalState);
    globalState = cloneDeep(state);
    emitGlobal(globalState, prevGlobalState);
  }
  return getMicroAppStateActions(`global-${+new Date()}`, true);
}

/*
获取微应用状态方法的action
*/
export function getMicroAppStateActions(id, isMaster) {
  return {
    /**
     * onGlobalStateChange 全局依赖监听
     *
     * 收集 setState 时所需要触发的依赖
     *
     * 限制条件：每个子应用只有一个激活状态的全局监听，新监听覆盖旧监听，若只是监听部分属性，请使用 onGlobalStateChange
     *
     * 这么设计是为了减少全局监听滥用导致的内存爆炸
     *
     * 依赖数据结构为：
     * {
     *   {id}: callback
     * }
     *
     * @param callback
     * @param fireImmediately
     */
    onGlobalStateChange(callback, fireImmediately) {
      if (!(callback instanceof Function)) {
        console.error('[qiankun] callback must be function!');
        return;
      }
      if (deps[id]) {
        console.warn(`[qiankun] '${id}' global listener already exists before this, new listener will overwrite it.`);
      }
      deps[id] = callback;
      if (fireImmediately) {
        const cloneState = cloneDeep(globalState);
        callback(cloneState, cloneState);
      }
    },

    /**
     * setGlobalState 更新 store 数据
     *
     * 1. 对输入 state 的第一层属性做校验，只有初始化时声明过的第一层（bucket）属性才会被更改
     * 2. 修改 store 并触发全局监听
     *
     * @param state
     */
    setGlobalState(state= {}) {
      if (state === globalState) {
        console.warn('[qiankun] state has not changed！');
        return false;
      }

      const changeKeys = [];
      const prevGlobalState = cloneDeep(globalState);
      globalState = cloneDeep(
        Object.keys(state).reduce((_globalState, changeKey) => {
          if (isMaster || _globalState.hasOwnProperty(changeKey)) {
            changeKeys.push(changeKey);
            return Object.assign(_globalState, { [changeKey]: state[changeKey] });
          }
          console.warn(`[qiankun] '${changeKey}' not declared when init state！`);
          return _globalState;
        }, globalState),
      );
      if (changeKeys.length === 0) {
        console.warn('[qiankun] state has not changed！');
        return false;
      }
      emitGlobal(globalState, prevGlobalState);
      return true;
    },

    // 注销该应用下的依赖
    offGlobalStateChange() {
      delete deps[id];
      return true;
    },
  };
}
