
    CREATE TABLE IF NOT EXISTS person (
      id TEXT PRIMARY KEY,
      directory_object_id TEXT UNIQUE,
      sign_in_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      home_office_id TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS office (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_grant (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      role TEXT NOT NULL,
      office_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS company_setting (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      weekend_weight REAL NOT NULL,
      lookback_months INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pantry_product (
      id TEXT PRIMARY KEY,
      office_id TEXT NOT NULL,
      name TEXT NOT NULL,
      reorder_level INTEGER NOT NULL,
      warning_effective_days INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pantry_purchase (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      purchased_on TEXT NOT NULL,
      packs INTEGER NOT NULL,
      price_per_pack TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pantry_count (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      counted_on TEXT NOT NULL,
      packs INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT,
      UNIQUE (product_id, counted_on)
    );
    CREATE TABLE IF NOT EXISTS pantry_receipt (
      purchase_id TEXT PRIMARY KEY,
      blob_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS operation (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      office_id TEXT,
      at TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      token_hash TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      graph_refresh TEXT
    );
    CREATE TABLE IF NOT EXISTS login_attempt (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      nonce TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refresh_token (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      family_id TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      graph_refresh TEXT,
      expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      replaced_by TEXT
    );
    CREATE INDEX IF NOT EXISTS refresh_token_family ON refresh_token(family_id);
    CREATE TABLE IF NOT EXISTS setup_ticket (
      jti_hash TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      person_id TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (person_id, key)
    );
    CREATE TABLE IF NOT EXISTS proposal (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      summary TEXT NOT NULL,
      office_id TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_thread (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_message (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      proposals TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_thread_person ON chat_thread(person_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS chat_message_thread ON chat_message(thread_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS product_name_active
      ON pantry_product(office_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS grant_active
      ON role_grant(person_id, role, ifnull(office_id, '')) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS person_sign_in_lower ON person(lower(sign_in_name));
    CREATE UNIQUE INDEX IF NOT EXISTS office_name_lower ON office(lower(name));
    CREATE TABLE IF NOT EXISTS receipt_reading (
      id TEXT PRIMARY KEY,
      office_id TEXT NOT NULL,
      blob_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS receipt_reading_office ON receipt_reading(office_id, created_at);
  