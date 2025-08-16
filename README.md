# PostgreSQL vs ParadeDB Search Benchmark

Real-world performance comparison between vanilla PostgreSQL and ParadeDB using 1.6M Amazon products. Tests search speed, relevance, and write performance across different query types.

## Quick Start

### 1. Start Databases
```bash
docker-compose up -d
```

### 2. Load Data
```bash
# Downloads Amazon dataset and sets up both databases with indexes
go run ingest-amazon-data.go
```

### 3. Run UI
```bash
npm install
node server.js
# Open http://localhost:3000
```

### 4. Run Benchmark
```bash
node benchmark.js
```

## Dataset & Configuration

### Data Source
- **Stanford SNAP Amazon Dataset**: 1,586,094 real product records
- **Fields**: title, description, brand, price, categories, ASIN
- **Size**: ~3.1GB compressed

### PostgreSQL Setup (Port 5432)
- **Version**: PostgreSQL 17
- **11 Indexes**: GIN (full-text), pg_trgm (fuzzy), B-tree (lookups)
- **Extensions**: pg_trgm
- **Key Index**: `idx_combined_fulltext`

### ParadeDB Setup (Port 5433) 
- **Version**: ParadeDB 0.17.2 (PostgreSQL 17 base)
- **1 Index**: BM25 with field-specific tokenizers
- **Extensions**: pg_search
- **Features**: Built-in scoring, fuzzy search, field boosting

### Benchamrk Results

```
========== VERIFYING SETUP ==========

Note: Results show Time(Relevance) where relevance scores indicate search result quality

Vanilla PostgreSQL: 11 indexes, 16,15,844 products
ParadeDB: 2 indexes, 16,15,844 products

========== READ PERFORMANCE BENCHMARK ==========

--- FULLTEXT SEARCH ---
"wireless headphones": Vanilla 202ms (22) | ParadeDB 144ms (24)
"apple iphone": Vanilla 415ms (23) | ParadeDB 80ms (29)
"samsung galaxy": Vanilla 453ms (18) | ParadeDB 78ms (29)
"laptop computer": Vanilla 284ms (24) | ParadeDB 79ms (29)
"digital camera": Vanilla 650ms (22) | ParadeDB 77ms (29)

--- BOOLEAN SEARCH ---
"laptop AND gaming": Vanilla 3ms (29) | ParadeDB 4ms (24)
"phone OR tablet": Vanilla 18ms (11) | ParadeDB 2ms (10)
"camera NOT digital": Vanilla 4ms (9) | ParadeDB 2ms (8)
"wireless AND (headphones OR earbuds)": Vanilla 2ms (29) | ParadeDB 1ms (18)
"apple OR microsoft OR google": Vanilla 6ms (8) | ParadeDB 1ms (18)

--- FIELD SEARCH ---
"title:iphone": Vanilla 905ms (14) | ParadeDB 73ms (15)
"brand:samsung": Vanilla 13ms (15) | ParadeDB 68ms (15)
"title:laptop": Vanilla 329ms (15) | ParadeDB 72ms (15)
"brand:apple": Vanilla 9ms (15) | ParadeDB 68ms (15)
"description:wireless": Vanilla 20737ms (12) | ParadeDB 171ms (10)

--- FUZZY SEARCH ---
"samsu": Vanilla 20123ms (6) | ParadeDB 129ms (1)
"iphon": Vanilla 29490ms (6) | ParadeDB 147ms (4)
"wireles heaphones": Vanilla 26497ms (6) | ParadeDB 163ms (0)
"blutooth speker": Vanilla 28644ms (0) | ParadeDB 209ms (0)
"mechenical keybord": Vanilla 9438ms (0) | ParadeDB 45ms (0)

--- EXACT SEARCH ---
"wireless headphones": Vanilla 10ms (15) | ParadeDB 112ms (24)
"apple iphone": Vanilla 5ms (22) | ParadeDB 88ms (29)
"samsung galaxy": Vanilla 4ms (29) | ParadeDB 83ms (29)
"digital camera": Vanilla 7ms (18) | ParadeDB 83ms (29)
"bluetooth speaker": Vanilla 4ms (29) | ParadeDB 80ms (29)


========== WRITE PERFORMANCE BENCHMARK ==========

--- SMALL BATCH INSERTS (100 rows, batch size 10) ---
Vanilla: Testing 100 inserts (batch size: 10)
  54ms (1,846 rows/sec)
ParadeDB: Testing 100 inserts (batch size: 10)
  119ms (839 rows/sec)

--- MEDIUM BATCH INSERTS (1000 rows, batch size 100) ---
Vanilla: Testing 1000 inserts (batch size: 100)
  486ms (2,056 rows/sec)
ParadeDB: Testing 1000 inserts (batch size: 100)
  91ms (11,028 rows/sec)

--- LARGE BATCH INSERTS (5000 rows, batch size 500) ---
Vanilla: Testing 5000 inserts (batch size: 500)
  2315ms (2,160 rows/sec)
ParadeDB: Testing 5000 inserts (batch size: 500)
  277ms (18,070 rows/sec)

--- SINGLE INSERTS (50 rows) ---
Vanilla: Testing 50 single inserts
  42ms (1,177 rows/sec)
ParadeDB: Testing 50 single inserts
  151ms (330 rows/sec)

--- UPDATES (100 rows) ---
Vanilla: Testing 100 updates
  117ms (854 rows/sec)
ParadeDB: Testing 100 updates
  364ms (275 rows/sec)

--- BULK UPDATES (1000 rows) ---
Vanilla: Testing 1000 updates
  1153ms (867 rows/sec)
ParadeDB: Testing 1000 updates
  3743ms (267 rows/sec)

--- INDEX REBUILD PERFORMANCE ---
Vanilla: Testing index rebuild performance
  Index rebuilt in 63950ms
ParadeDB: Testing index rebuild performance
  Index rebuilt in 7150ms

========== BENCHMARK SUMMARY ==========

READ PERFORMANCE:
┌─────────────┬──────────────────────┬──────────────────────┬─────────────────────┐
│ Query Type  │      Vanilla PG      │      ParadeDB       │       Delta         │
│             │   Time  │ Relevance  │   Time  │ Relevance │  Time   │ Relevance │
├─────────────┼─────────┼────────────┼─────────┼───────────┼─────────┼───────────┤
│ fulltext    │   401ms │       22   │    92ms │      28   │   -309ms │      +6   │
│ boolean     │     7ms │       17   │     2ms │      16   │     -5ms │      -1   │
│ field       │  4399ms │       14   │    90ms │      14   │  -4309ms │       0   │
│ fuzzy       │ 22838ms │        4   │   139ms │       1   │ -22699ms │      -3   │
│ exact       │     6ms │       23   │    89ms │      28   │    +83ms │      +5   │
└─────────────┴─────────┴────────────┴─────────┴───────────┴─────────┴───────────┘
Time: negative = ParadeDB faster | Relevance: positive = ParadeDB better

WRITE PERFORMANCE:
┌──────────────────┬─────────────────┬─────────────────┬─────────────────┐
│ Operation        │   Vanilla PG    │    ParadeDB     │      Delta      │
├──────────────────┼─────────────────┼─────────────────┼─────────────────┤
│ smallBatch       │     1,846/sec   │       839/sec   │    -1,007/sec   │
│ mediumBatch      │     2,056/sec   │    11,028/sec   │    +8,972/sec   │
│ largeBatch       │     2,160/sec   │    18,070/sec   │   +15,910/sec   │
│ singleInsert     │     1,177/sec   │       330/sec   │      -847/sec   │
│ updates          │       854/sec   │       275/sec   │      -579/sec   │
│ bulkUpdates      │       867/sec   │       267/sec   │      -600/sec   │
│ indexRebuild     │       63950ms   │        7150ms   │      -56801ms   │
└──────────────────┴─────────────────┴─────────────────┴─────────────────┘
Rate: positive = ParadeDB higher throughput | Time: negative = ParadeDB faster
```