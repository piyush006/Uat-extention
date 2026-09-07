import dns from "node:dns/promises";
import pg from "pg";

const { Pool } = pg;

let pool;

export async function getPool() {
  if (pool) {
    return pool;
  }

  const config = {
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
    ssl: process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : false
  };

  if (process.env.DATABASE_FORCE_IPV4 !== "false" && process.env.DATABASE_URL) {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    const originalHost = databaseUrl.hostname;

    if (originalHost && originalHost !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(originalHost)) {
      const address = await dns.lookup(originalHost, { family: 4 });
      databaseUrl.searchParams.delete("sslmode");
      databaseUrl.searchParams.delete("channel_binding");
      databaseUrl.hostname = address.address;
      config.connectionString = databaseUrl.toString();

      if (config.ssl) {
        config.ssl.servername = originalHost;
      }
    }
  }

  pool = new Pool(config);
  return pool;
}

export async function query(text, params = []) {
  const activePool = await getPool();
  return activePool.query(text, params);
}

export async function initDatabase() {
  await query(`
    create table if not exists sessions (
      id bigserial primary key,
      session_id text unique not null,
      user_identifier text,
      environment text,
      started_at timestamptz,
      ended_at timestamptz,
      browser_info jsonb default '{}'::jsonb,
      application_url text,
      issue_status text default 'new',
      created_at timestamptz default now()
    );
  `);

  await query(`
    create table if not exists issues (
      id bigserial primary key,
      issue_id text unique not null,
      session_id text not null references sessions(session_id) on delete cascade,
      description text,
      status text default 'new',
      current_url text,
      screenshot text,
      created_at timestamptz default now()
    );
  `);

  await query(`
    create table if not exists events (
      id bigserial primary key,
      session_id text not null references sessions(session_id) on delete cascade,
      timestamp timestamptz not null,
      event_type text not null,
      event_data jsonb default '{}'::jsonb
    );
  `);

  await query(`
    create table if not exists network_events (
      id bigserial primary key,
      session_id text not null references sessions(session_id) on delete cascade,
      timestamp timestamptz not null,
      method text,
      url text,
      status integer,
      duration integer,
      page_url text,
      page_title text,
      tab_id text,
      window_id text,
      page_instance_id text,
      request_data jsonb default '{}'::jsonb,
      response_data jsonb default '{}'::jsonb
    );
  `);

  await query(`alter table network_events add column if not exists page_url text;`);
  await query(`alter table network_events add column if not exists page_title text;`);
  await query(`alter table network_events add column if not exists tab_id text;`);
  await query(`alter table network_events add column if not exists window_id text;`);
  await query(`alter table network_events add column if not exists page_instance_id text;`);

  await query(`create index if not exists idx_issues_created_at on issues(created_at desc);`);
  await query(`create index if not exists idx_events_session_time on events(session_id, timestamp);`);
  await query(`create index if not exists idx_network_session_time on network_events(session_id, timestamp);`);
}
