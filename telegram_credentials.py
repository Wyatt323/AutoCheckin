"""Resolve Telegram credentials at runtime, without mutating stored accounts."""


def resolve_credentials(config, user):
    telegram = config.get("telegram") or {}
    def value(item):
        return "" if item is None else str(item).strip()
    api_id = value(user.get("api_id")) or value(telegram.get("api_id"))
    api_hash = value(user.get("api_hash")) or value(telegram.get("api_hash"))
    if not api_id.isascii() or not api_id.isdigit() or not 0 < int(api_id) <= 9007199254740991:
        raise ValueError("Telegram API ID 缺失或无效（账号覆盖 / 全局配置）")
    if not api_hash:
        raise ValueError("Telegram API Hash 缺失（账号覆盖 / 全局配置）")
    return int(api_id), api_hash
