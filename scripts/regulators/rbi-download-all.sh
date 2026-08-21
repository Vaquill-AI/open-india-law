#!/bin/bash
# RBI PDF Download - All Sections (Sequential)
# Run in tmux/screen for unattended operation:
#   tmux new -s rbi-download
#   bash scripts/rbi-download-all.sh
#   Ctrl+B, D to detach

set -e
cd "$(dirname "$0")/.."

echo "=== RBI PDF Download - All Sections ==="
echo "Started: $(date)"
echo ""

# Small sections first, then large ones
SECTIONS=(
  "vision_docs"
  "fema"
  "speeches"
  "master_circulars"
  "annual_reports"
  "press_releases"
  "bulletin"
)

for section in "${SECTIONS[@]}"; do
  echo ""
  echo "=========================================="
  echo "  Downloading: $section"
  echo "  Time: $(date)"
  echo "=========================================="
  echo ""
  FAST=true TYPE="$section" RESUME=true npx tsx scripts/rbi-pdf-downloader.ts
  echo ""
  echo "[$section] DONE at $(date)"
  echo ""
  # Brief pause between sections
  sleep 10
done

echo ""
echo "=== All Downloads Complete ==="
echo "Finished: $(date)"

# Summary
echo ""
echo "=== PDF Count Summary ==="
for dir in data/legal-sources/rbi/pdfs/*/; do
  if [ -d "$dir" ]; then
    count=$(find "$dir" -type f | wc -l)
    size=$(du -sh "$dir" | cut -f1)
    echo "  $(basename "$dir"): $count files ($size)"
  fi
done
total=$(find data/legal-sources/rbi/pdfs/ -type f -not -name "*.json" | wc -l)
totalsize=$(du -sh data/legal-sources/rbi/pdfs/ | cut -f1)
echo "  TOTAL: $total files ($totalsize)"
