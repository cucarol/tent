const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { promisify } = require('node:util');
const trace = process.env.TENT_REVIEW_TRACE;
let serial = 0;
function log(value) {
  if (trace) fs.appendFileSync(trace, JSON.stringify(value) + '\n');
}
for (const api of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[api];
  cp[api] = function (file, args, ...rest) {
    if (!/^git(?:\.exe|\.cmd)?$/i.test(path.basename(String(file)))) {
      return original.call(this, file, args, ...rest);
    }
    const id = ++serial;
    const options = rest.find(value => value && typeof value === 'object');
    log({ event: 'start', id, api, hostPid: process.pid, at: new Date().toISOString(), file, args,
      indexFile: options?.env?.GIT_INDEX_FILE ?? null, cwd: options?.cwd ?? null });
    try {
      const child = original.call(this, file, args, ...rest);
      if (child && typeof child.once === 'function') {
        log({ event: 'spawned', id, pid: child.pid });
        child.once('close', (code, signal) => log({ event: 'close', id, code, signal }));
      } else log({ event: 'returned', id, pid: child?.pid, status: child?.status });
      return child;
    } catch (error) {
      log({ event: 'throw', id, status: error.status, message: error.message });
      throw error;
    }
  };
  if (api === 'execFile') {
    const wrapped = cp[api];
    Object.defineProperty(wrapped, promisify.custom, { value: function (...args) {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = wrapped(...args, (error, stdout, stderr) => {
          if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
          else resolve({ stdout, stderr });
        });
      });
      promise.child = child;
      return promise;
    } });
  }
}
syncBuiltinESMExports();
