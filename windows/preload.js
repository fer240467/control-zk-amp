const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  onDevices: (cb) => { ipcRenderer.removeAllListeners('ble-devices'); ipcRenderer.on('ble-devices', (_e, list) => cb(list)); },
  choose: (id) => ipcRenderer.send('ble-choose', id),
  cancelChoose: () => ipcRenderer.send('ble-cancel'),
  openUrl: (url) => ipcRenderer.send('open-url', url),
});
