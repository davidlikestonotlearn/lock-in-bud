const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const project = path.join(__dirname, '..');
const code = (file) => fs.readFileSync(path.join(project, file), 'utf8');

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    fire: (...args) => [...listeners].map((listener) => listener(...args)),
  };
}

function fakeExtension({ fetchImpl = async () => { throw new Error('No backend configured'); } } = {}) {
  const data = {};
  let failWrite = false;
  const alarms = new Map();
  const onChanged = event();
  const onAlarm = event();
  const action = { onClicked: event() };
  const openedTabs = [];
  const tabs = { async create(tab) { openedTabs.push(tab); } };
  const runtime = { id: 'test-extension', getURL: (file) => `chrome-extension://test-extension/${file}`, onStartup: event(), onInstalled: event() };
  const local = {
    async get(key) {
      // Yield like a real asynchronous API, exposing read/write races in tests.
      await new Promise((resolve) => setImmediate(resolve));
      return { [key]: data[key] && structuredClone(data[key]) };
    },
    async set(values) {
      if (failWrite) {
        failWrite = false;
        throw new Error('Storage quota exceeded');
      }
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
        data[key] = structuredClone(value);
      }
      onChanged.fire(changes, 'local');
    },
  };
  const alarmAPI = {
    onAlarm,
    async get(name) { return alarms.get(name); },
    async create(name, info) { alarms.set(name, { name, scheduledTime: info.when }); },
    async clear(name) { return alarms.delete(name); },
  };
  let worker;
  function wakeWorker() {
    runtime.onMessage = event();
    worker = vm.createContext({ crypto: webcrypto, console, URL, AbortController, setTimeout, clearTimeout, fetch: fetchImpl,
      chrome: { runtime, action, tabs, storage: { local, onChanged }, alarms: alarmAPI },
    });
    worker.importScripts = (...files) => files.forEach((file) => vm.runInContext(code(file), worker));
    vm.runInContext(code('background.js'), worker);
  }
  wakeWorker();

  function client(url) {
    let currentURL = url;
    const tabChrome = {
      runtime: { id: runtime.id,
        sendMessage: (request) => new Promise((resolve) => {
          runtime.onMessage.fire(request, { id: runtime.id, url: currentURL }, resolve);
        }),
      },
      storage: { onChanged },
    };
    const context = vm.createContext({ chrome: tabChrome, location: new URL(url), crypto: webcrypto });
    vm.runInContext(code('session.js'), context);
    vm.runInContext(code('analysis.js'), context);
    vm.runInContext(code('storage.js'), context);
    const store = context.LockInBuddyStore.createClient();
    store.navigate = (nextURL) => { currentURL = nextURL; };
    return store;
  }
  return { client, data, alarms, wakeWorker, onAlarm, action, openedTabs, failNextWrite() { failWrite = true; } };
}


module.exports = { fakeExtension };
