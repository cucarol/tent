import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("loading SQLite hides only its experimental notice and restores warning/error delivery", async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const emit=process.emitWarning;
    const {DatabaseSync}=await import('./src/fs/sqlite-runtime.ts');
    if(process.emitWarning!==emit)throw Error('warning handler leaked');
    const db=new DatabaseSync(':memory:');
    try {db.exec('INVALID SQL');}catch(e){console.error('REAL SQLITE ERROR: '+e.message);}
    db.close();
    process.emitWarning('REAL OTHER EXPERIMENTAL',{type:'ExperimentalWarning'});
    process.emitWarning('REAL WARNING',{type:'Warning'});
    console.log('SQLITE READY');
  `,
    ],
    { windowsHide: true },
  );
  assert.match(stdout, /SQLITE READY/);
  assert.doesNotMatch(stderr, /SQLite is an experimental feature/);
  assert.match(stderr, /REAL SQLITE ERROR/);
  assert.match(stderr, /ExperimentalWarning: REAL OTHER EXPERIMENTAL/);
  assert.match(stderr, /Warning: REAL WARNING/);
});
