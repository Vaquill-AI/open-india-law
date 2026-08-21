#!/usr/bin/env python3
"""
AWS High Court Judgments Parquet Reader

This script reads parquet files from the AWS Open Data Indian High Court Judgments dataset
and outputs structured JSON for processing.

Usage:
    # First install dependencies:
    pip3 install pandas pyarrow

    # Read a single parquet file:
    python3 aws-hc-parquet-reader.py ~/aws-hc-judgments/metadata/parquet/year=2023/court=10_8/bench=Justice/metadata.parquet

    # Read all parquet files and output stats:
    python3 aws-hc-parquet-reader.py --scan ~/aws-hc-judgments/metadata/parquet/

    # Export to JSON for TypeScript processing:
    python3 aws-hc-parquet-reader.py --export ~/aws-hc-judgments/metadata/parquet/year=2023/court=10_8/
"""

import argparse
import json
import os
import sys
from pathlib import Path
from datetime import datetime

try:
    import pandas as pd
    import pyarrow.parquet as pq
except ImportError:
    print("ERROR: Required packages not installed.")
    print("Run: pip3 install pandas pyarrow")
    sys.exit(1)


# Court code mapping (from AWS dataset documentation)
COURT_CODES = {
    "1_1": "Allahabad High Court",
    "1_3": "Lucknow Bench",
    "2_2": "Andhra Pradesh High Court",
    "3_3": "Bombay High Court",
    "3_4": "Aurangabad Bench",
    "3_5": "Nagpur Bench",
    "3_6": "Goa Bench",
    "4_7": "Calcutta High Court",
    "4_8": "Circuit Bench at Port Blair",
    "5_9": "Chhattisgarh High Court",
    "6_10": "Delhi High Court",
    "7_11": "Gujarat High Court",
    "8_12": "Gauhati High Court",
    "8_13": "Kohima Bench",
    "8_14": "Aizawl Bench",
    "8_15": "Itanagar Bench",
    "9_16": "Himachal Pradesh High Court",
    "10_8": "Patna High Court",
    "11_17": "Jammu and Kashmir High Court",
    "11_18": "Srinagar Wing",
    "12_19": "Jharkhand High Court",
    "13_20": "Karnataka High Court",
    "13_21": "Dharwad Bench",
    "13_22": "Kalaburagi Bench",
    "14_23": "Kerala High Court",
    "15_24": "Madhya Pradesh High Court",
    "15_25": "Indore Bench",
    "15_26": "Gwalior Bench",
    "16_27": "Madras High Court",
    "16_28": "Madurai Bench",
    "17_29": "Manipur High Court",
    "18_30": "Meghalaya High Court",
    "19_31": "Orissa High Court",
    "20_32": "Punjab and Haryana High Court",
    "21_33": "Rajasthan High Court",
    "21_34": "Jaipur Bench",
    "22_35": "Sikkim High Court",
    "23_36": "Telangana High Court",
    "24_37": "Tripura High Court",
    "25_38": "Uttarakhand High Court",
}


def read_parquet(file_path: str) -> pd.DataFrame:
    """Read a parquet file and return as DataFrame."""
    return pd.read_parquet(file_path)


def get_parquet_schema(file_path: str) -> dict:
    """Get schema information from a parquet file."""
    parquet_file = pq.ParquetFile(file_path)
    schema = parquet_file.schema_arrow
    return {
        "num_rows": parquet_file.metadata.num_rows,
        "num_columns": len(schema),
        "columns": [
            {
                "name": field.name,
                "type": str(field.type),
            }
            for field in schema
        ],
    }


def scan_directory(base_path: str) -> dict:
    """Scan a directory for all parquet files and return stats."""
    base = Path(base_path)
    stats = {
        "total_files": 0,
        "total_records": 0,
        "by_year": {},
        "by_court": {},
        "files": [],
    }

    for parquet_file in base.rglob("*.parquet"):
        try:
            pf = pq.ParquetFile(parquet_file)
            num_rows = pf.metadata.num_rows
            stats["total_files"] += 1
            stats["total_records"] += num_rows

            # Extract year and court from path
            parts = str(parquet_file.relative_to(base)).split("/")
            year = None
            court = None
            for part in parts:
                if part.startswith("year="):
                    year = part.replace("year=", "")
                elif part.startswith("court="):
                    court = part.replace("court=", "")

            if year:
                stats["by_year"][year] = stats["by_year"].get(year, 0) + num_rows
            if court:
                court_name = COURT_CODES.get(court, court)
                stats["by_court"][court_name] = (
                    stats["by_court"].get(court_name, 0) + num_rows
                )

            stats["files"].append(
                {
                    "path": str(parquet_file),
                    "records": num_rows,
                    "year": year,
                    "court": court,
                }
            )
        except Exception as e:
            print(f"Error reading {parquet_file}: {e}", file=sys.stderr)

    return stats


def export_to_json(parquet_path: str, output_dir: str = None) -> str:
    """Export parquet data to JSON format suitable for our schema."""
    df = read_parquet(parquet_path)

    # Transform to our schema format
    records = []
    for _, row in df.iterrows():
        # Parse court code
        court_code = row.get("court_code", "")
        court_name = COURT_CODES.get(court_code, row.get("court", "Unknown"))

        # Parse decision date
        decision_date = None
        if pd.notna(row.get("decision_date")):
            try:
                if isinstance(row["decision_date"], (pd.Timestamp, datetime)):
                    decision_date = row["decision_date"].strftime("%Y-%m-%d")
                else:
                    decision_date = str(row["decision_date"])[:10]
            except Exception:
                pass

        # Extract year from decision date
        decision_year = None
        if decision_date:
            try:
                decision_year = int(decision_date[:4])
            except Exception:
                pass

        record = {
            # Core identifiers
            "cnr": row.get("cnr", ""),  # Unique case number
            "title": row.get("title", ""),
            "court_name": court_name,
            "court_code": court_code,
            # Dates
            "decision_date": decision_date,
            "decision_year": decision_year,
            "date_of_registration": str(row.get("date_of_registration", ""))[:10]
            if pd.notna(row.get("date_of_registration"))
            else None,
            # Case details
            "judge": row.get("judge", ""),
            "disposal_nature": row.get("disposal_nature", ""),
            "description": row.get("description", ""),
            # Source data
            "pdf_link": row.get("pdf_link", ""),
            "pdf_exists": bool(row.get("pdf_exists", False)),
            "raw_html": row.get("raw_html", "")[:1000]
            if pd.notna(row.get("raw_html"))
            else None,  # Truncate HTML
            # Metadata
            "source": "aws-open-data",
            "processed_at": datetime.utcnow().isoformat(),
        }
        records.append(record)

    # Output
    if output_dir:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        # Create filename from parquet path
        parquet_name = Path(parquet_path).stem
        output_file = output_path / f"{parquet_name}.json"

        with open(output_file, "w") as f:
            json.dump(records, f, indent=2, default=str)

        return str(output_file)
    else:
        return json.dumps(records, indent=2, default=str)


def main():
    parser = argparse.ArgumentParser(
        description="AWS High Court Judgments Parquet Reader"
    )
    parser.add_argument("path", help="Path to parquet file or directory")
    parser.add_argument("--scan", action="store_true", help="Scan directory for stats")
    parser.add_argument(
        "--export", action="store_true", help="Export to JSON for processing"
    )
    parser.add_argument("--output", "-o", help="Output directory for JSON export")
    parser.add_argument(
        "--schema", action="store_true", help="Show schema of parquet file"
    )
    parser.add_argument(
        "--sample", type=int, default=5, help="Number of sample records to show"
    )

    args = parser.parse_args()
    path = Path(args.path)

    if not path.exists():
        print(f"ERROR: Path does not exist: {path}", file=sys.stderr)
        sys.exit(1)

    if args.scan:
        print(f"Scanning {path}...")
        stats = scan_directory(str(path))
        print(f"\n=== SCAN RESULTS ===")
        print(f"Total parquet files: {stats['total_files']}")
        print(f"Total records: {stats['total_records']:,}")
        print(f"\nBy Year:")
        for year in sorted(stats["by_year"].keys()):
            print(f"  {year}: {stats['by_year'][year]:,}")
        print(f"\nBy Court:")
        for court in sorted(stats["by_court"].keys()):
            print(f"  {court}: {stats['by_court'][court]:,}")
        return

    if args.export:
        if path.is_dir():
            for parquet_file in path.rglob("*.parquet"):
                output_file = export_to_json(str(parquet_file), args.output or ".")
                print(f"Exported: {output_file}")
        else:
            output = export_to_json(str(path), args.output)
            if args.output:
                print(f"Exported to: {output}")
            else:
                print(output)
        return

    # Default: show info about the parquet file
    if path.is_file() and path.suffix == ".parquet":
        if args.schema:
            schema = get_parquet_schema(str(path))
            print(f"=== SCHEMA ===")
            print(f"Rows: {schema['num_rows']:,}")
            print(f"Columns: {schema['num_columns']}")
            print(f"\nColumns:")
            for col in schema["columns"]:
                print(f"  {col['name']}: {col['type']}")
        else:
            df = read_parquet(str(path))
            print(f"=== FILE INFO ===")
            print(f"Records: {len(df):,}")
            print(f"Columns: {list(df.columns)}")
            print(f"\n=== SAMPLE RECORDS ===")
            for i, row in df.head(args.sample).iterrows():
                print(f"\n--- Record {i + 1} ---")
                print(f"CNR: {row.get('cnr', 'N/A')}")
                print(f"Title: {row.get('title', 'N/A')[:100]}...")
                print(f"Court: {row.get('court', 'N/A')}")
                print(f"Judge: {row.get('judge', 'N/A')}")
                print(f"Decision Date: {row.get('decision_date', 'N/A')}")
                print(f"Disposal: {row.get('disposal_nature', 'N/A')}")
    else:
        print(f"ERROR: {path} is not a parquet file", file=sys.stderr)
        print("Use --scan to scan a directory", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
