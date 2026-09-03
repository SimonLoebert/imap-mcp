#!/bin/sh
set -e

echo "Applying database schema (drizzle-kit push)..."
npx drizzle-kit push --force

exec node server.js
