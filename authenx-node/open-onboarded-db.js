'use strict';

const { Client } = require('pg');

(async () => {
  const adminClient = new Client({
    host: 'localhost',
    port: 5432,
    user: process.env.AUTHENX_PG_USER || 'postgres',
    password: process.env.AUTHENX_PG_PASSWORD || '',
    database: process.env.AUTHENX_PG_DATABASE || 'postgres',
  });

  await adminClient.connect();
  const provisioning = await adminClient.query(
    'SELECT college_id, db_name, db_user, provisioned, provisioned_at FROM college_postgres_provisioning ORDER BY provisioned_at DESC NULLS LAST, college_id'
  );
  const rows = provisioning.rows;

  if (!rows.length) {
    console.log('No onboarding-provisioned databases found.');
    await adminClient.end();
    return;
  }

  console.log('Provisioned entries:');
  rows.forEach((r, i) => {
    console.log(`${i + 1}. ${r.college_id} -> ${r.db_name} (user=${r.db_user}, provisioned=${r.provisioned})`);
  });

  const target = rows.find((r) => Number(r.provisioned) === 1) || rows[0];
  console.log(`\nOpening DB: ${target.db_name}`);
  await adminClient.end();

  const c = new Client({
    host: 'localhost',
    port: 5432,
    user: process.env.AUTHENX_PG_USER || 'postgres',
    password: process.env.AUTHENX_PG_PASSWORD || '',
    database: target.db_name,
  });

  await c.connect();
  const tbl = await c.query(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name"
  );

  console.log('Tables:');
  if (!tbl.rows.length) {
    console.log('(no user tables yet)');
  } else {
    tbl.rows.forEach((t) => console.log(`- ${t.table_schema}.${t.table_name}`));
  }

  await c.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
