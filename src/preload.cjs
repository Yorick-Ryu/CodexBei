const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('setup', {
  detect: () => ipcRenderer.invoke('setup:detect'),
  choose: () => ipcRenderer.invoke('setup:choose'),
  check: (file, selection) => ipcRenderer.invoke('setup:check', file, selection),
  inspect: (file) => ipcRenderer.invoke('setup:inspect', file),
  models: (file, key, baseUrl) => ipcRenderer.invoke('setup:models', file, key, baseUrl),
  onTemplates: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('setup:templates-changed', listener);
    return () => ipcRenderer.removeListener('setup:templates-changed', listener);
  },
  prepare: (file, key, baseUrl, model) => ipcRenderer.invoke('setup:prepare', file, key, baseUrl, model),
  incoming: () => ipcRenderer.invoke('setup:incoming'),
  onIncoming: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('setup:incoming-changed', listener);
    return () => ipcRenderer.removeListener('setup:incoming-changed', listener);
  },
  apply: (id) => ipcRenderer.invoke('setup:apply', id),
  backups: () => ipcRenderer.invoke('setup:backups'),
  restore: (id) => ipcRenderer.invoke('setup:restore', id),
  website: () => ipcRenderer.invoke('setup:website'),
  close: () => ipcRenderer.invoke('setup:close'),
});
