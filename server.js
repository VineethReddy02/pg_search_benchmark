import express from 'express';
import pg from 'pg';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;
const app = express();
const PORT = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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

async function runVanillaSearch(query, searchType) {
  const start = Date.now();
  let result;
  let actualQuery;
  let params;
  
  switch(searchType) {
    case 'fulltext':
      // PostgreSQL Full-Text Search with ts_vector, ts_rank and GIN index
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                      plainto_tsquery('english', $1)) as rank_score
        FROM products
        WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')) 
              @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                         plainto_tsquery('english', $1)) DESC
        LIMIT 10
        -- Uses: GIN indexes (idx_title_gin, idx_description_gin) + ts_vector + ts_rank`;
      params = [query];
      result = await vanillaPool.query(actualQuery, params);
      break;
    
    case 'boolean':
      // PostgreSQL native boolean full-text search with ts_query
      // Convert natural language boolean to PostgreSQL ts_query syntax
      let pgBoolQuery = query
        .replace(/title:/g, '')
        .replace(/description:/g, '')  
        .replace(/brand:/g, '')
        // Handle NOT first to avoid conflicts
        .replace(/\s+NOT\s+(\w+)/gi, ' & !$1')
        .replace(/\s+AND\s+/gi, ' & ')
        .replace(/\s+OR\s+/gi, ' | ');
      
      // Handle parentheses and clean up extra spaces
      pgBoolQuery = pgBoolQuery
        .replace(/\s+/g, ' ')
        .trim();
      
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                      to_tsquery('english', $1)) as rank_score
        FROM products
        WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')) 
              @@ to_tsquery('english', $1)
        ORDER BY ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                         to_tsquery('english', $1)) DESC
        LIMIT 10
        -- Uses: GIN indexes + ts_query boolean operators (&, |, !)
        -- Original: ${query} -> PostgreSQL: ${pgBoolQuery}`;
      params = [pgBoolQuery];
      result = await vanillaPool.query(actualQuery, params);
      break;
    
    case 'field':
      // PostgreSQL doesn't have native field search, use pg_trgm similarity for approximation
      const field = query.includes('title:') ? 'title' : 
                   query.includes('description:') ? 'description' :
                   query.includes('brand:') ? 'brand' : 'title';
      const searchTerm = query.replace(/\w+:/, '');
      
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               similarity(${field}, $1) as similarity_score
        FROM products
        WHERE ${field} % $1
        ORDER BY similarity(${field}, $1) DESC
        LIMIT 10
        -- Uses: pg_trgm GIN index (idx_${field}_trgm) + similarity operator
        -- Field-specific search on: ${field}`;
      params = [searchTerm];
      result = await vanillaPool.query(actualQuery, params);
      break;
    
    case 'like':
      // PostgreSQL optimized pattern search using pg_trgm similarity
      // This will use GIN indexes instead of sequential scan
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               GREATEST(
                 similarity(title, $1),
                 similarity(description, $1), 
                 similarity(brand, $1)
               ) as max_similarity
        FROM products
        WHERE title % $1 OR description % $1 OR brand % $1
        ORDER BY max_similarity DESC
        LIMIT 10
        -- Uses: pg_trgm GIN indexes for similarity-based pattern matching
        -- Optimized replacement for ILIKE %pattern% queries`;
      params = [query];
      result = await vanillaPool.query(actualQuery, params);
      break;
    
    case 'exact':
      // PostgreSQL phrase search - find documents containing the phrase
      // Using phraseto_tsquery for exact phrase matching
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                      phraseto_tsquery('english', $1)) as rank_score
        FROM products
        WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')) 
              @@ phraseto_tsquery('english', $1)
        ORDER BY ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                         phraseto_tsquery('english', $1)) DESC
        LIMIT 10
        -- Uses: phraseto_tsquery for exact phrase matching with ts_vector`;
      params = [query];
      result = await vanillaPool.query(actualQuery, params);
      break;
      
    default:
      // Default to fulltext search
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                      plainto_tsquery('english', $1)) as rank_score
        FROM products
        WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')) 
              @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(brand, '')), 
                         plainto_tsquery('english', $1)) DESC
        LIMIT 10
        -- Uses: GIN indexes + ts_vector + ts_rank (default full-text)`;
      params = [query];
      result = await vanillaPool.query(actualQuery, params);
  }
  
  const duration = Date.now() - start;
  
  return { 
    results: result.rows, 
    duration, 
    count: result.rowCount, 
    actualQuery: actualQuery.trim(),
    params: params,
    engine: 'PostgreSQL Full-Text Search'
  };
}

async function runParadeSearch(query, searchType) {
  const start = Date.now();
  let result;
  let searchQuery;
  let actualQuery;
  let params;
  
  switch(searchType) {
    case 'fulltext':
      // Optimized BM25 multi-field search with field boosting
      // Title matches are most important (boost 2x), brand is second (1.5x)
      searchQuery = `title:${query}^2 OR description:${query} OR brand:${query}^1.5`;
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               paradedb.score(id) as bm25_score
        FROM products
        WHERE products @@@ $1
        ORDER BY bm25_score DESC
        LIMIT 10
        -- BM25 Query with field boosting and scoring`;
      params = [searchQuery];
      result = await paradePool.query(actualQuery, params);
      break;
    
    case 'boolean':
      // Convert natural language boolean to ParadeDB field syntax
      // ParadeDB requires field-specific queries for boolean operations
      let paradeQuery = query
        // Convert terms without fields to multi-field search
        .replace(/(\w+)(?!\:)/g, (match, term) => {
          // Don't convert boolean operators
          if (['AND', 'OR', 'NOT'].includes(term.toUpperCase())) {
            return term;
          }
          // Convert single terms to search across all fields
          return `(title:${term} OR description:${term} OR brand:${term})`;
        });
      
      searchQuery = paradeQuery;
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories
        FROM products
        WHERE products @@@ $1
        LIMIT 10
        -- BM25 Boolean Query: ${searchQuery}`;
      params = [paradeQuery];
      result = await paradePool.query(actualQuery, params);
      break;
    
    case 'field':
      // Optimized single field targeted search with BM25 scoring
      // Expecting format: field:term (e.g., "title:iPhone")
      searchQuery = query;
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               paradedb.score(id) as bm25_score
        FROM products
        WHERE products @@@ $1
        ORDER BY bm25_score DESC
        LIMIT 10
        -- BM25 Field-specific query with scoring`;
      params = [query];
      result = await paradePool.query(actualQuery, params);
      break;
    
    case 'like':
      // ParadeDB fuzzy search using proper fuzzy_term for single word typos
      // or match for multi-word fuzzy matching
      const isSingleWord = !query.includes(' ');
      
      if (isSingleWord) {
        // Use fuzzy_term for single word typo tolerance (like "samsu" -> "samsung")
        actualQuery = `
          SELECT id, asin, title, description, price, brand, categories
          FROM products
          WHERE id @@@ paradedb.boolean(
            should => ARRAY[
              paradedb.fuzzy_term(field => 'title', value => $1),
              paradedb.fuzzy_term(field => 'description', value => $1),
              paradedb.fuzzy_term(field => 'brand', value => $1)
            ]
          )
          LIMIT 10
          -- ParadeDB: Using fuzzy_term for single word typo correction`;
      } else {
        // Use match for multi-word fuzzy matching with field match indicators
        actualQuery = `
          SELECT id, asin, title, description, price, brand, categories,
                 CASE WHEN id @@@ paradedb.match(field => 'title', value => $1, distance => 2, conjunction_mode => true) 
                      THEN 'TITLE' ELSE '' END ||
                 CASE WHEN id @@@ paradedb.match(field => 'description', value => $1, distance => 2, conjunction_mode => true) 
                      THEN ' DESC' ELSE '' END ||
                 CASE WHEN id @@@ paradedb.match(field => 'brand', value => $1, distance => 2, conjunction_mode => true) 
                      THEN ' BRAND' ELSE '' END AS match_fields
          FROM products
          WHERE id @@@ paradedb.boolean(
            should => ARRAY[
              paradedb.match(field => 'title', value => $1, distance => 2, conjunction_mode => true),
              paradedb.match(field => 'description', value => $1, distance => 2, conjunction_mode => true),
              paradedb.match(field => 'brand', value => $1, distance => 2, conjunction_mode => true)
            ]
          )
          LIMIT 10
          -- ParadeDB: Multi-word fuzzy search with match field indicators`;
      }
      
      params = [query];
      result = await paradePool.query(actualQuery, params);
      searchQuery = isSingleWord ? `fuzzy_term: ${query}` : `fuzzy match: ${query}`;
      break;
    
    case 'exact':
      // Optimized ParadeDB phrase search with field boosting and scoring
      // Exact phrase matches in title are most relevant
      searchQuery = `title:"${query}"^2 OR description:"${query}" OR brand:"${query}"^1.5`;
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories,
               paradedb.score(id) as bm25_score
        FROM products
        WHERE products @@@ $1
        ORDER BY bm25_score DESC
        LIMIT 10
        -- BM25 Phrase Query with boosting and scoring`;
      params = [searchQuery];
      result = await paradePool.query(actualQuery, params);
      break;
      
    default:
      // Default to BM25 phrase search
      searchQuery = `title:"${query}" OR description:"${query}" OR brand:"${query}"`;
      actualQuery = `
        SELECT id, asin, title, description, price, brand, categories
        FROM products
        WHERE products @@@ $1
        LIMIT 10
        -- BM25 Multi-field Phrase Query: ${searchQuery}`;
      params = [searchQuery];
      result = await paradePool.query(actualQuery, params);
  }
  
  const duration = Date.now() - start;
  
  return { 
    results: result.rows, 
    duration, 
    count: result.rowCount, 
    actualQuery: actualQuery.trim(),
    params: params,
    searchQuery: searchQuery || query,
    engine: 'ParadeDB BM25 Search'
  };
}

// Relevance scoring function
function calculateRelevanceScore(results, query) {
  if (!results || results.length === 0) return 0;
  
  const queryTerms = query.toLowerCase().split(/\s+/);
  let totalScore = 0;
  
  results.forEach((result, position) => {
    const text = `${result.title || ''} ${result.description || ''} ${result.brand || ''}`.toLowerCase();
    let matchScore = 0;
    let termMatches = 0;
    
    // Check how many query terms match
    queryTerms.forEach(term => {
      if (text.includes(term)) {
        termMatches++;
        // Bonus for exact word match vs substring
        const wordBoundaryRegex = new RegExp(`\\b${term}\\b`, 'i');
        if (wordBoundaryRegex.test(text)) {
          matchScore += 2;
        } else {
          matchScore += 1;
        }
      }
    });
    
    // Calculate term coverage (what % of query terms were found)
    const termCoverage = termMatches / queryTerms.length;
    
    // Position weight (top results matter more)
    const positionWeight = 1 / (position + 1);
    
    // Title match bonus (title matches are more relevant)
    const title = (result.title || '').toLowerCase();
    let titleBonus = 0;
    queryTerms.forEach(term => {
      if (title.includes(term)) titleBonus += 3;
    });
    
    // Calculate final score for this result
    const resultScore = (matchScore + titleBonus) * termCoverage * positionWeight;
    totalScore += resultScore;
  });
  
  // Normalize score to 0-100 scale
  const maxPossibleScore = results.length * queryTerms.length * 5;
  return Math.min(100, (totalScore / maxPossibleScore) * 100);
}

// Calculate NDCG (Normalized Discounted Cumulative Gain) - industry standard
function calculateNDCG(results, query, k = 10) {
  if (!results || results.length === 0) return 0;
  
  const queryTerms = query.toLowerCase().split(/\s+/);
  const topK = results.slice(0, k);
  
  // Calculate relevance scores for each result
  const relevanceScores = topK.map(result => {
    const text = `${result.title || ''} ${result.description || ''} ${result.brand || ''}`.toLowerCase();
    let score = 0;
    
    queryTerms.forEach(term => {
      // Title matches are worth more
      if ((result.title || '').toLowerCase().includes(term)) score += 3;
      // Description matches
      if ((result.description || '').toLowerCase().includes(term)) score += 1;
      // Brand matches
      if ((result.brand || '').toLowerCase().includes(term)) score += 2;
    });
    
    return score / (queryTerms.length * 6); // Normalize to 0-1
  });
  
  // Calculate DCG (Discounted Cumulative Gain)
  let dcg = 0;
  relevanceScores.forEach((score, i) => {
    const position = i + 1;
    dcg += (Math.pow(2, score) - 1) / Math.log2(position + 1);
  });
  
  // Calculate IDCG (Ideal DCG) - if results were perfectly ordered
  const sortedScores = [...relevanceScores].sort((a, b) => b - a);
  let idcg = 0;
  sortedScores.forEach((score, i) => {
    const position = i + 1;
    idcg += (Math.pow(2, score) - 1) / Math.log2(position + 1);
  });
  
  // NDCG = DCG / IDCG
  return idcg === 0 ? 0 : (dcg / idcg) * 100;
}

app.post('/api/benchmark', async (req, res) => {
  try {
    const { query, searchType = 'fulltext' } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    let vanilla, parade;
    
    try {
      vanilla = await runVanillaSearch(query, searchType);
    } catch (err) {
      console.error('Vanilla search error:', err);
      vanilla = { results: [], duration: 0, count: 0, error: err.message };
    }
    
    try {
      parade = await runParadeSearch(query, searchType);
    } catch (err) {
      console.error('ParadeDB search error:', err);
      parade = { results: [], duration: 0, count: 0, error: err.message };
    }
    
    // Calculate relevance scores
    const vanillaRelevance = calculateRelevanceScore(vanilla.results, query);
    const paradeRelevance = calculateRelevanceScore(parade.results, query);
    
    // Calculate NDCG scores (industry standard metric)
    const vanillaNDCG = calculateNDCG(vanilla.results, query);
    const paradeNDCG = calculateNDCG(parade.results, query);
    
    // Determine accuracy winner
    let accuracyWinner = 'tie';
    let accuracyDiff = 0;
    
    if (vanillaNDCG > paradeNDCG + 5) {
      accuracyWinner = 'vanilla';
      accuracyDiff = vanillaNDCG - paradeNDCG;
    } else if (paradeNDCG > vanillaNDCG + 5) {
      accuracyWinner = 'parade';
      accuracyDiff = paradeNDCG - vanillaNDCG;
    }
    
    const speedup = vanilla.duration > 0 && parade.duration > 0 
      ? (vanilla.duration / parade.duration).toFixed(2) + 'x' 
      : 'N/A';
    
    res.json({
      query,
      searchType,
      vanilla: {
        ...vanilla,
        relevanceScore: vanillaRelevance.toFixed(1),
        ndcgScore: vanillaNDCG.toFixed(1)
      },
      parade: {
        ...parade,
        relevanceScore: paradeRelevance.toFixed(1),
        ndcgScore: paradeNDCG.toFixed(1)
      },
      speedup,
      accuracy: {
        winner: accuracyWinner,
        difference: accuracyDiff.toFixed(1),
        vanillaScore: vanillaNDCG.toFixed(1),
        paradeScore: paradeNDCG.toFixed(1)
      }
    });
  } catch (error) {
    console.error('Benchmark error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const vanillaCount = await vanillaPool.query('SELECT COUNT(*) FROM products');
    const paradeCount = await paradePool.query('SELECT COUNT(*) FROM products');
    
    res.json({
      vanilla: { count: vanillaCount.rows[0].count },
      parade: { count: paradeCount.rows[0].count }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/schema', async (req, res) => {
  try {
    // Vanilla PostgreSQL schema info
    const vanillaSchema = await vanillaPool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'products' 
      ORDER BY ordinal_position
    `);
    
    const vanillaIndexes = await vanillaPool.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'products'
      ORDER BY indexname
    `);
    
    const vanillaExtensions = await vanillaPool.query(`
      SELECT extname, extversion 
      FROM pg_extension 
      WHERE extname NOT IN ('plpgsql')
      ORDER BY extname
    `);
    
    const vanillaCount = await vanillaPool.query('SELECT COUNT(*) FROM products');
    
    // ParadeDB schema info
    const paradeSchema = await paradePool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'products' 
      ORDER BY ordinal_position
    `);
    
    const paradeIndexes = await paradePool.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'products'
      ORDER BY indexname
    `);
    
    const paradeExtensions = await paradePool.query(`
      SELECT extname, extversion 
      FROM pg_extension 
      WHERE extname NOT IN ('plpgsql')
      ORDER BY extname
    `);
    
    const paradeCount = await paradePool.query('SELECT COUNT(*) FROM products');
    
    // Format the results
    const formatSchema = (rows) => {
      return rows.map(row => 
        `${row.column_name}: ${row.data_type}${row.is_nullable === 'NO' ? ' NOT NULL' : ''}${row.column_default ? ` DEFAULT ${row.column_default}` : ''}`
      ).join('\n');
    };
    
    const formatIndexes = (rows) => {
      return rows.map(row => `${row.indexname}:\n  ${row.indexdef}`).join('\n\n');
    };
    
    const formatExtensions = (rows) => {
      return rows.map(row => `${row.extname} v${row.extversion}`).join('\n');
    };
    
    res.json({
      vanilla: {
        schema: formatSchema(vanillaSchema.rows),
        indexes: formatIndexes(vanillaIndexes.rows),
        extensions: formatExtensions(vanillaExtensions.rows),
        records: `${Number(vanillaCount.rows[0].count).toLocaleString()} products`
      },
      parade: {
        schema: formatSchema(paradeSchema.rows),
        indexes: formatIndexes(paradeIndexes.rows),
        extensions: formatExtensions(paradeExtensions.rows),
        records: `${Number(paradeCount.rows[0].count).toLocaleString()} products`
      }
    });
  } catch (error) {
    console.error('Schema error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});