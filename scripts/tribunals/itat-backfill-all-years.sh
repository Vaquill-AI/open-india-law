#!/bin/bash
# ITAT Backfill: 2022 → 2000 (sequential, unattended)
# 2024 and 2023 already done.
# Progress is resumable per-year — safe to kill and restart.
# On failure: waits 60s then retries up to 3 times per year.

export CAPTCHA_API_KEY="${CAPTCHA_API_KEY}"
# No proxy — direct connection works and is faster
export WORKERS=3

LOG_DIR="/tmp"
cd .

for YEAR in $(seq 2022 -1 2000); do
  echo ""
  echo "============================================"
  echo "  Starting ITAT backfill for $YEAR"
  echo "  $(date)"
  echo "============================================"
  echo ""

  LOG_FILE="$LOG_DIR/itat-backfill-${YEAR}.log"

  for ATTEMPT in 1 2 3; do
    echo "[$(date)] Year $YEAR — attempt $ATTEMPT/3" | tee -a "$LOG_FILE"

    START_DATE="01/01/${YEAR}" \
    END_DATE="31/12/${YEAR}" \
    npx tsx scripts/itat-scraper.ts --metadata-only 2>&1 | tee -a "$LOG_FILE"

    EXIT_CODE=${PIPESTATUS[0]}

    # Check if any searches for this year were actually completed
    YEAR_SEARCHES=$(python3 -c "
import json
with open('data/tribunals/itat/scrape-progress.json') as f:
    d = json.load(f)
print(sum(1 for s in d.get('completed_searches',[]) if '/$YEAR' in s))
" 2>/dev/null)

    if [ "$YEAR_SEARCHES" -gt 1000 ] 2>/dev/null; then
      echo "[$(date)] Year $YEAR done — $YEAR_SEARCHES searches completed." | tee -a "$LOG_FILE"
      break
    fi

    if [ $ATTEMPT -lt 3 ]; then
      echo "[$(date)] Year $YEAR attempt $ATTEMPT had $YEAR_SEARCHES searches. Cooling down 60s..." | tee -a "$LOG_FILE"
      sleep 60
    else
      echo "[$(date)] Year $YEAR failed after 3 attempts ($YEAR_SEARCHES searches). Moving on." | tee -a "$LOG_FILE"
    fi
  done
done

echo ""
echo "============================================"
echo "  ALL YEARS COMPLETE (2022-2000)"
echo "  $(date)"
echo "============================================"
