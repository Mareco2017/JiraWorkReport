const {contextBridge, ipcRenderer} = require('electron');
// 只暴露业务调用与进度，渲染页面接触不到文件系统或认证头。
contextBridge.exposeInMainWorld('workbench', {
  call: (command, payload) => ipcRenderer.invoke('workbench:call', command, payload),
  onUpdate: callback => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('workbench:update', handler);
    return () => ipcRenderer.removeListener('workbench:update',handler);
  }
});
