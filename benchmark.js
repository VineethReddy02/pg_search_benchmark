import pg from 'pg';
import { performance } from 'perf_hooks';

// Command line arguments
const args = process.argv.slice(2);
const runReads = !args.includes('--writes-only');
const runWrites = !args.includes('--reads-only');

const { Pool } = pg;

const vanillaPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'benchmark_vanilla',
  user: 'benchmark',
  password: 'benchmark123'
});

const paradePool = new Pool({
  host: 'localhost',
  port: 5433,
  database: 'benchmark_parade',
  user: 'benchmark',
  password: 'benchmark123'
});

// Test queries for each search type
const testQueries = {
  fulltext: [
    "wireless headphones", "apple iphone", "samsung galaxy", "laptop computer",
    "digital camera", "bluetooth speaker", "gaming mouse", "mechanical keyboard",
    "smart watch", "4k monitor", "coffee maker", "air fryer"
  ],
  boolean: [
    "laptop AND gaming", "phone OR tablet", "camera NOT digital",
    "wireless AND (headphones OR earbuds)", "apple OR microsoft OR google",
    "laptop AND (dell OR hp OR lenovo)", "gaming AND keyboard AND mechanical",
    "speaker AND bluetooth AND waterproof"
  ],
  field: [
    "title:iphone", "brand:samsung", "title:laptop", "brand:apple",
    "description:wireless", "title:camera", "brand:sony", "title:headphones",
    "description:gaming", "brand:microsoft"
  ],
  fuzzy: [
    "samsu", "iphon", "wireles heaphones", "blutooth speker", "mechenical keybord",
    "digtal camra", "cofee makr", "laptp computr", "gamng mous", "smart wach"
  ],
  exact: [
    "wireless headphones", "apple iphone", "samsung galaxy", "digital camera",
    "bluetooth speaker", "gaming keyboard", "4k monitor", "coffee maker",
    "smart watch", "air fryer"
  ]
};

// Generate test data matching Amazon SNAP format exactly
function generateAmazonProducts(count, startId) {
  const products = [];
  const brands = [
    'Apple', 'Samsung', 'Sony', 'Microsoft', 'Dell', 'HP', 'Lenovo', 'Asus', 
    'Acer', 'Google', 'Amazon', 'Canon', 'Nikon', 'JBL', 'Bose', 'Unknown'
  ];
  const categories = [
    '{Electronics}', '{Books}', '{Computers}', '{Cell Phones & Accessories}',
    '{Video Games}', '{Sports & Outdoors}', '{Home & Kitchen}', '{Automotive}',
    '{Health & Personal Care}', '{Beauty & Personal Care}', '{Clothing Shoes & Jewelry}'
  ];
  
  const productTypes = [
    'Wireless Bluetooth Headphones', 'Gaming Laptop Computer', 'Smartphone Device',
    'Digital Camera', 'Mechanical Keyboard', 'Smart Watch', '4K Monitor',
    'Bluetooth Speaker', 'Coffee Maker', 'Air Fryer', 'Tablet Computer',
    'Gaming Mouse', 'Webcam', 'Microphone', 'Router', 'External Hard Drive'
  ];
  
  // Use timestamp + random to ensure uniqueness within 20 char limit
  const baseTime = Date.now().toString().slice(-8); // Last 8 digits of timestamp
  const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    const brand = brands[i % brands.length];
    const productType = productTypes[i % productTypes.length];
    const model = Math.floor(Math.random() * 9999) + 1000;
    
    // Generate unique ASIN within 20 character limit: T + 8 digits + 3 digits + 6 digits = 18 chars
    const uniqueAsin = `T${baseTime}${randomSuffix}${i.toString().padStart(6, '0')}`;
    
    products.push({
      asin: uniqueAsin,
      title: `${brand} ${productType} Model ${model} - High Quality Professional Grade`,
      description: `Premium ${productType.toLowerCase()} featuring advanced technology, wireless connectivity, bluetooth support, digital processing, smart features, high performance, reliable operation, professional quality, excellent design, and superior functionality. Model ${model} specifications include enhanced features for optimal user experience.`,
      price: (Math.random() * 999 + 10).toFixed(2),
      brand: brand,
      categories: categories[i % categories.length],
      sales_rank: i % 3 === 0 ? `{"Electronics": ${Math.floor(Math.random() * 1000000) + 1000}}` : null,
      image_url: `http://test-images.example.com/product-${id}.jpg`
    });
  }
  return products;
}

async function verifySetup() {
  console.log("========== VERIFYING SETUP ==========\n");
  console.log("Note: Results show Time(Relevance) where relevance scores indicate search result quality\n");
  
  // Check Vanilla PostgreSQL
  const vanillaIndexes = await vanillaPool.query(`
    SELECT indexname FROM pg_indexes 
    WHERE tablename = 'products' 
    ORDER BY indexname
  `);
  const vanillaCount = await vanillaPool.query('SELECT COUNT(*) FROM products');
  
  console.log(`Vanilla PostgreSQL: ${vanillaIndexes.rows.length} indexes, ${Number(vanillaCount.rows[0].count).toLocaleString()} products`);
  
  // Check ParadeDB
  const paradeIndexes = await paradePool.query(`
    SELECT indexname FROM pg_indexes 
    WHERE tablename = 'products' 
    ORDER BY indexname
  `);
  const paradeCount = await paradePool.query('SELECT COUNT(*) FROM products');
  
  console.log(`ParadeDB: ${paradeIndexes.rows.length} indexes, ${Number(paradeCount.rows[0].count).toLocaleString()} products`);
  
  return vanillaIndexes.rows.length >= 11 && paradeIndexes.rows.length >= 2 && vanillaCount.rows[0].count > 1000000;
}

async function runVanillaQuery(query, searchType) {
  const start = performance.now();
  let result;
  
  try {
    switch(searchType) {
      case 'fulltext':
        result = await vanillaPool.query(`
          SELECT id, title, brand, price,
                 ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                        plainto_tsquery('english', $1)) as rank_score
          FROM products
          WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')) 
                @@ plainto_tsquery('english', $1)
          ORDER BY rank_score DESC
          LIMIT 10
        `, [query]);
        break;
      
      case 'boolean':
        let pgBoolQuery = query
          .replace(/\s+AND\s+/gi, ' & ')
          .replace(/\s+OR\s+/gi, ' | ')
          .replace(/\s+NOT\s+/gi, ' & !');
        result = await vanillaPool.query(`
          SELECT id, title, brand, price
          FROM products
          WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')) 
                @@ to_tsquery('english', $1)
          LIMIT 10
        `, [pgBoolQuery]);
        break;
      
      case 'field':
        const [field, term] = query.split(':');
        result = await vanillaPool.query(`
          SELECT id, title, brand, price,
                 similarity(${field}, $1) as sim_score
          FROM products
          WHERE ${field} % $1
          ORDER BY sim_score DESC
          LIMIT 10
        `, [term]);
        break;
      
      case 'fuzzy':
        result = await vanillaPool.query(`
          SELECT id, title, brand, price,
                 GREATEST(
                   similarity(title, $1),
                   similarity(description, $1), 
                   similarity(brand, $1)
                 ) as max_similarity
          FROM products
          WHERE title % $1 OR description % $1 OR brand % $1
          ORDER BY max_similarity DESC
          LIMIT 10
        `, [query]);
        break;
      
      case 'exact':
        result = await vanillaPool.query(`
          SELECT id, title, brand, price
          FROM products
          WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')) 
                @@ phraseto_tsquery('english', $1)
          LIMIT 10
        `, [query]);
        break;
    }
  } catch (err) {
    return { duration: 0, count: 0, results: [], error: err.message };
  }
  
  const duration = performance.now() - start;
  return {
    duration: Math.round(duration),
    count: result.rowCount,
    results: result.rows
  };
}

async function runParadeQuery(query, searchType) {
  const start = performance.now();
  let result;
  
  try {
    switch(searchType) {
      case 'fulltext':
        const terms = query.split(' ');
        let searchQuery;
        if (terms.length === 1) {
          searchQuery = `title:${query}^2 OR description:${query} OR brand:${query}^1.5`;
        } else {
          searchQuery = `(title:"${query}")^2 OR (description:"${query}") OR (brand:"${query}")^1.5`;
        }
        result = await paradePool.query(`
          SELECT id, title, brand, price,
                 paradedb.score(id) as bm25_score
          FROM products
          WHERE products @@@ $1
          ORDER BY bm25_score DESC
          LIMIT 10
        `, [searchQuery]);
        break;
      
      case 'boolean':
        let paradeQuery = query
          .replace(/(\w+)(?!:)/g, (match, term) => {
            if (['AND', 'OR', 'NOT'].includes(term.toUpperCase())) {
              return term;
            }
            return `(title:${term} OR description:${term} OR brand:${term})`;
          });
        result = await paradePool.query(`
          SELECT id, title, brand, price
          FROM products
          WHERE products @@@ $1
          LIMIT 10
        `, [paradeQuery]);
        break;
      
      case 'field':
        result = await paradePool.query(`
          SELECT id, title, brand, price,
                 paradedb.score(id) as bm25_score
          FROM products
          WHERE products @@@ $1
          ORDER BY bm25_score DESC
          LIMIT 10
        `, [query]);
        break;
      
      case 'fuzzy':
        const isSingleWord = !query.includes(' ');
        if (isSingleWord) {
          result = await paradePool.query(`
            SELECT id, title, brand, price
            FROM products
            WHERE id @@@ paradedb.boolean(
              should => ARRAY[
                paradedb.fuzzy_term(field => 'title', value => $1),
                paradedb.fuzzy_term(field => 'description', value => $1),
                paradedb.fuzzy_term(field => 'brand', value => $1)
              ]
            )
            LIMIT 10
          `, [query]);
        } else {
          result = await paradePool.query(`
            SELECT id, title, brand, price
            FROM products
            WHERE id @@@ paradedb.boolean(
              should => ARRAY[
                paradedb.match(field => 'title', value => $1, distance => 2, conjunction_mode => true),
                paradedb.match(field => 'description', value => $1, distance => 2, conjunction_mode => true),
                paradedb.match(field => 'brand', value => $1, distance => 2, conjunction_mode => true)
              ]
            )
            LIMIT 10
          `, [query]);
        }
        break;
      
      case 'exact':
        const exactQuery = `title:"${query}"^2 OR description:"${query}" OR brand:"${query}"^1.5`;
        result = await paradePool.query(`
          SELECT id, title, brand, price,
                 paradedb.score(id) as bm25_score
          FROM products
          WHERE products @@@ $1
          ORDER BY bm25_score DESC
          LIMIT 10
        `, [exactQuery]);
        break;
    }
  } catch (err) {
    return { duration: 0, count: 0, results: [], error: err.message };
  }
  
  const duration = performance.now() - start;
  return {
    duration: Math.round(duration),
    count: result.rowCount,
    results: result.rows
  };
}

function calculateRelevance(results, query) {
  if (!results || results.length === 0) return 0;
  
  // Handle field searches (e.g., "title:iphone" -> extract "iphone")
  let searchTerms;
  if (query.includes(':')) {
    const fieldQuery = query.split(':');
    if (fieldQuery.length === 2) {
      searchTerms = [fieldQuery[1].toLowerCase()];
    } else {
      searchTerms = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
    }
  } else {
    searchTerms = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  }
  
  let totalScore = 0;
  
  results.forEach((result, position) => {
    const text = `${result.title || ''} ${result.brand || ''} ${result.description || ''}`.toLowerCase();
    let matchScore = 0;
    
    searchTerms.forEach(term => {
      if (text.includes(term)) {
        matchScore += 2;
        const wordBoundaryRegex = new RegExp(`\\b${term}\\b`, 'i');
        if (wordBoundaryRegex.test(text)) {
          matchScore += 3;
        }
      }
    });
    
    const positionWeight = 1 / (position + 1);
    totalScore += matchScore * positionWeight;
  });
  
  return Math.round(totalScore);
}

// Write performance tests using the same products table
async function testWrites(pool, dbName, count, batchSize) {
  console.log(`${dbName}: Testing ${count} inserts (batch size: ${batchSize})`);
  
  const products = generateAmazonProducts(count, Date.now());
  const start = performance.now();
  
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    
    try {
      const values = [];
      const placeholders = [];
      let paramIndex = 1;
      
      for (const product of batch) {
        placeholders.push(`($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5}, $${paramIndex+6}, $${paramIndex+7})`);
        values.push(
          product.asin, 
          product.title, 
          product.description, 
          product.price, 
          product.brand, 
          product.categories,
          product.sales_rank,
          product.image_url
        );
        paramIndex += 8;
      }
      
      const query = `
        INSERT INTO products (asin, title, description, price, brand, categories, sales_rank, image_url)
        VALUES ${placeholders.join(', ')}
      `;
      
      await pool.query(query, values);
    } catch (err) {
      console.error(`  Error inserting batch:`, err.message);
    }
  }
  
  const totalTime = performance.now() - start;
  const rowsPerSec = Math.round(count / (totalTime / 1000));
  
  console.log(`  ${totalTime.toFixed(0)}ms (${rowsPerSec.toLocaleString()} rows/sec)`);
  return { time: totalTime, rowsPerSec };
}

async function testSingleInserts(pool, dbName, count) {
  console.log(`${dbName}: Testing ${count} single inserts`);
  
  const products = generateAmazonProducts(count, Date.now() + 100000);
  const start = performance.now();
  
  for (const product of products) {
    try {
      await pool.query(`
        INSERT INTO products (asin, title, description, price, brand, categories, sales_rank, image_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        product.asin, 
        product.title, 
        product.description, 
        product.price, 
        product.brand, 
        product.categories,
        product.sales_rank,
        product.image_url
      ]);
    } catch (err) {
      console.error(`  Error inserting:`, err.message);
      break;
    }
  }
  
  const totalTime = performance.now() - start;
  const rowsPerSec = Math.round(count / (totalTime / 1000));
  
  console.log(`  ${totalTime.toFixed(0)}ms (${rowsPerSec.toLocaleString()} rows/sec)`);
  return { time: totalTime, rowsPerSec };
}

async function testUpdates(pool, dbName, count) {
  console.log(`${dbName}: Testing ${count} updates`);
  
  // Get random existing records
  const result = await pool.query(`
    SELECT id, title, description FROM products 
    ORDER BY RANDOM() 
    LIMIT $1
  `, [count]);
  
  if (result.rows.length === 0) {
    console.log(`  No rows to update`);
    return { time: 0, rowsPerSec: 0 };
  }
  
  const start = performance.now();
  
  for (const row of result.rows) {
    try {
      await pool.query(`
        UPDATE products 
        SET title = $1, description = $2
        WHERE id = $3
      `, [
        row.title + ' - UPDATED',
        row.description + ' Enhanced with additional features and improved functionality.',
        row.id
      ]);
    } catch (err) {
      console.error(`  Error updating:`, err.message);
    }
  }
  
  const totalTime = performance.now() - start;
  const rowsPerSec = Math.round(result.rows.length / (totalTime / 1000));
  
  console.log(`  ${totalTime.toFixed(0)}ms (${rowsPerSec.toLocaleString()} rows/sec)`);
  return { time: totalTime, rowsPerSec };
}

async function testIndexRebuild(pool, dbName) {
  console.log(`${dbName}: Testing index rebuild performance`);
  
  if (dbName === 'ParadeDB') {
    const start = performance.now();
    
    try {
      await pool.query('SET max_parallel_maintenance_workers = 8');
      await pool.query('SET maintenance_work_mem = \'512MB\'');
      await pool.query('REINDEX INDEX products_search_idx');
      
      const totalTime = performance.now() - start;
      console.log(`  Index rebuilt in ${totalTime.toFixed(0)}ms`);
      return { time: totalTime };
    } catch (err) {
      console.error(`  Error rebuilding index:`, err.message);
      return { time: 0 };
    }
  } else {
    const start = performance.now();
    
    try {
      await pool.query('REINDEX INDEX idx_combined_fulltext');
      
      const totalTime = performance.now() - start;
      console.log(`  Index rebuilt in ${totalTime.toFixed(0)}ms`);
      return { time: totalTime };
    } catch (err) {
      console.error(`  Error rebuilding index:`, err.message);
      return { time: 0 };
    }
  }
}

async function runBenchmark() {
  const setupOk = await verifySetup();
  if (!setupOk) {
    console.log("⚠️  Setup verification failed - ensure databases are properly configured");
    return;
  }
  
  let readResults = {};
  let writeResults = {};
  
  // Read Performance Tests
  if (runReads) {
    console.log("\n========== READ PERFORMANCE BENCHMARK ==========\n");
    
    for (const [searchType, queries] of Object.entries(testQueries)) {
      console.log(`--- ${searchType.toUpperCase()} SEARCH ---`);
      readResults[searchType] = {
        vanilla: { totalTime: 0, totalRelevance: 0, queries: 0 },
        parade: { totalTime: 0, totalRelevance: 0, queries: 0 }
      };
      
      for (const query of queries.slice(0, 5)) {
        const vanillaResult = await runVanillaQuery(query, searchType);
        const paradeResult = await runParadeQuery(query, searchType);
        
        const vanillaRelevance = calculateRelevance(vanillaResult.results, query);
        const paradeRelevance = calculateRelevance(paradeResult.results, query);
        
        console.log(`"${query}": Vanilla ${vanillaResult.duration}ms (${vanillaRelevance}) | ParadeDB ${paradeResult.duration}ms (${paradeRelevance})`);
        
        if (!vanillaResult.error) {
          readResults[searchType].vanilla.totalTime += vanillaResult.duration;
          readResults[searchType].vanilla.totalRelevance += vanillaRelevance;
          readResults[searchType].vanilla.queries++;
        }
        
        if (!paradeResult.error) {
          readResults[searchType].parade.totalTime += paradeResult.duration;
          readResults[searchType].parade.totalRelevance += paradeRelevance;
          readResults[searchType].parade.queries++;
        }
      }
      console.log();
    }
  }
  
  // Write Performance Tests
  if (runWrites) {
    console.log("\n========== WRITE PERFORMANCE BENCHMARK ==========\n");
    
    console.log("--- SMALL BATCH INSERTS (100 rows, batch size 10) ---");
    writeResults.smallBatch = {
      vanilla: await testWrites(vanillaPool, 'Vanilla', 100, 10),
      parade: await testWrites(paradePool, 'ParadeDB', 100, 10)
    };
    
    console.log("\n--- MEDIUM BATCH INSERTS (1000 rows, batch size 100) ---");
    writeResults.mediumBatch = {
      vanilla: await testWrites(vanillaPool, 'Vanilla', 1000, 100),
      parade: await testWrites(paradePool, 'ParadeDB', 1000, 100)
    };
    
    console.log("\n--- LARGE BATCH INSERTS (5000 rows, batch size 500) ---");
    writeResults.largeBatch = {
      vanilla: await testWrites(vanillaPool, 'Vanilla', 5000, 500),
      parade: await testWrites(paradePool, 'ParadeDB', 5000, 500)
    };
    
    console.log("\n--- SINGLE INSERTS (50 rows) ---");
    writeResults.singleInsert = {
      vanilla: await testSingleInserts(vanillaPool, 'Vanilla', 50),
      parade: await testSingleInserts(paradePool, 'ParadeDB', 50)
    };
    
    console.log("\n--- UPDATES (100 rows) ---");
    writeResults.updates = {
      vanilla: await testUpdates(vanillaPool, 'Vanilla', 100),
      parade: await testUpdates(paradePool, 'ParadeDB', 100)
    };
    
    console.log("\n--- BULK UPDATES (1000 rows) ---");
    writeResults.bulkUpdates = {
      vanilla: await testUpdates(vanillaPool, 'Vanilla', 1000),
      parade: await testUpdates(paradePool, 'ParadeDB', 1000)
    };
    
    console.log("\n--- INDEX REBUILD PERFORMANCE ---");
    writeResults.indexRebuild = {
      vanilla: await testIndexRebuild(vanillaPool, 'Vanilla'),
      parade: await testIndexRebuild(paradePool, 'ParadeDB')
    };
  }
  
  console.log("\n========== BENCHMARK SUMMARY ==========\n");
  
  // Read performance summary
  if (runReads && Object.keys(readResults).length > 0) {
    console.log("READ PERFORMANCE:");
    console.log("┌─────────────┬──────────────────────┬──────────────────────┬─────────────────────┐");
    console.log("│ Query Type  │      Vanilla PG      │      ParadeDB       │       Delta         │");
    console.log("│             │   Time  │ Relevance  │   Time  │ Relevance │  Time   │ Relevance │");
    console.log("├─────────────┼─────────┼────────────┼─────────┼───────────┼─────────┼───────────┤");
    for (const [searchType, data] of Object.entries(readResults)) {
      const vanillaAvg = data.vanilla.queries > 0 ? Math.round(data.vanilla.totalTime / data.vanilla.queries) : 0;
      const paradeAvg = data.parade.queries > 0 ? Math.round(data.parade.totalTime / data.parade.queries) : 0;
      const vanillaRel = data.vanilla.queries > 0 ? Math.round(data.vanilla.totalRelevance / data.vanilla.queries) : 0;
      const paradeRel = data.parade.queries > 0 ? Math.round(data.parade.totalRelevance / data.parade.queries) : 0;
      
      // Calculate deltas (ParadeDB - Vanilla, negative means ParadeDB is faster/lower)
      const timeDelta = paradeAvg - vanillaAvg;
      const relDelta = paradeRel - vanillaRel;
      const timeSign = timeDelta > 0 ? '+' : '';
      const relSign = relDelta > 0 ? '+' : '';
      
      console.log(`│ ${searchType.padEnd(11)} │ ${vanillaAvg.toString().padStart(5)}ms │ ${vanillaRel.toString().padStart(8)}   │ ${paradeAvg.toString().padStart(5)}ms │ ${paradeRel.toString().padStart(7)}   │ ${(timeSign + timeDelta).padStart(6)}ms │ ${(relSign + relDelta).padStart(7)}   │`);
    }
    console.log("└─────────────┴─────────┴────────────┴─────────┴───────────┴─────────┴───────────┘");
    console.log("Time: negative = ParadeDB faster | Relevance: positive = ParadeDB better");
  }
  
  // Write performance summary
  if (runWrites && Object.keys(writeResults).length > 0) {
    console.log("\nWRITE PERFORMANCE:");
    console.log("┌──────────────────┬─────────────────┬─────────────────┬─────────────────┐");
    console.log("│ Operation        │   Vanilla PG    │    ParadeDB     │      Delta      │");
    console.log("├──────────────────┼─────────────────┼─────────────────┼─────────────────┤");
    for (const [writeType, data] of Object.entries(writeResults)) {
      if (writeType === 'indexRebuild') {
        if (data.vanilla.time && data.parade.time) {
          const vanillaTime = `${data.vanilla.time.toFixed(0)}ms`;
          const paradeTime = `${data.parade.time.toFixed(0)}ms`;
          const timeDelta = data.parade.time - data.vanilla.time;
          const deltaSign = timeDelta > 0 ? '+' : '';
          const deltaStr = `${deltaSign}${timeDelta.toFixed(0)}ms`;
          console.log(`│ ${writeType.padEnd(16)} │ ${vanillaTime.padStart(13)}   │ ${paradeTime.padStart(13)}   │ ${deltaStr.padStart(13)}   │`);
        }
      } else if (data.vanilla.rowsPerSec && data.parade.rowsPerSec) {
        const vanillaRate = `${data.vanilla.rowsPerSec.toLocaleString()}/sec`;
        const paradeRate = `${data.parade.rowsPerSec.toLocaleString()}/sec`;
        const rateDelta = data.parade.rowsPerSec - data.vanilla.rowsPerSec;
        const deltaSign = rateDelta > 0 ? '+' : '';
        const deltaStr = `${deltaSign}${rateDelta.toLocaleString()}/sec`;
        console.log(`│ ${writeType.padEnd(16)} │ ${vanillaRate.padStart(13)}   │ ${paradeRate.padStart(13)}   │ ${deltaStr.padStart(13)}   │`);
      }
    }
    console.log("└──────────────────┴─────────────────┴─────────────────┴─────────────────┘");
    console.log("Rate: positive = ParadeDB higher throughput | Time: negative = ParadeDB faster");
  }
  
}

// Usage information
if (args.includes('--help')) {
  console.log(`
PostgreSQL vs ParadeDB Benchmark Tool

Usage:
  node benchmark.js [options]

Options:
  --help              Show this help message
  --reads-only        Run only read performance tests
  --writes-only       Run only write performance tests

Examples:
  node benchmark.js                    # Run all tests
  node benchmark.js --reads-only       # Test search performance only  
  node benchmark.js --writes-only      # Test write performance only
`);
  process.exit(0);
}

// Run the benchmark
runBenchmark()
  .then(() => {
    console.log("\nBenchmark complete!");
    process.exit(0);
  })
  .catch(err => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });