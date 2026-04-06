'use strict';
/**
 * AuthenX Connector — Adapter Factory
 * Loads the correct DB adapter based on config.db_type.
 *
 * Supported db_type values:
 *   "sqlite"    → Built-in Node.js SQLite (no npm needed)
 *   "mysql"     → MySQL / MariaDB (requires: npm install mysql2)
 *   "postgres"  → PostgreSQL (requires: npm install pg)
 *   "mssql"     → SQL Server / Azure SQL (requires: npm install mssql)
 *   "api"       → REST API (no npm needed)
 */

const ADAPTERS = {
  sqlite:   () => require('./sqlite.js'),
  mysql:    () => require('./mysql.js'),
  mariadb:  () => require('./mysql.js'),   // alias
  postgres: () => require('./postgres.js'),
  postgresql:() => require('./postgres.js'),// alias
  pg:       () => require('./postgres.js'), // alias
  mssql:    () => require('./mssql.js'),
  sqlserver:() => require('./mssql.js'),   // alias
  api:      () => require('./api.js'),
  rest:     () => require('./api.js'),     // alias
};

const INSTALL_HINTS = {
  mysql:   'npm install mysql2',
  mariadb: 'npm install mysql2',
  postgres:'npm install pg',
  postgresql: 'npm install pg',
  pg:      'npm install pg',
  mssql:   'npm install mssql',
  sqlserver:'npm install mssql',
};

/**
 * Load and return the adapter for the given db_type.
 * Throws a clear error if the type is unsupported or the package is missing.
 */
function getAdapter(dbType) {
  const type = (dbType || 'sqlite').toLowerCase();
  const loader = ADAPTERS[type];
  if (!loader) {
    throw new Error(
      `Unsupported db_type: "${dbType}". ` +
      `Supported types: ${Object.keys(ADAPTERS).join(', ')}`
    );
  }
  try {
    return loader();
  } catch (err) {
    const hint = INSTALL_HINTS[type];
    if (hint && err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Adapter "${type}" requires an npm package.\n` +
        `Install it: cd authenx-connector && ${hint}\n` +
        `Then restart the connector.`
      );
    }
    throw err;
  }
}

/**
 * Return list of all supported db_types.
 */
function listSupportedTypes() {
  return [...new Set(Object.keys(ADAPTERS))];
}

module.exports = { getAdapter, listSupportedTypes };
