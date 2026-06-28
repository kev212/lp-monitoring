#!/bin/bash
cd /root/lp-monitoring
exec > /tmp/lp-bot.log 2>&1
export PATH="$PATH:$(pwd)/node_modules/.bin"
npx tsx src/index.ts
