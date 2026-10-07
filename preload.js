'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('callrec', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  setDeepgramKey: invoke('settings:setKey'),
  pickFolder: invoke('settings:pickFolder'),
  permStatus: invoke('perm:status'),
  askMic: invoke('perm:askMic'),
  openPane: invoke('perm:open'),
  sessionStart: invoke('session:start'),
  sessionStop: invoke('session:stop'),
  recChunk: (bytes) => ipcRenderer.send('session:audio', bytes),
  segment: (seg) => ipcRenderer.send('session:segment', seg),
  openFolder: invoke('shell:openFolder'),
  sttStart: invoke('stt:start'),
  sttChunk: (id, buf) => ipcRenderer.send('stt:chunk', id, buf),
  sttStop: (id) => ipcRenderer.send('stt:stop', id),
  on: (channel, fn) => {
    const allowed = ['stt:event', 'toggle-recording', 'open-settings'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
