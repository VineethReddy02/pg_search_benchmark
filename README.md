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
