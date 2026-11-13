-- Clientes: agrupam linhas, têm chave de API própria, limite de linhas e podem ser suspensos.
CREATE TABLE IF NOT EXISTS wa_clients (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    key_hash    TEXT NOT NULL,                 -- sha256 da chave do cliente (wac_...)
    max_lines   INT NOT NULL DEFAULT 1,
    active      BOOLEAN NOT NULL DEFAULT true,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS client_id TEXT REFERENCES wa_clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS wa_sessions_client_idx ON wa_sessions (client_id);
