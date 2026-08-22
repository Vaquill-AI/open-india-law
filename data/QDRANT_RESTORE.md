# Restoring the Qdrant vector snapshots

This corpus ships the embeddings as **per-shard Qdrant snapshots** rather than one file per collection.
Each shard restores independently, and Qdrant verifies its integrity server-side against the published SHA256 before accepting it.

Snapshots were taken from Qdrant **1.16.3**.
Restore into 1.16.x or later.

## What is published

| Collection | Points | Shards | Content |
| --- | --- | --- | --- |
| `legal_corpus_v1` | 19,595,718 | 4 | High Court and Supreme Court judgment chunks |
| `legal_corpus_v2` | 11,823,753 | 4 | Tribunal and regulator decision chunks |
| `acts_india` | 1,098,577 | 2 | Legislation and regulatory instrument provisions |

Layout in the mirror:

```
https://oss-data-in.vaquill.ai/qdrant/{collection}/shard-{n}/
    {collection}-shard-{n}-{timestamp}.snapshot
    {collection}-shard-{n}-{timestamp}.snapshot.checksum
```

Every vector is from the Voyage AI **voyage-4 series**, 1024 dimensions, cosine distance.
Embed your queries with the same series or similarity scores will not be meaningful.
Each collection also carries a named **sparse** vector used for BM25 hybrid search.

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
