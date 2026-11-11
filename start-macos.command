#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"

node_supported() {
  "$1" -e 'const [m,n]=process.versions.node.split(".").map(Number);process.exit(m>24||m===24&&n>=9?0:1)' 2>/dev/null
}

if ! node_supported node || ! command -v npm >/dev/null; then
  for dir in /opt/homebrew/opt/node@24/bin /opt/homebrew/bin /usr/local/opt/node@24/bin /usr/local/bin "$HOME"/.nvm/versions/node/*/bin; do
    if [[ -x "$dir/node" && -x "$dir/npm" ]] && node_supported "$dir/node"; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi
if ! node_supported node || ! command -v npm >/dev/null; then
  echo '请先安装 Node.js 24.9 或更新版本，再打开此文件。'
  exit 1
fi

if [[ ! -f node_modules/.bin/dsh ]]; then npm ci; fi
if [[ ! -f desktop/node_modules/.bin/dsh-pet-standalone ]]; then npm --prefix desktop ci; fi
npm run init
exec npm start
