// Bridges the renderer to main-process IPC. The renderer has no Node access;
// every call goes through this fixed surface.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)
  .then(res => {
    if (!res || res.ok !== true) throw new Error(res && res.error ? res.error : 'IPC failed');
    return res.data;
  });

contextBridge.exposeInMainWorld('api', {
  catalog: call('catalog'),
  settings: { get: call('settings:get'), set: call('settings:set') },
  attempt: {
    resumable: call('attempt:resumable'),
    start: call('attempt:start'),
    get: call('attempt:get'),
    answer: call('attempt:answer'),
    confidence: call('attempt:confidence'),
    flag: call('attempt:flag'),
    notepad: call('attempt:notepad'),
    heartbeat: call('attempt:heartbeat'),
    finish: call('attempt:finish'),
    abandon: call('attempt:abandon'),
    remove: call('attempt:delete'),
  },
  history: { list: call('history:list') },
  analytics: { dashboard: call('analytics:dashboard') },
  revisit: { list: call('revisit:list'), add: call('revisit:add'), remove: call('revisit:remove') },
  drill: { build: call('drill:build') },
  mock: { next: call('mock:next'), summary: call('mock:summary') },
  data: {
    export: call('data:export'), import: call('data:import'), reveal: call('data:reveal'),
    exportPayload: call('data:exportPayload'), importPayload: call('data:importPayload'),
  },
  coach: {
    overview: call('coach:overview'),
    diagnostics: call('coach:diagnostics'),
    plan: call('coach:plan'),
    complete: call('coach:complete'),
    history: call('coach:history'),
    tagError: call('coach:tagError'),
    scaled: call('coach:scaled'),
  },
  review: {
    summary: call('review:summary'),
    list: call('review:list'),
    all: call('review:all'),
    stubborn: call('review:stubborn'),
    session: call('review:session'),
  },
  archive: {
    list: call('archive:list'),
    create: call('archive:create'),
    restore: call('archive:restore'),
  },
  offline: { record: call('offline:record') },
  pdf: {
    paper: call('pdf:paper'), drill: call('pdf:drill'),
    paperTo: call('pdf:paperTo'), drillTo: call('pdf:drillTo'),
  },
  debug: {
    blockedRequests: call('debug:blockedRequests'),
    srsSimulate: call('debug:srsSimulate'),
    srsSeed: call('debug:srsSeed'),
  },
});
