#!/usr/bin/env python3
"""
Lok Sabha Debates Downloader
Downloads text files from Internet Archive and uploads to R2

Data Range: 1952-2021 (1st to 17th Lok Sabha)
Total Items: ~5,632 documents

Usage:
    python scripts/download-lok-sabha-debates.py [--dry-run] [--limit N] [--upload-r2]
"""

import os
import sys
import json
import argparse
import subprocess
from pathlib import Path
from datetime import datetime
# Sequential download for reliability
from tqdm import tqdm

try:
    import internetarchive as ia
except ImportError:
    print("Installing internetarchive...")
    subprocess.run([sys.executable, "-m", "pip", "install", "internetarchive"], check=True)
    import internetarchive as ia


# Configuration
OUTPUT_DIR = Path("data/parliament-debates/text")
PROGRESS_FILE = Path("data/parliament-debates/download-progress.json")
LOG_FILE = Path("data/parliament-debates/download.log")
MAX_WORKERS = 5  # Concurrent downloads


def log(message: str):
    """Log message to file and stdout"""
    timestamp = datetime.now().isoformat()
    log_line = f"[{timestamp}] {message}"
    print(log_line)
    with open(LOG_FILE, "a") as f:
        f.write(log_line + "\n")


def load_progress() -> dict:
    """Load download progress from file"""
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"downloaded": [], "failed": [], "last_updated": None}


def save_progress(progress: dict):
    """Save download progress to file"""
    progress["last_updated"] = datetime.now().isoformat()
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


def search_lok_sabha_items() -> list:
    """Search Internet Archive for all Lok Sabha debate items"""
    log("Searching Internet Archive for Lok Sabha debates...")

    # Single focused search query
    query = 'title:(lok sabha debates)'
    all_identifiers = []

    try:
        results = ia.search_items(query)
        for item in results:
            all_identifiers.append(item['identifier'])
            # Progress indicator every 500 items
            if len(all_identifiers) % 500 == 0:
                log(f"  Found {len(all_identifiers)} items so far...")
    except Exception as e:
        log(f"Search error: {e}")

    log(f"Found {len(all_identifiers)} total items")
    return all_identifiers


def download_text_file(identifier: str, output_dir: Path) -> dict:
    """Download _djvu.txt file for a single item"""
    result = {
        "identifier": identifier,
        "success": False,
        "files_downloaded": [],
        "error": None
    }

    try:
        item = ia.get_item(identifier)

        # Find text files
        text_files = [f for f in item.files if f['name'].endswith('_djvu.txt')]

        if not text_files:
            result["error"] = "No _djvu.txt file found"
            return result

        # Download each text file
        for file_info in text_files:
            filename = file_info['name']
            output_path = output_dir / filename

            if output_path.exists():
                result["files_downloaded"].append(str(output_path))
                continue

            # Download file
            item.download(
                files=[filename],
                destdir=str(output_dir),
                no_directory=True,
                retries=3
            )

            if output_path.exists():
                result["files_downloaded"].append(str(output_path))

        result["success"] = len(result["files_downloaded"]) > 0

    except Exception as e:
        result["error"] = str(e)

    return result


def upload_to_r2(local_dir: Path, r2_path: str):
    """Upload downloaded files to R2 using rclone"""
    rclone_path = os.path.expanduser("~/bin/rclone")

    if not os.path.exists(rclone_path):
        log("rclone not found at ~/bin/rclone, skipping R2 upload")
        return False

    log(f"Uploading to R2: {r2_path}")

    try:
        result = subprocess.run(
            [rclone_path, "copy", str(local_dir), r2_path, "-P", "--transfers", "8"],
            capture_output=True,
            text=True
        )

        if result.returncode == 0:
            log("R2 upload completed successfully")
            return True
        else:
            log(f"R2 upload failed: {result.stderr}")
            return False

    except Exception as e:
        log(f"R2 upload error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Download Lok Sabha debates from Internet Archive")
    parser.add_argument("--dry-run", action="store_true", help="List items without downloading")
    parser.add_argument("--limit", type=int, help="Limit number of items to download")
    parser.add_argument("--upload-r2", type=str, help="R2 path to upload (e.g., r2:bucket/path)")
    parser.add_argument("--resume", action="store_true", help="Resume from last progress")
    args = parser.parse_args()

    # Setup directories
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    log("=" * 60)
    log("Lok Sabha Debates Downloader")
    log("=" * 60)

    # Search for items
    identifiers = search_lok_sabha_items()

    if args.dry_run:
        log(f"\n[DRY RUN] Would download {len(identifiers)} items")
        for i, identifier in enumerate(identifiers[:20]):
            print(f"  {i+1}. {identifier}")
        if len(identifiers) > 20:
            print(f"  ... and {len(identifiers) - 20} more")
        return

    # Load progress
    progress = load_progress()

    if args.resume:
        identifiers = [i for i in identifiers if i not in progress["downloaded"]]
        log(f"Resuming: {len(identifiers)} remaining (already downloaded: {len(progress['downloaded'])})")

    if args.limit:
        identifiers = identifiers[:args.limit]
        log(f"Limited to {args.limit} items")

    # Download sequentially with progress bar
    log(f"\nDownloading {len(identifiers)} items...")

    successful = 0
    failed = 0

    for i, identifier in enumerate(tqdm(identifiers, desc="Downloading")):
        try:
            result = download_text_file(identifier, OUTPUT_DIR)

            if result["success"]:
                successful += 1
                progress["downloaded"].append(identifier)
            else:
                failed += 1
                progress["failed"].append({
                    "identifier": identifier,
                    "error": result.get("error", "Unknown error")
                })

        except Exception as e:
            failed += 1
            progress["failed"].append({
                "identifier": identifier,
                "error": str(e)
            })

        # Save progress periodically
        if (i + 1) % 50 == 0:
            save_progress(progress)
            log(f"Progress: {successful} downloaded, {failed} failed")

    # Final progress save
    save_progress(progress)

    log(f"\n{'=' * 60}")
    log(f"Download Complete!")
    log(f"  Successful: {successful}")
    log(f"  Failed: {failed}")
    log(f"  Total downloaded: {len(progress['downloaded'])}")
    log(f"{'=' * 60}")

    # Upload to R2 if requested
    if args.upload_r2:
        upload_to_r2(OUTPUT_DIR, args.upload_r2)

    # Print summary of files
    txt_files = list(OUTPUT_DIR.glob("*.txt"))
    total_size = sum(f.stat().st_size for f in txt_files)
    log(f"\nLocal storage: {len(txt_files)} files, {total_size / (1024*1024):.1f} MB")


if __name__ == "__main__":
    main()
