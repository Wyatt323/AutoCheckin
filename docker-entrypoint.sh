#!/bin/sh
set -eu

DATA_DIR="${AUTOCHECKIN_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
if [ ! -f "$DATA_DIR/config.json" ]; then
  umask 077
  cp /app/config.example.json "$DATA_DIR/config.json"
  echo "已创建初始配置：$DATA_DIR/config.json"
fi
exec "$@"
