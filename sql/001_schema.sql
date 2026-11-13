-- Motor WhatsApp alternativo — esquema PostgreSQL
-- Idempotente: pode rodar mais de uma vez.

-- Linhas (cada uma é um número de WhatsApp conectado por QR ou código de pareamento).
-- O "id" faz o papel do phone_number_id da Cloud API.
CREATE TABLE IF NOT EXISTS wa_sessions (
    id              TEXT PRIMARY KEY,                 -- ex.: "festavibe-01"
    name            TEXT NOT NULL,
    token_hash      TEXT NOT NULL,                    -- sha256 do token Bearer da linha
    webhook_url     TEXT,
    webhook_secret  TEXT,                             -- usado no X-Hub-Signature-256
    status          TEXT NOT NULL DEFAULT 'new',      -- new | qr | connecting | open | closed | logged_out
    phone           TEXT,                             -- número conectado (só dígitos)
    push_name       TEXT,
    pairing_phone   TEXT,                             -- se preenchido, usa código de pareamento em vez de QR
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credenciais e chaves Signal do Baileys (substitui a pasta auth_info).
CREATE TABLE IF NOT EXISTS wa_auth (
    session_id  TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    PRIMARY KEY (session_id, key)
);

-- Mensagens recentes (entrada e saída). Servem para: baixar mídia sob demanda,
-- reenvio quando o destinatário pede (getMessage) e consulta.
CREATE TABLE IF NOT EXISTS wa_messages (
    session_id  TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    jid         TEXT NOT NULL,
    from_me     BOOLEAN NOT NULL,
    type        TEXT,
    raw         TEXT NOT NULL,                        -- WebMessageInfo serializado (BufferJSON)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS wa_messages_created_idx ON wa_messages (created_at);

-- Fila de webhooks com nova tentativa (backoff exponencial).
CREATE TABLE IF NOT EXISTS wa_webhook_queue (
    id               BIGSERIAL PRIMARY KEY,
    session_id       TEXT NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
    payload          JSONB NOT NULL,
    attempts         INT NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error       TEXT,
    dead             BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wa_webhook_queue_due_idx ON wa_webhook_queue (next_attempt_at) WHERE dead = false;

-- Templates locais (o WhatsApp não oficial não tem templates aprovados;
-- aqui eles são só textos com {{1}}, {{2}}... para manter a compatibilidade com a Cloud API).
CREATE TABLE IF NOT EXISTS wa_templates (
    name        TEXT NOT NULL,
    language    TEXT NOT NULL DEFAULT 'pt_BR',
    header      TEXT,
    body        TEXT NOT NULL,
    footer      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (name, language)
);
