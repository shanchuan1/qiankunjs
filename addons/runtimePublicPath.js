/*
 * @Author: zhongqifeng 1121021693@qq.com
 * @Date: 2024-02-27 15:25:59
 * @LastEditors: zhongqifeng 1121021693@qq.com
 * @LastEditTime: 2024-02-27 15:27:17
 * @FilePath: \qiankun-vue-demo\main\src\qiankunjs\addons\runtimePublicPath.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @author Kuitos
 * @since 2019-11-12
 */
const rawPublicPath = window.__INJECTED_PUBLIC_PATH_BY_QIANKUN__;

export default function getAddOn(global, publicPath = '/') {
  let hasMountedOnce = false;

  return {
    async beforeLoad() {
      // eslint-disable-next-line no-param-reassign
      global.__INJECTED_PUBLIC_PATH_BY_QIANKUN__ = publicPath;
    },

    async beforeMount() {
      if (hasMountedOnce) {
        // eslint-disable-next-line no-param-reassign
        global.__INJECTED_PUBLIC_PATH_BY_QIANKUN__ = publicPath;
      }
    },

    async beforeUnmount() {
      if (rawPublicPath === undefined) {
        // eslint-disable-next-line no-param-reassign
        delete global.__INJECTED_PUBLIC_PATH_BY_QIANKUN__;
      } else {
        // eslint-disable-next-line no-param-reassign
        global.__INJECTED_PUBLIC_PATH_BY_QIANKUN__ = rawPublicPath;
      }

      hasMountedOnce = true;
    },
  };
}
