# Restoring the Qdrant vector snapshots

This corpus ships the embeddings as **per-shard Qdrant snapshots** rather than one file per collection.
Each shard restores independently, and Qdrant verifies its integrity server-side against the published SHA256 before accepting it.

Snapshots were taken from Qdrant **1.16.3**.
Restore into 1.16.x or later.

## What is published

| Collection | Points | Shards | Content |
| --- | --- | --- | --- |
| `legal_corpus_v1` | 19,595,718 | 4 | High Court judgment chunks. Older ingest, no citation field |
| `legal_corpus_v2` | 11,823,753 | 4 | Supreme Court and High Court judgment chunks. Newer ingest, carries citations |
| `acts_india` | 1,098,577 | 2 | Legislation and regulatory instrument provisions |

> **Restore both judgment collections.**
> They are not two versions of the same data, and neither one contains the other.
> Each court's bulk sits in exactly one of them, and the Supreme Court is only in `legal_corpus_v2`.
> Restoring `legal_corpus_v1` on its own gives you no Supreme Court judgments at all, and almost nothing from
> Kerala, Karnataka, Rajasthan, Punjab and Haryana, Jharkhand, Madhya Pradesh, Orissa, Jammu and Kashmir, Manipur or Meghalaya.
> We query both together. See [which courts are in which collection](#which-courts-are-in-which-collection).

Tribunal and regulator matters are in the case index only.
None of them are embedded in these collections.

Layout in the mirror:

```
https://oss-data-in.vaquill.ai/qdrant/{collection}/shard-{n}/
    {collection}-shard-{n}-{timestamp}.snapshot
    {collection}-shard-{n}-{timestamp}.snapshot.checksum
```

Every vector is from the Voyage AI **voyage-4 series**, 1024 dimensions, cosine distance.
Embed your queries with the same series or similarity scores will not be meaningful.
Each collection also carries a named **sparse** vector used for BM25 hybrid search.

## Which courts are in which collection

`legal_corpus_v1` and `legal_corpus_v2` are complementary, not successive versions.
Eleven courts have their entire bulk in `v2` and are effectively absent from `v1`, the Supreme Court among them.
Four are the other way round.
The rest appear in both, with a small overlap that is deduplicated by `case_id` at query time.

| Court | `legal_corpus_v1` | `legal_corpus_v2` | Restore which |
| --- | ---: | ---: | --- |
| **Supreme Court of India** | 0 | 371,159 | v2 only |
| Kerala | 17 | 3,125,018 | v2 only |
| Bombay | 2,820,634 | 138,168 | both |
| State of Telangana | 2,727,633 | 115,721 | both |
| Madras | 2,609,137 | 137,382 | both |
| Patna | 2,563,058 | 119,686 | both |
| Allahabad | 1,926,088 | 3,471 | v1 only |
| Chhattisgarh | 1,743,240 | 66,363 | both |
| Karnataka | 3 | 1,552,336 | v2 only |
| Gujarat | 1,415,395 | 65,468 | both |
| Rajasthan | 3 | 1,357,928 | v2 only |
| Punjab and Haryana | 9 | 1,265,180 | v2 only |
| Jharkhand | 0 | 1,234,672 | v2 only |
| Delhi | 1,047,481 | 45,981 | both |
| Andhra Pradesh | 956,506 | 75,764 | both |
| Madhya Pradesh | 2 | 766,920 | v2 only |
| Himachal Pradesh | 273,169 | 479,389 | both |
| Gauhati | 662,440 | 28,951 | both |
| Orissa | 0 | 501,386 | v2 only |
| Calcutta | 322,583 | 1,023 | v1 only |
| Uttarakhand | 261,025 | 1,023 | v1 only |
| Jammu and Kashmir | 0 | 240,967 | v2 only |
| Tripura | 138,530 | 5 | v1 only |
| Manipur | 0 | 31,643 | v2 only |
| Meghalaya | 0 | 22,209 | v2 only |
| Sikkim | 2,554 | 124 | both |

Counts are chunks, not judgments, and court labels are normalised here (for example `High Court of Chandigarh` is folded into Punjab and Haryana).
A court showing a handful of points on the side it is not stored on is label noise, not coverage.

## Step 1: create the collection

The shard snapshots restore into an existing collection, so create it first with a matching configuration.
`shard_number` must match exactly, otherwise the hash ring differs and queries will miss points.

```bash
curl -X PUT http://localhost:6333/collections/legal_corpus_v1 \
  -H 'Content-Type: application/json' -d '{
    "shard_number": 4,
    "vectors": {
      "dense": {
        "size": 1024,
        "distance": "Cosine",
        "on_disk": true,
        "quantization_config": {"scalar": {"type": "int8", "quantile": 0.99, "always_ram": false}}
      }
    },
    "sparse_vectors": {"sparse": {}}
  }'
```

Use the same body for `legal_corpus_v2`.
For `acts_india`, set `"shard_number": 2`.

## Step 2: recover each shard

Qdrant pulls the snapshot directly from the mirror.
Nothing needs to be downloaded first.

```bash
COLLECTION=legal_corpus_v1
BASE=https://oss-data-in.vaquill.ai/qdrant/$COLLECTION

for N in 0 1 2 3; do
  SNAP=$(curl -s "$BASE/shard-$N/index.json" | jq -r .snapshot)
  SUM=$(curl -s "$BASE/shard-$N/$SNAP.checksum")
  curl -X PUT "http://localhost:6333/collections/$COLLECTION/shards/$N/snapshots/recover" \
    -H 'Content-Type: application/json' \
    -d "{\"location\": \"$BASE/shard-$N/$SNAP\", \"checksum\": \"$SUM\", \"priority\": \"snapshot\"}"
done
```

`priority: snapshot` tells Qdrant to prefer the snapshot over whatever is currently in the shard, which is what you want for a fresh restore.
If the checksum does not match, the recovery is rejected rather than silently importing corrupt data.

Alternatively, upload a file you have already downloaded:

```bash
curl -X POST "http://localhost:6333/collections/$COLLECTION/shards/0/snapshots/upload?priority=snapshot" \
  -F snapshot=@legal_corpus_v1-shard-0-2026-08-22-12-00-11.snapshot
```

## Step 3: verify

```bash
curl -s http://localhost:6333/collections/legal_corpus_v1 | jq '.result.points_count'
```

The total across all four shards should equal the point count in the table above.
A short count means a shard failed to recover, not that the snapshot is incomplete.
Re-run the recovery for that shard.

A correct point count does not prove you have the whole corpus, only that the collection you restored is intact.
Check court coverage as well:

```bash
for C in legal_corpus_v1 legal_corpus_v2; do
  echo "== $C"
  curl -s -X POST "http://localhost:6333/collections/$C/facet" \
    -H 'Content-Type: application/json' \
    -d '{"key": "court_type", "limit": 10, "exact": true}' | jq -c '.result.hits[]'
done
```

`legal_corpus_v1` returns `high_court` only, which is correct and expected.
`legal_corpus_v2` must return **both** `high_court` and `supreme_court` (371,159 points).
If `supreme_court` is missing, you have not restored `legal_corpus_v2` and the Supreme Court is absent from your index.

## Disk requirements

The three collections total roughly **434 GB** on disk once restored.
Restore only the collections you need.

| Collection | Restored size |
| --- | --- |
| `legal_corpus_v1` | 255 GB |
| `legal_corpus_v2` | 168 GB |
| `acts_india` | 11 GB |

## Why per-shard and not per-collection

A whole-collection snapshot has to be written to disk in one piece alongside the live data.
These collections were snapshotted from a running instance that did not have room for a 255 GB file, so each shard was taken, uploaded and released in turn.

The restore path is fully supported either way.
The only practical difference is that you create the collection yourself in step 1 rather than having a single snapshot recreate it.
