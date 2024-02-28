import { isFunction, noop } from 'lodash';


export default function patch() {
  let rawHistoryListen = (_) => noop;
  const historyListeners = [];
  const historyUnListens = [];

  if (window.g_history && typeof window.g_history.listen === 'function') {
    rawHistoryListen = window.g_history.listen.bind(window.g_history);

    window.g_history.listen = (listener) => {
      historyListeners.push(listener);

      const unListen = rawHistoryListen(listener);
      historyUnListens.push(unListen);

      return () => {
        unListen();
        historyUnListens.splice(historyUnListens.indexOf(unListen), 1);
        historyListeners.splice(historyListeners.indexOf(listener), 1);
      };
    };
  }

  return function free() {
    let rebuild = noop;

    if (historyListeners.length) {
      rebuild = () => {
        historyListeners.forEach((listener) => window.g_history.listen(listener));
      };
    }

    historyUnListens.forEach((unListen) => unListen());

    if (window.g_history && typeof window.g_history.listen === 'function') {
      window.g_history.listen = rawHistoryListen;
    }

    return rebuild;
  };
}
