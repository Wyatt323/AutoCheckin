const text = value => value == null ? '' : String(value).trim();
function resolveCredentials(config, user) {
  const telegram = config.telegram || {};
  const rawId = text(user.api_id) || text(telegram.api_id);
  const apiId = Number(rawId);
  const apiHash = text(user.api_hash) || text(telegram.api_hash);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(apiId) || apiId <= 0) throw new Error('Telegram API ID 缺失或无效（账号覆盖 / 全局配置）');
  if (!apiHash) throw new Error('Telegram API Hash 缺失（账号覆盖 / 全局配置）');
  return { apiId, apiHash };
}
module.exports = { resolveCredentials, credentialText: text };
