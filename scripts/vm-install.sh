#!/usr/bin/env bash
# Run on the VM (or via ssh) after the Mac local registry is up.
# Installs a versioned ezenciel-agents build as if it came from npm.
set -euo pipefail

REGISTRY="${EZ_LOCAL_REGISTRY:?Set EZ_LOCAL_REGISTRY to the Mac registry, e.g. http://192.168.64.1:4873/}"
VERSION="${EZ_PACKAGE_VERSION:-latest}"
DIR="${EZ_INSTALL_DIR:-$HOME/ezenciel-agents}"
PACKAGE="${EZ_PACKAGE_NAME:-ezenciel-agents}"

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@10.30.3 --activate
  else
    echo 'Need Node 22+ with corepack or pnpm on the PATH.' >&2
    exit 1
  fi
fi

mkdir -p "$DIR/agent"
cd "$DIR"

if [[ ! -f package.json ]]; then
  pnpm init
fi

cat > .npmrc <<EOF
registry=${REGISTRY}
onlyBuiltDependencies[]=esbuild
EOF

if [[ ! -f .env && -f node_modules/${PACKAGE}/.env.example ]]; then
  cp "node_modules/${PACKAGE}/.env.example" .env
fi

rm -rf node_modules
pnpm add "${PACKAGE}@${VERSION}" --registry "$REGISTRY"

if [[ ! -f .env && -f node_modules/${PACKAGE}/.env.example ]]; then
  cp "node_modules/${PACKAGE}/.env.example" .env
fi

pnpm exec ezenciel-agents-setup init

INSTALLED="$(node -p "require('./node_modules/${PACKAGE}/package.json').version")"
echo "Installed ${PACKAGE}@${INSTALLED} from ${REGISTRY}"
echo "Workspace: ${DIR}"
echo "Start:     cd ${DIR} && pnpm exec ezenciel-agents"
echo "Owner:     cd ${DIR} && pnpm exec ezenciel-agents-owner status"
