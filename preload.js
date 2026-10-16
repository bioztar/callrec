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
  modelStatus: invoke('model:status'),
  modelDownload: invoke('model:download'),
  whisperStatus: invoke('whisper:status'),
  whisperDownload: invoke('whisper:download'),
  whisperCancel: invoke('whisper:cancel'),
  whisperChoose: invoke('whisper:choose'),
  whisperOpenDir: invoke('whisper:openDir'),
  sessionStart: invoke('session:start'),
  sessionStop: invoke('session:stop'),
  recChunk: (bytes) => ipcRenderer.send('session:audio', bytes),
  segment: (seg) => ipcRenderer.send('session:segment', seg),
  channelPcm: (speaker, buf, offsetSec) => ipcRenderer.send('session:pcm', speaker, buf, offsetSec),
  openFolder: invoke('shell:openFolder'),
  sttStart: invoke('stt:start'),
  sttChunk: (id, buf) => ipcRenderer.send('stt:chunk', id, buf),
  sttStop: (id) => ipcRenderer.send('stt:stop', id),
  on: (channel, fn) => {
    const allowed = ['stt:event', 'toggle-recording', 'stop-recording', 'start-recording', 'open-settings', 'model:progress', 'final:state'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
