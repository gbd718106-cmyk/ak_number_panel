const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL;
let isSqlite = false;
let pgPool = null;
let sqliteDb = null;

// Determine which database driver to use
if (!databaseUrl || (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://'))) {
  isSqlite = true;
  console.log('💡 DATABASE_URL not set or invalid. Falling back to local file SQLite database (database.sqlite)');
  
  const sqlite3 = require('sqlite3').verbose();
  const dbPath = path.join(__dirname, '../../database.sqlite');
  sqliteDb = new sqlite3.Database(dbPath);
} else {
  console.log('🔌 Connecting to remote PostgreSQL database...');
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false }
  });
}

/**
 * Standardized query helper supporting both PostgreSQL (pg) and SQLite (sqlite3)
 */
async function query(text, params = []) {
  if (isSqlite) {
    return new Promise((resolve, reject) => {
      // 1. Convert PostgreSQL parameter placeholders ($1, $2...) to SQLite placeholders (?)
      let sqliteSql = text;
      const matches = text.match(/\$\d+/g);
      if (matches) {
        // Sort in descending order to avoid replacing $10 before $1
        const sortedMatches = [...new Set(matches)].sort((a, b) => {
          const numA = parseInt(a.slice(1));
          const numB = parseInt(b.slice(1));
          return numB - numA;
        });
        sortedMatches.forEach(m => {
          sqliteSql = sqliteSql.replaceAll(m, '?');
        });
      }

      // 2. Map PostgreSQL specific SQL grammar to SQLite compatible grammar
      sqliteSql = sqliteSql.replace(/NOW\(\) - INTERVAL '(\d+) minutes'/gi, "datetime('now', '-$1 minutes')");
      sqliteSql = sqliteSql.replace(/NOW\(\) - INTERVAL '(\d+) hours'/gi, "datetime('now', '-$1 hours')");
      sqliteSql = sqliteSql.replace(/NOW\(\) - INTERVAL '(\d+) days'/gi, "datetime('now', '-$1 days')");
      sqliteSql = sqliteSql.replace(/NOW\(\)::date/gi, "datetime('now','start of day')");
      sqliteSql = sqliteSql.replace(/NOW\(\)/gi, "datetime('now')");

      // 3. Execute
      // Identify query type (SELECT vs INSERT/UPDATE/DELETE)
      const isSelect = sqliteSql.trim().toLowerCase().startsWith('select');
      
      if (isSelect) {
        sqliteDb.all(sqliteSql, params, (err, rows) => {
          if (err) return reject(err);
          resolve({ rows });
        });
      } else {
        sqliteDb.run(sqliteSql, params, function (err) {
          if (err) return reject(err);
          const idParam = text.toLowerCase().includes('returning') ? (params[0] && typeof params[0] === 'string' && params[0].length > 20 ? params[0] : null) : null;
          resolve({ 
            rows: idParam ? [{ id: idParam }] : (this.lastID ? [{ id: this.lastID }] : []),
            rowCount: this.changes 
          });
        });
      }
    });
  } else {
    // Remote PG Connection
    return pgPool.query(text, params);
  }
}

/**
 * Generate UUID (compat tool for SQLite insertions)
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Automated database schema initialization
 */
async function initializeDatabase() {
  try {
    console.log('Reading schema.sql...');
    const schemaPath = path.join(__dirname, '../../schema.sql');
    if (!fs.existsSync(schemaPath)) {
      console.error(`schema.sql not found at path: ${schemaPath}`);
      return;
    }
    let schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    if (isSqlite) {
      console.log('Modifying SQL dialect for SQLite compatibility...');
      // Convert Postgres-specific types to SQLite
      schemaSql = schemaSql
        .replace(/UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/gi, 'TEXT PRIMARY KEY')
        .replace(/UUID REFERENCES/gi, 'TEXT REFERENCES')
        .replace(/UUID/gi, 'TEXT')
        .replace(/TIMESTAMP WITH TIME ZONE DEFAULT timezone\('utc'::text, now\(\)\)/gi, 'DATETIME DEFAULT CURRENT_TIMESTAMP')
        .replace(/TIMESTAMP WITH TIME ZONE/gi, 'DATETIME')
        .replace(/JSONB DEFAULT '\[\]'::jsonb/gi, "TEXT DEFAULT '[]'")
        .replace(/JSONB/gi, 'TEXT')
        .replace(/BIGINT/gi, 'INTEGER');
      
      // Execute the schema using serialize since sqlite3 is async
      await new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          // Split queries by semicolon to execute one-by-one in SQLite
          const queries = schemaSql
            .split(';')
            .map(q => q.trim())
            .filter(q => q.length > 0);

          let completed = 0;
          let hasError = false;

          for (const q of queries) {
            sqliteDb.run(q, (err) => {
              if (err && !err.message.includes('already exists') && !err.message.includes('duplicate key')) {
                console.warn('SQLite migration warning query:', q, err.message);
                hasError = true;
              }
              completed++;
              if (completed === queries.length) {
                if (hasError) {
                  console.warn('Database schema completed with warnings.');
                } else {
                  console.log('Database tables successfully initialized in SQLite!');
                }
                resolve();
              }
            });
          }
        });
      });
    } else {
      // Postgres natively runs it
      console.log('Executing schema.sql queries in PostgreSQL...');
      await pgPool.query(schemaSql);
      console.log('Database tables successfully initialized in PostgreSQL!');
    }

    // Run migrations for existing databases
    if (isSqlite) {
      await new Promise(resolve => {
        sqliteDb.run("ALTER TABLE admin_users ADD COLUMN is_active INTEGER DEFAULT 1", (err) => {
          if (err && !err.message.includes('duplicate column')) {
            console.warn('Migration (admin_users.is_active):', err.message);
          }
          sqliteDb.run("UPDATE admin_users SET is_active = 1 WHERE is_active IS NULL", () => {
            // Fix null IDs from initial schema INSERT
            const newId = generateUUID();
            sqliteDb.run("UPDATE admin_users SET id = ? WHERE id IS NULL", [newId], () => {
              // Convert legacy 'admin' role to 'superadmin'
              sqliteDb.run("UPDATE admin_users SET role = 'superadmin' WHERE role = 'admin'", () => {
                resolve();
              });
            });
          });
        });
      });
    } else {
      try { await pgPool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true"); } catch (e) {}
      try { await pgPool.query("UPDATE admin_users SET is_active = true WHERE is_active IS NULL"); } catch (e) {}
      try { await pgPool.query("UPDATE admin_users SET role = 'superadmin' WHERE role = 'admin'"); } catch (e) {}
    }
  } catch (err) {
    console.error('Failed to initialize database tables:', err.message);
  }
}

module.exports = {
  query,
  generateUUID,
  initializeDatabase,
  isSqlite
};
