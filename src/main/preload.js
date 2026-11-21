'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  pendingOpen: () => ipcRenderer.invoke('app:pendingOpen'),
  chooseDir: () => ipcRenderer.invoke('dir:choose'),
  openDir: () => ipcRenderer.send('shell:openDir'),

  listImages: () => ipcRenderer.invoke('images:list'),
  readImage: (file) => ipcRenderer.invoke('image:read', file),
  thumb: (file) => ipcRenderer.invoke('thumb:get', file),
  remember: (file) => ipcRenderer.invoke('image:remember', file),
  openDialog: () => ipcRenderer.invoke('image:open'),

  save: (payload) => ipcRenderer.invoke('image:save', payload),
  saveAs: (payload) => ipcRenderer.invoke('image:saveAs', payload),
  importImage: (payload) => ipcRenderer.invoke('image:import', payload),
  copyImage: (data) => ipcRenderer.invoke('clipboard:writeImage', data),

  writeTemp: (payload) => ipcRenderer.invoke('temp:write', payload),
  writeTempSync: (payload) => ipcRenderer.sendSync('temp:writeSync', payload),
  startDrag: (file) => ipcRenderer.send('drag:start', file),

  reveal: (file) => ipcRenderer.send('shell:reveal', file),
  setDirty: (count) => ipcRenderer.send('app:dirty', count),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  onImagesChanged: (cb) => ipcRenderer.on('images:changed', () => cb()),
  onOpenFile: (cb) => ipcRenderer.on('file:open', (_e, file) => cb(file)),
});
