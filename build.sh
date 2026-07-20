#!/usr/bin/env bash
# Build zotero-rsvp.xpi from source
set -e

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUTPUT="zotero-rsvp-${VERSION}.xpi"

zip -r "../${OUTPUT}" . \
  --exclude "*.DS_Store" \
  --exclude "*.git*" \
  --exclude ".gitignore" \
  --exclude "README*" \
  --exclude "LICENSE*" \
  --exclude "build.sh" \
  --exclude "*.xpi"

echo "Built: ../${OUTPUT}"