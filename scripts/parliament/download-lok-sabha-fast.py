#!/usr/bin/env python3
"""
Fast Lok Sabha Debates Downloader
Uses direct HTTP requests for faster, more reliable downloads

Data Range: 1952-2021 (1st to 17th Lok Sabha)
Total Items: ~5,632 documents

Usage:
    python scripts/download-lok-sabha-fast.py [--resume] [--limit N]
"""

import os
import sys
import json
import argparse
import requests
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm

try:
    import internetarchive as ia
except ImportError:
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "internetarchive"], check=True)
    import internetarchive as ia

# Configuration
OUTPUT_DIR = Path("data/parliament-debates/text")
PROGRESS_FILE = Path("data/parliament-debates/download-progress.json")
LOG_FILE = Path("data/parliament-debates/download-fast.log")
MAX_WORKERS = 3  # Reduced to avoid rate limiting
TIMEOUT = 120  # Increased timeout
DELAY_BETWEEN_REQUESTS = 1.0  # seconds delay to avoid 429


def log(message: str):
    timestamp = datetime.now().isoformat()
    log_line = f"[{timestamp}] {message}"
    print(log_line)
    with open(LOG_FILE, "a") as f:
        f.write(log_line + "\n")


def load_progress() -> dict:
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"downloaded": [], "failed": [], "last_updated": None}


def save_progress(progress: dict):
    progress["last_updated"] = datetime.now().isoformat()
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


def get_identifiers_cached() -> list:
    """Get identifiers, caching to file for speed"""
    cache_file = Path("data/parliament-debates/identifiers-cache.json")

    if cache_file.exists():
        with open(cache_file) as f:
            data = json.load(f)
            log(f"Loaded {len(data)} identifiers from cache")
            return data

    log("Searching Internet Archive (first time, will cache)...")
    identifiers = []
    results = ia.search_items('title:(lok sabha debates)')
    for item in results:
        identifiers.append(item['identifier'])
        if len(identifiers) % 1000 == 0:
            log(f"  Found {len(identifiers)}...")

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_file, "w") as f:
        json.dump(identifiers, f)

    log(f"Found and cached {len(identifiers)} identifiers")
    return identifiers


def download_single(identifier: str, retries: int = 3) -> dict:
    """Download text file using direct HTTP request with retry logic"""
    import time
    result = {"identifier": identifier, "success": False, "error": None}

    for attempt in range(retries):
        try:
            # Add delay to avoid rate limiting
            time.sleep(DELAY_BETWEEN_REQUESTS)

            # Construct direct URL to _djvu.txt file
            base_url = f"https://archive.org/download/{identifier}"

            # First, get the file list to find the correct filename
            files_url = f"https://archive.org/metadata/{identifier}/files"

            resp = requests.get(files_url, timeout=60)

            # Handle rate limiting
            if resp.status_code == 429:
                wait_time = 30 * (attempt + 1)  # Exponential backoff
                time.sleep(wait_time)
                continue

            if resp.status_code != 200:
                result["error"] = f"Metadata fetch failed: {resp.status_code}"
                if attempt < retries - 1:
                    time.sleep(5)
                    continue
                return result

            files = resp.json().get("result", [])
            txt_files = [f["name"] for f in files if f["name"].endswith("_djvu.txt")]

            if not txt_files:
                result["error"] = "No _djvu.txt file found"
                return result  # No retry needed for this

            # Download each text file
            for filename in txt_files:
                output_path = OUTPUT_DIR / filename

                if output_path.exists() and output_path.stat().st_size > 0:
                    result["success"] = True
                    continue

                file_url = f"{base_url}/{filename}"

                resp = requests.get(file_url, timeout=TIMEOUT, stream=True)

                if resp.status_code == 429:
                    wait_time = 30 * (attempt + 1)
                    time.sleep(wait_time)
                    continue

                if resp.status_code == 200:
                    output_path.parent.mkdir(parents=True, exist_ok=True)
                    with open(output_path, "wb") as f:
                        for chunk in resp.iter_content(chunk_size=8192):
                            f.write(chunk)
                    result["success"] = True
                else:
                    result["error"] = f"Download failed: {resp.status_code}"

            if result["success"]:
                return result

        except requests.Timeout:
            result["error"] = "Timeout"
            if attempt < retries - 1:
                time.sleep(10 * (attempt + 1))
                continue
        except Exception as e:
            result["error"] = str(e)
            if attempt < retries - 1:
                time.sleep(5)
                continue

    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    log("=" * 60)
    log("Fast Lok Sabha Debates Downloader")
    log("=" * 60)

    # Get identifiers (cached)
    identifiers = get_identifiers_cached()

    # Load progress
    progress = load_progress()

    if args.resume:
        already_done = set(progress["downloaded"])
        identifiers = [i for i in identifiers if i not in already_done]
        log(f"Resuming: {len(identifiers)} remaining ({len(already_done)} done)")

    if args.limit:
        identifiers = identifiers[:args.limit]
        log(f"Limited to {args.limit} items")

    log(f"\nDownloading {len(identifiers)} items with {MAX_WORKERS} workers...")

    successful = 0
    failed = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(download_single, id): id for id in identifiers}

        with tqdm(total=len(identifiers), desc="Downloading") as pbar:
            for future in as_completed(futures):
                identifier = futures[future]

                try:
                    result = future.result()
                    if result["success"]:
                        successful += 1
                        progress["downloaded"].append(identifier)
                    else:
                        failed += 1
                        progress["failed"].append({
                            "identifier": identifier,
                            "error": result.get("error")
                        })
                except Exception as e:
                    failed += 1
                    progress["failed"].append({"identifier": identifier, "error": str(e)})

                pbar.update(1)
                pbar.set_postfix({"ok": successful, "fail": failed})

                # Save progress every 100 items
                if (successful + failed) % 100 == 0:
                    save_progress(progress)

    save_progress(progress)

    log(f"\n{'=' * 60}")
    log(f"Complete! Success: {successful}, Failed: {failed}")
    log(f"Total downloaded: {len(progress['downloaded'])}")

    # Summary
    txt_files = list(OUTPUT_DIR.glob("*.txt"))
    total_size = sum(f.stat().st_size for f in txt_files)
    log(f"Storage: {len(txt_files)} files, {total_size / (1024*1024*1024):.2f} GB")


if __name__ == "__main__":
    main()
