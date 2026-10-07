const assert = require('node:assert/strict');
const { createDatabase } = require('../database');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

(async () => {
  let ended = false;
  await assert.rejects(createDatabase({ pool: {
    connect: async () => { throw new Error('offline connection failure'); },
    end: async () => { ended = true; }
  }}), /offline connection failure/);
  assert.ok(ended, 'failed startup releases the pool');

  const calls = [];
  const pool = {
    async connect() {
      return {
        release() {},
        async query(sql) {
          if (sql.startsWith('SELECT key, value')) return { rows:[{ key:'config', value:{ version:1 } }] };
          if (sql.startsWith('SELECT key')) return { rows:[{ key:'migration:files-v1' }] };
          return { rows:[] };
        }
      };
    },
    query(sql, args) { const call = { sql, args, ...deferred() }; calls.push(call); return call.promise; },
    async end() { ended = true; }
  };
  ended = false;
  const store = await createDatabase({ pool });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  // An old SELECT used to finish after the write and roll the cache back to version 1.
  const refresh = store.refresh('config');
  const write = store.write('config', { version:2 });
  await turn();
  assert.equal(calls.length, 1, 'write waits for the earlier refresh');
  calls[0].resolve({ rows:[{ value:{ version:1 } }] });
  await refresh; await turn();
  assert.equal(calls.length, 2);
  calls[1].resolve({ rows:[] }); await write;
  assert.equal(store.read('config').version, 2);

  const failed = store.write('config', { version:3 });
  const rejection = assert.rejects(failed, /offline write failure/);
  const next = store.refresh('config');
  await turn(); calls[2].reject(new Error('offline write failure'));
  await rejection; await turn();
  assert.equal(store.read('config').version, 2, 'failed writes do not change committed cache');
  assert.equal(calls.length, 4, 'failed operations do not block the queue');
  const closing = store.close();
  await turn(); assert.equal(ended, false, 'close waits for outstanding refreshes');
  calls[3].resolve({ rows:[{ value:{ version:4 } }] });
  await next; await closing;
  assert.equal(store.read('config').version, 4);
  assert.ok(ended);
  console.log('Database cache PASS: ordered refresh/write, failed-write rollback, queue recovery, startup/close cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
