-- The Postgres schema the previous fork main created (Python package 0.5.17,
-- commit 5e3656637b601c002659602efff82bb3428c9a35, src/hevy2garmin/db_postgres.py
-- _ensure_tables). Copied verbatim in content, as one script, so the migration
-- qualification starts from exactly what an existing deployment holds.
-- Schema only: no data, real or otherwise.
CREATE TABLE IF NOT EXISTS synced_workouts (
    hevy_id TEXT PRIMARY KEY,
    garmin_activity_id TEXT,
    title TEXT,
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    calories INTEGER,
    avg_hr INTEGER,
    status VARCHAR(20) DEFAULT 'success'
);
CREATE TABLE IF NOT EXISTS sync_log (
    id BIGSERIAL PRIMARY KEY,
    time TIMESTAMPTZ DEFAULT NOW(),
    synced INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    trigger VARCHAR(50) DEFAULT 'manual'
);
CREATE TABLE IF NOT EXISTS hr_cache (
    hevy_id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS platform_credentials (
    platform VARCHAR(50) PRIMARY KEY,
    auth_type VARCHAR(20) NOT NULL DEFAULT 'oauth',
    credentials JSONB NOT NULL DEFAULT '{}',
    connected_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'disconnected'
);
CREATE TABLE IF NOT EXISTS custom_mappings (
    hevy_name TEXT PRIMARY KEY,
    category INTEGER NOT NULL,
    subcategory INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE synced_workouts ADD COLUMN hevy_updated_at TEXT;
ALTER TABLE synced_workouts ADD COLUMN sync_method TEXT DEFAULT 'upload';
CREATE TABLE IF NOT EXISTS app_cache (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
