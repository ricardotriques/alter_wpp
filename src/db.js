import pg from 'pg';
import { config } from './config.js';

// Pool pequeno: o plano Free tem pouca RAM e poucas conexões
export const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 4,
    idleTimeoutMillis: 30_000,
});

export const q = (text, params) => pool.query(text, params);
