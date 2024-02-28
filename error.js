/*
 * @Author: zhongqifeng 1121021693@qq.com
 * @Date: 2024-02-27 14:01:21
 * @LastEditors: zhongqifeng 1121021693@qq.com
 * @LastEditTime: 2024-02-27 15:28:13
 * @FilePath: \qiankun-vue-demo\main\src\qiankunjs\error.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/*
qiankun错误方法类
*/
export class QiankunError extends Error {
    constructor(message) {
      super(`[qiankun]: ${message}`);
    }
  }
  