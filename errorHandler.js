export { addErrorHandler, removeErrorHandler } from 'single-spa';

/* 添加全局的未捕获异常处理器 */
export function addGlobalUncaughtErrorHandler(errorHandler) {
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', errorHandler);
}
/* 移除全局的未捕获异常处理器。 */
export function removeGlobalUncaughtErrorHandler(errorHandler) {
  window.removeEventListener('error', errorHandler);
  window.removeEventListener('unhandledrejection', errorHandler);
}
