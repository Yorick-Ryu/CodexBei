const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('setup', {
  detect: () => ipcRenderer.invoke('setup:detect'),
  choose: () => ipcRenderer.invoke('setup:choose'),
  check: (file, selection) => ipcRenderer.invoke('setup:check', file, selection),
  inspect: (file) => ipcRenderer.invoke('setup:inspect', file),
  updateTemplate: (file) => ipcRenderer.invoke('setup:update-template', file),
  models: (file, key, baseUrl) => ipcRenderer.invoke('setup:models', file, key, baseUrl),
  onTemplates: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('setup:templates-changed', listener);
    return () => ipcRenderer.removeListener('setup:templates-changed', listener);
  },
  preview: (baseUrl, model, keepOfficialLogin) => ipcRenderer.invoke('setup:preview', baseUrl, model, keepOfficialLogin),
  prepare: (file, key, baseUrl, model, keepOfficialLogin) => ipcRenderer.invoke('setup:prepare', file, key, baseUrl, model, keepOfficialLogin),
  incoming: () => ipcRenderer.invoke('setup:incoming'),
  configureIncoming: (file, revision, keepOfficialLogin) => ipcRenderer.invoke('setup:configure-incoming', file, revision, keepOfficialLogin),
  onIncoming: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('setup:incoming-changed', listener);
    return () => ipcRenderer.removeListener('setup:incoming-changed', listener);
  },
  apply: (id) => ipcRenderer.invoke('setup:apply', id),
  backups: () => ipcRenderer.invoke('setup:backups'),
  backupPreview: (id) => ipcRenderer.invoke('setup:backup-preview', id),
  deleteBackup: (id) => ipcRenderer.invoke('setup:delete-backup', id),
  restore: (id) => ipcRenderer.invoke('setup:restore', id),
});
