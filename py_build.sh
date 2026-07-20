#!/usr/bin/env bash
# Build zotero-rsvp.xpi from source
set -e

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUTPUT="zotero-rsvp-${VERSION}.xpi"

echo "Zipping files..."
python3 -c "
import zipfile, os, re

# Files to exclude
exclude_patterns = [r'\.DS_Store', r'\.git', r'\.gitignore', r'README.*', r'LICENSE.*', r'build\.sh', r'.*\.xpi']
output_path = '../$OUTPUT'

with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk('.'):
        for file in files:
            full_path = os.path.relpath(os.path.join(root, file), '.')
            # Skip files that match any exclude pattern
            if any(re.search(p, full_path) for p in exclude_patterns):
                continue
            zipf.write(full_path)
"

echo "Built: ../${OUTPUT}"