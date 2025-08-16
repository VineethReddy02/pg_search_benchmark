package main

import (
	"bufio"
	"compress/gzip"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/lib/pq"
)

const (
	MetadataURL = "https://snap.stanford.edu/data/amazon/productGraph/metadata.json.gz"
	SampleSize  = 0 // 0 means process all records
	BatchSize   = 5000  // Increased from 1000 for better throughput
	MaxWorkers  = 20    // Increased from 10 for more parallelism
)

type Product struct {
	ASIN        string                 `json:"asin"`
	Title       string                 `json:"title"`
	Description string                 `json:"description"`
	Price       string                 `json:"price"`
	Brand       string                 `json:"brand"`
	Categories  []interface{}          `json:"categories"`
	SalesRank   map[string]interface{} `json:"salesRank"`
	ImageURL    string                 `json:"imUrl"`
}

type DBConfig struct {
	Host     string
	Port     int
	Database string
	User     string
	Password string
}

var (
	vanillaConfig = DBConfig{
		Host:     "localhost",
		Port:     5432,
		Database: "benchmark_vanilla",
		User:     "benchmark",
		Password: "benchmark123",
	}

	paradeConfig = DBConfig{
		Host:     "localhost",
		Port:     5433,
		Database: "benchmark_parade",
		User:     "benchmark",
		Password: "benchmark123",
	}
)

func downloadFile(url, filename string) error {
	if _, err := os.Stat(filename); err == nil {
		fmt.Printf("File %s already exists, skipping download\n", filename)
		return nil
	}

	fmt.Printf("Downloading %s...\n", filename)
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	out, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		return err
	}

	fmt.Printf("✅ Downloaded %s\n", filename)
	return nil
}

func getDB(config DBConfig) (*sql.DB, error) {
	psqlInfo := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
		config.Host, config.Port, config.User, config.Password, config.Database)

	db, err := sql.Open("postgres", psqlInfo)
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(50)  // Increased for better parallelism
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.Ping(); err != nil {
		return nil, err
	}

	return db, nil
}

func setupTables(db *sql.DB, isParadeDB bool) error {
	dbType := "Vanilla PostgreSQL"
	if isParadeDB {
		dbType = "ParadeDB"
	}
	fmt.Printf("Setting up %s...\n", dbType)

	// Drop and create table
	_, err := db.Exec("DROP TABLE IF EXISTS products CASCADE")
	if err != nil {
		return err
	}

	// Create unlogged table for faster initial load (will be converted to logged after)
	_, err = db.Exec(`
		CREATE UNLOGGED TABLE products (
			id SERIAL PRIMARY KEY,
			asin VARCHAR(20),
			title TEXT,
			description TEXT,
			price VARCHAR(50),
			brand VARCHAR(200),
			categories TEXT[],
			sales_rank JSONB,
			image_url TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return err
	}

	if isParadeDB {
		_, err = db.Exec("CREATE EXTENSION IF NOT EXISTS pg_search")
		if err != nil {
			log.Printf("Warning: Could not create pg_search extension: %v", err)
		}
		// Note: BM25 index will be created AFTER data load for better performance
		log.Println("ParadeDB: Deferring BM25 index creation until after data load...")
	} else {
		// Create only pg_trgm extension now, indexes will be created after data load
		_, err = db.Exec("CREATE EXTENSION IF NOT EXISTS pg_trgm")
		if err != nil {
			log.Printf("Warning: Could not create pg_trgm extension: %v", err)
		}
		log.Println("PostgreSQL: Deferring index creation until after data load...")
	}

	return nil
}

func insertBatch(db *sql.DB, products []Product) error {
	if len(products) == 0 {
		return nil
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Use COPY-style batch insert for better performance
	stmt, err := tx.Prepare(`
		INSERT INTO products (asin, title, description, price, brand, categories, sales_rank, image_url)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, p := range products {
		// Handle categories - convert to PostgreSQL array format
		var categoriesArray string
		if p.Categories != nil && len(p.Categories) > 0 {
			categoryStrings := make([]string, 0)
			for _, cat := range p.Categories {
				if catList, ok := cat.([]interface{}); ok {
					for _, subCat := range catList {
						if str, ok := subCat.(string); ok {
							// Escape quotes and backslashes for PostgreSQL
							str = strings.ReplaceAll(str, "\\", "\\\\")
							str = strings.ReplaceAll(str, "\"", "\\\"")
							categoryStrings = append(categoryStrings, str)
						}
					}
				} else if str, ok := cat.(string); ok {
					// Escape quotes and backslashes for PostgreSQL
					str = strings.ReplaceAll(str, "\\", "\\\\")
					str = strings.ReplaceAll(str, "\"", "\\\"")
					categoryStrings = append(categoryStrings, str)
				}
			}
			if len(categoryStrings) > 0 {
				categoriesArray = "{\"" + strings.Join(categoryStrings, "\",\"") + "\"}"
			} else {
				categoriesArray = "{}"
			}
		} else {
			categoriesArray = "{}"
		}
		
		salesRankJSON, _ := json.Marshal(p.SalesRank)
		
		if p.Brand == "" {
			p.Brand = "Unknown"
		}
		if p.Price == "" || p.Price == "null" {
			p.Price = "0"
		}

		_, err = stmt.Exec(
			p.ASIN,
			p.Title,
			p.Description,
			p.Price,
			p.Brand,
			categoriesArray,
			string(salesRankJSON),
			p.ImageURL,
		)
		if err != nil {
			// Log error but continue with other products
			log.Printf("Error inserting product %s: %v", p.ASIN, err)
		}
	}

	return tx.Commit()
}

func createIndexesAfterLoad(db *sql.DB, isParadeDB bool) error {
	if isParadeDB {
		log.Println("Creating ParadeDB BM25 index...")
		_, err := db.Exec(`
			CREATE INDEX IF NOT EXISTS products_search_idx ON products 
			USING bm25 (id, title, description, brand) 
			WITH (
				key_field='id',
				text_fields='{
					"title": {
						"tokenizer": {"type": "en_stem"},
						"record": "position",
						"normalizer": "lowercase"
					},
					"description": {
						"tokenizer": {"type": "en_stem"},
						"record": "position",
						"normalizer": "lowercase"
					},
					"brand": {
						"tokenizer": {"type": "raw"},
						"record": "basic",
						"normalizer": "lowercase"
					}
				}'
			)
		`)
		if err != nil {
			log.Printf("Warning: Could not create optimized BM25 index: %v", err)
			// Fallback to simpler configuration
			_, err = db.Exec(`
				CREATE INDEX IF NOT EXISTS products_search_idx ON products 
				USING bm25 (id, title, description, brand) 
				WITH (key_field='id')
			`)
			if err != nil {
				return fmt.Errorf("could not create BM25 index: %v", err)
			}
		}
		log.Println("✅ ParadeDB BM25 index created")
	} else {
		log.Println("Creating PostgreSQL indexes...")
		
		// Create all indexes in parallel for faster setup
		indexes := []string{
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asin ON products(asin)",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_title_gin ON products USING gin(to_tsvector('english', title))",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_description_gin ON products USING gin(to_tsvector('english', description))",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_brand_gin ON products USING gin(to_tsvector('english', brand))",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_combined_fulltext ON products USING gin(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')))",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_title_trgm ON products USING gin (title gin_trgm_ops)",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_description_trgm ON products USING gin (description gin_trgm_ops)",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_brand_trgm ON products USING gin (brand gin_trgm_ops)",
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_price ON products(price)",
		}
		
		for i, idx := range indexes {
			log.Printf("Creating index %d/%d...", i+1, len(indexes))
			_, err := db.Exec(idx)
			if err != nil {
				log.Printf("Warning: Could not create index: %v", err)
			}
		}
		
		// Add unique constraint on asin
		_, err := db.Exec("ALTER TABLE products ADD CONSTRAINT products_asin_unique UNIQUE (asin)")
		if err != nil {
			log.Printf("Warning: Could not add unique constraint: %v", err)
		}
		
		log.Println("✅ PostgreSQL indexes created")
	}
	
	return nil
}

func processAmazonData(db *sql.DB, isParadeDB bool, wg *sync.WaitGroup) {
	defer wg.Done()

	dbType := "Vanilla"
	if isParadeDB {
		dbType = "ParadeDB"
	}
	
	start := time.Now()

	file, err := os.Open("metadata.json.gz")
	if err != nil {
		log.Printf("%s: Error opening file: %v", dbType, err)
		return
	}
	defer file.Close()

	gz, err := gzip.NewReader(file)
	if err != nil {
		log.Printf("%s: Error creating gzip reader: %v", dbType, err)
		return
	}
	defer gz.Close()

	scanner := bufio.NewScanner(gz)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // Increase buffer size

	var processedCount int32
	batch := make([]Product, 0, BatchSize)
	
	// Create a channel for batches and worker pool
	batchChan := make(chan []Product, 100)  // Increased buffer for better throughput
	workerWg := &sync.WaitGroup{}
	
	// Start worker goroutines
	for i := 0; i < MaxWorkers; i++ {
		workerWg.Add(1)
		go func() {
			defer workerWg.Done()
			for products := range batchChan {
				if err := insertBatch(db, products); err != nil {
					log.Printf("%s: Error inserting batch: %v", dbType, err)
				}
			}
		}()
	}

	for scanner.Scan() && (SampleSize == 0 || atomic.LoadInt32(&processedCount) < SampleSize) {
		line := scanner.Text()
		if line == "" {
			continue
		}

		// Convert Python dict format to JSON
		jsonLine := strings.ReplaceAll(line, "'", "\"")
		jsonLine = strings.ReplaceAll(jsonLine, "True", "true")
		jsonLine = strings.ReplaceAll(jsonLine, "False", "false")
		jsonLine = strings.ReplaceAll(jsonLine, "None", "null")

		var product Product
		if err := json.Unmarshal([]byte(jsonLine), &product); err != nil {
			continue // Skip malformed lines
		}

		if product.ASIN != "" && product.Title != "" {
			batch = append(batch, product)
			atomic.AddInt32(&processedCount, 1)

			if len(batch) >= BatchSize {
				// Send batch to workers
				batchChan <- batch
				batch = make([]Product, 0, BatchSize)
				
				count := atomic.LoadInt32(&processedCount)
				if count%50000 == 0 {
					elapsed := time.Since(start)
					rate := float64(count) / elapsed.Seconds()
					eta := time.Duration(float64(1600000-count) / rate * float64(time.Second))
					fmt.Printf("%s: %d products processed (%.0f/sec, ETA: %v)...\n", dbType, count, rate, eta.Round(time.Second))
				}
			}
		}

		if SampleSize > 0 && atomic.LoadInt32(&processedCount) >= SampleSize {
			break
		}
	}

	// Process remaining batch
	if len(batch) > 0 {
		batchChan <- batch
	}

	// Close channel and wait for workers to finish
	close(batchChan)
	workerWg.Wait()

	finalCount := atomic.LoadInt32(&processedCount)
	elapsed := time.Since(start)
	fmt.Printf("%s: Data loading complete! %d products loaded in %v\n", dbType, finalCount, elapsed.Round(time.Second))
	
	// Convert UNLOGGED table back to LOGGED for durability
	log.Printf("%s: Converting to logged table for durability...\n", dbType)
	_, err = db.Exec("ALTER TABLE products SET LOGGED")
	if err != nil {
		log.Printf("%s: Warning: Could not convert to logged table: %v", dbType, err)
	}
	
	// Create indexes AFTER data load
	log.Printf("%s: Creating indexes...\n", dbType)
	indexStart := time.Now()
	if err := createIndexesAfterLoad(db, isParadeDB); err != nil {
		log.Printf("%s: Error creating indexes: %v", dbType, err)
	}
	fmt.Printf("%s: Indexes created in %v\n", dbType, time.Since(indexStart).Round(time.Second))
	
	// Analyze table for better query performance
	log.Printf("%s: Analyzing table...\n", dbType)
	_, err = db.Exec("ANALYZE products")
	if err != nil {
		log.Printf("%s: Error analyzing table: %v", dbType, err)
	}
	
	totalTime := time.Since(start)
	fmt.Printf("%s: Total setup time: %v\n", dbType, totalTime.Round(time.Second))

	// Verify insertion
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM products").Scan(&count)
	if err == nil {
		fmt.Printf("%s: Verified %d products in database\n", dbType, count)
	}
}

func main() {
	fmt.Println("🛒 Setting up real Amazon products dataset from Stanford SNAP...")

	// Download file if needed
	if err := downloadFile(MetadataURL, "metadata.json.gz"); err != nil {
		log.Fatalf("Failed to download file: %v", err)
	}

	fmt.Println("Make sure Docker containers are running: docker-compose up -d")
	time.Sleep(3 * time.Second)

	// Connect to databases
	vanillaDB, err := getDB(vanillaConfig)
	if err != nil {
		log.Fatalf("Failed to connect to Vanilla PostgreSQL: %v", err)
	}
	defer vanillaDB.Close()

	paradeDB, err := getDB(paradeConfig)
	if err != nil {
		log.Fatalf("Failed to connect to ParadeDB: %v", err)
	}
	defer paradeDB.Close()

	// Setup tables
	if err := setupTables(vanillaDB, false); err != nil {
		log.Fatalf("Failed to setup Vanilla PostgreSQL: %v", err)
	}

	if err := setupTables(paradeDB, true); err != nil {
		log.Fatalf("Failed to setup ParadeDB: %v", err)
	}

	// Process data in parallel
	var wg sync.WaitGroup
	wg.Add(2)

	go processAmazonData(vanillaDB, false, &wg)
	go processAmazonData(paradeDB, true, &wg)

	wg.Wait()

	fmt.Println("\n✅ Real Amazon dataset setup complete!")
	fmt.Println("🚀 Run: npm run dev")
	fmt.Println("🔍 Try searching real products like: \"apple\", \"samsung phone\", \"book\", \"camera\"")
}