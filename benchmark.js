import pg from 'pg';
import { performance } from 'perf_hooks';

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

async function verifySetup() {
  console.log("========== VERIFYING SETUP ==========\n");
  
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
  
  const queryTerms = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  let totalScore = 0;
  
  results.forEach((result, position) => {
    const text = `${result.title || ''} ${result.brand || ''}`.toLowerCase();
    let matchScore = 0;
    
    queryTerms.forEach(term => {
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

// Generate test data for writes
function generateProducts(count, startId) {
  const products = [];
  const brands = ['Apple', 'Samsung', 'Sony', 'Microsoft', 'Dell', 'HP'];
  
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    products.push({
      asin: `TEST${id.toString().padStart(10, '0')}`,
      title: `Test Product ${id} - ${brands[i % brands.length]}`,
      description: `Test description with keywords wireless bluetooth digital smart`,
      price: `${(Math.random() * 1000 + 50).toFixed(2)}`,
      brand: brands[i % brands.length],
      categories: ['Electronics']
    });
  }
  return products;
}

async function testWrites(pool, dbName, count, batchSize) {
  console.log(`${dbName}: Testing ${count} inserts (batch size: ${batchSize})`);
  
  const products = generateProducts(count, Date.now());
  const start = performance.now();
  
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    
    try {
      const values = [];
      const placeholders = [];
      let paramIndex = 1;
      
      for (const product of batch) {
        placeholders.push(`($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5})`);
        values.push(product.asin, product.title, product.description, product.price, product.brand, '{"Electronics"}');
        paramIndex += 6;
      }
      
      const query = `
        INSERT INTO products (asin, title, description, price, brand, categories)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT DO NOTHING
      `;
      
      await pool.query(query, values);
    } catch (err) {
      console.error(`  Error inserting batch:`, err.message);
    }
  }
  
  const totalTime = performance.now() - start;
  const rowsPerSec = Math.round(count / (totalTime / 1000));
  
  console.log(`  ${totalTime.toFixed(0)}ms (${rowsPerSec} rows/sec)`);
  return { time: totalTime, rowsPerSec };
}

async function testSingleInserts(pool, dbName, count) {
  console.log(`${dbName}: Testing ${count} single inserts`);
  
  const products = generateProducts(count, Date.now() + 100000);
  const start = performance.now();
  
  for (const product of products) {
    try {
      await pool.query(`
        INSERT INTO products (asin, title, description, price, brand, categories)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [product.asin, product.title, product.description, product.price, product.brand, '{"Electronics"}']);
    } catch (err) {
      console.error(`  Error inserting:`, err.message);
      break;
    }
  }
  
  const totalTime = performance.now() - start;
  const rowsPerSec = Math.round(count / (totalTime / 1000));
  
  console.log(`  ${totalTime.toFixed(0)}ms (${rowsPerSec} rows/sec)`);
  return { time: totalTime, rowsPerSec };
}

async function testUpdates(pool, dbName, count) {
  console.log(`${dbName}: Testing ${count} updates`);
  
  // Get random existing records
  const result = await pool.query(`
    SELECT id, title FROM products 
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
        'Updated description with new keywords',
        row.id
      ]);
    } catch (err) {
      console.error(`  Error updating:`, err.message);
    }
  }
  
  const totalTime = performance.now() - start;
  const rowsPerSec = Math.round(result.rows.length / (totalTime / 1000));
  
  console.log(`  ${totalTime.toFixed(0)}ms (${rowsPerSec} rows/sec)`);
  return { time: totalTime, rowsPerSec };
}

async function runBenchmark() {
  const setupOk = await verifySetup();
  if (!setupOk) {
    console.log("⚠️  Setup verification failed - ensure databases are properly configured");
    return;
  }
  
  console.log("\n========== READ PERFORMANCE BENCHMARK ==========\n");
  
  const readResults = {};
  
  // Test each search type
  for (const [searchType, queries] of Object.entries(testQueries)) {
    console.log(`--- ${searchType.toUpperCase()} SEARCH ---`);
    readResults[searchType] = {
      vanilla: { totalTime: 0, totalRelevance: 0, queries: 0 },
      parade: { totalTime: 0, totalRelevance: 0, queries: 0 }
    };
    
    for (const query of queries.slice(0, 5)) { // Test first 5 queries for speed
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
  
  console.log("========== WRITE PERFORMANCE BENCHMARK ==========\n");
  
  const writeResults = {};
  
  // Test batch inserts
  console.log("--- BATCH INSERTS (1000 rows, batch size 100) ---");
  writeResults.batchInsert = {
    vanilla: await testWrites(vanillaPool, 'Vanilla', 1000, 100),
    parade: await testWrites(paradePool, 'ParadeDB', 1000, 100)
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
  
  console.log("\n========== BENCHMARK SUMMARY ==========\n");
  
  // Read performance summary
  console.log("READ PERFORMANCE (avg time | avg relevance):");
  for (const [searchType, data] of Object.entries(readResults)) {
    const vanillaAvg = data.vanilla.queries > 0 ? Math.round(data.vanilla.totalTime / data.vanilla.queries) : 0;
    const paradeAvg = data.parade.queries > 0 ? Math.round(data.parade.totalTime / data.parade.queries) : 0;
    const vanillaRel = data.vanilla.queries > 0 ? Math.round(data.vanilla.totalRelevance / data.vanilla.queries) : 0;
    const paradeRel = data.parade.queries > 0 ? Math.round(data.parade.totalRelevance / data.parade.queries) : 0;
    
    const speedWinner = vanillaAvg < paradeAvg ? 'Vanilla' : 'ParadeDB';
    const speedDiff = vanillaAvg && paradeAvg ? (Math.max(vanillaAvg, paradeAvg) / Math.min(vanillaAvg, paradeAvg)).toFixed(1) : 'N/A';
    
    console.log(`${searchType.padEnd(10)}: Vanilla ${vanillaAvg}ms (${vanillaRel}) | ParadeDB ${paradeAvg}ms (${paradeRel}) | Winner: ${speedWinner} ${speedDiff}x`);
  }
  
  // Write performance summary
  console.log("\nWRITE PERFORMANCE (rows/sec):");
  for (const [writeType, data] of Object.entries(writeResults)) {
    const speedWinner = data.vanilla.rowsPerSec > data.parade.rowsPerSec ? 'Vanilla' : 'ParadeDB';
    const speedDiff = (Math.max(data.vanilla.rowsPerSec, data.parade.rowsPerSec) / Math.min(data.vanilla.rowsPerSec, data.parade.rowsPerSec)).toFixed(1);
    
    console.log(`${writeType.padEnd(12)}: Vanilla ${data.vanilla.rowsPerSec} | ParadeDB ${data.parade.rowsPerSec} | Winner: ${speedWinner} ${speedDiff}x`);
  }
  
}

// Run the comprehensive benchmark
runBenchmark()
  .then(() => {
    console.log("\n✅ Comprehensive benchmark complete!");
    process.exit(0);
  })
  .catch(err => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });