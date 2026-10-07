const fs = require('node:fs');
const path = require('node:path');

async function createDatabase({ dataDir, parseConfig, pool: suppliedPool } = {}) {
  if (!suppliedPool && !process.env.DATABASE_URL && !process.env.PGHOST) return null;
  const pool = suppliedPool || new (require('pg').Pool)({ ...(process.env.DATABASE_URL ? { connectionString:process.env.DATABASE_URL } : {}), max:4, connectionTimeoutMillis:10000, query_timeout:15000, statement_timeout:15000, application_name:'AutoCheckin web' });
  pool.on?.('error', () => console.error('数据库空闲连接已断开，将在下次请求时重新连接'));
  const documents = new Map();
  let client;
  let failed = false;
  let importedCount = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42837123)');
    await client.query('CREATE TABLE IF NOT EXISTS autocheckin_documents (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const migrated = await client.query("SELECT key FROM autocheckin_documents WHERE key = 'migration:files-v1'");
    if (!migrated.rows.length) {
      const imports = [['config', 'config.json'], ['checkin-state', '.checkin-schedule-state.json'], ['automation-state', '.automation-state.json'], ['run-history', 'logs/run-history.json']];
      for (const [prefix, folder] of [['profile:', '.account-profiles'], ['discovery:', '.bot-discovery']]) {
        const directory = path.join(dataDir, folder);
        if (fs.existsSync(directory)) for (const file of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) imports.push([prefix + file.slice(0, -5), `${folder}/${file}`]);
      }
      let imported = 0;
      for (const [key, file] of imports) {
        const target = path.join(dataDir, file);
        if (!fs.existsSync(target)) continue;
        const value = key === 'config' ? parseConfig(fs.readFileSync(target, 'utf8')) : JSON.parse(fs.readFileSync(target, 'utf8'));
        const result = await client.query('INSERT INTO autocheckin_documents(key, value) VALUES($1, $2::jsonb) ON CONFLICT(key) DO NOTHING', [key, JSON.stringify(value)]);
        imported += result.rowCount;
      }
      await client.query("INSERT INTO autocheckin_documents(key, value) VALUES('migration:files-v1', $1::jsonb)", [JSON.stringify({ imported, at:new Date().toISOString() })]);
      importedCount = imported;
    }
    await client.query('COMMIT');
    if (importedCount !== null) console.log(`旧数据迁移完成：${importedCount} 项；源文件已保留。`);
    for (const row of (await client.query('SELECT key, value FROM autocheckin_documents')).rows) documents.set(row.key, row.value);
    if (!documents.has('config')) throw new Error('数据库中缺少配置，请检查首次迁移的数据目录');
  } catch (error) {
    failed = true;
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client?.release(); if (failed) await pool.end(); }
  let queue = Promise.resolve();
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function write(key, value) {
    const serialized = JSON.stringify(value);
    return enqueue(async () => {
      await pool.query('INSERT INTO autocheckin_documents(key, value) VALUES($1, $2::jsonb) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, serialized]);
      documents.set(key, JSON.parse(serialized));
    });
  }
  function refresh(key) {
    // A slow SELECT must not overwrite a newer write in the shared cache.
    return enqueue(async () => {
      const result = await pool.query('SELECT value FROM autocheckin_documents WHERE key = $1', [key]);
      if (result.rows.length) documents.set(key, result.rows[0].value); else documents.delete(key);
      return documents.get(key);
    });
  }
  return { read:key => documents.get(key), write, refresh, keys:() => [...documents.keys()], async close() { await queue; await pool.end(); } };
}
module.exports = { createDatabase };
