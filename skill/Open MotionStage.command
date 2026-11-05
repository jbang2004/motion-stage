#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 22 或更高版本。安装后重新打开此文件。"
  read -r -p "按回车关闭…"
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >/dev/null 2>&1; then
  echo "需要 Node.js 22 或更高版本。请升级 Node.js 后重新打开此文件。"
  read -r -p "按回车关闭…"
  exit 1
fi
node scripts/start.mjs
