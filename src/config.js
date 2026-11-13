import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Carregador mínimo de .env (sem dependência extra)
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!m || line.trim().startsWith('#')) continue;
        if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const bool = (v, d) => (v === undefined ? d : ['1', 'true', 'yes', 'sim'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
    databaseUrl: process.env.DATABASE_URL,
    // Em site Node.js do alwaysdata, a plataforma define IP e PORT; em Service, use HOST/PORT do .env
    host: process.env.IP || process.env.ALWAYSDATA_HTTPD_IP || process.env.HOST || '::',
    port: int(process.env.PORT || process.env.ALWAYSDATA_HTTPD_PORT, 8300),
    masterKey: process.env.MASTER_KEY,
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
    sendMinDelay: int(process.env.SEND_MIN_DELAY_MS, 1500),
    sendMaxDelay: int(process.env.SEND_MAX_DELAY_MS, 4000),
    simulateTyping: bool(process.env.SIMULATE_TYPING, true),
    retentionDays: int(process.env.MESSAGE_RETENTION_DAYS, 7),
    ignoreGroups: bool(process.env.IGNORE_GROUPS, true),
    logLevel: process.env.LOG_LEVEL || 'info',
};

if (!config.databaseUrl) throw new Error('DATABASE_URL não definido');
if (!config.masterKey || config.masterKey.length < 24) throw new Error('MASTER_KEY ausente ou curta (mín. 24 caracteres)');
