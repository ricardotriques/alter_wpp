import { createHmac } from 'node:crypto';
import { q } from './db.js';
import { logger } from './logger.js';

const MAX_ATTEMPTS = 10;
const log = logger.child({ mod: 'webhook' });

/** Monta o envelope no mesmo formato da Cloud API */
export function envelope(session, field, value) {
    return {
        object: 'whatsapp_business_account',
        entry: [
            {
                id: session.id,
                changes: [
                    {
                        field,
                        value: {
                            messaging_product: 'whatsapp',
                            metadata: { display_phone_number: session.phone || '', phone_number_id: session.id },
                            ...value,
                        },
                    },
                ],
            },
        ],
    };
}

export async function enqueue(sessionId, payload) {
    await q('INSERT INTO wa_webhook_queue (session_id, payload) VALUES ($1, $2)', [sessionId, payload]);
    kick();
}

export const sign = (secret, body) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

let running = false;
let timer = null;

/** Dispara um ciclo logo (sem esperar o intervalo) */
function kick() {
    if (!running) setImmediate(tick);
}

async function tick() {
    if (running) return;
    running = true;
    try {
        const { rows } = await q(
            `SELECT w.id, w.payload, w.attempts, s.webhook_url, s.webhook_secret
               FROM wa_webhook_queue w JOIN wa_sessions s ON s.id = w.session_id
              WHERE w.dead = false AND w.next_attempt_at <= now()
              ORDER BY w.id LIMIT 20`,
        );
        for (const row of rows) {
            if (!row.webhook_url) {
                await q('DELETE FROM wa_webhook_queue WHERE id = $1', [row.id]);
                continue;
            }
            const body = JSON.stringify(row.payload);
            try {
                const headers = { 'Content-Type': 'application/json', 'User-Agent': 'wa-engine/0.1' };
                if (row.webhook_secret) headers['X-Hub-Signature-256'] = sign(row.webhook_secret, body);
                const res = await fetch(row.webhook_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                await q('DELETE FROM wa_webhook_queue WHERE id = $1', [row.id]);
            } catch (err) {
                const attempts = row.attempts + 1;
                const delaySec = Math.min(10 * 2 ** row.attempts, 3600);
                await q(
                    `UPDATE wa_webhook_queue
                        SET attempts = $2, last_error = $3, dead = $4,
                            next_attempt_at = now() + ($5 || ' seconds')::interval
                      WHERE id = $1`,
                    [row.id, attempts, String(err.message).slice(0, 500), attempts >= MAX_ATTEMPTS, String(delaySec)],
                );
                log.warn({ id: row.id, attempts, err: err.message }, 'falha ao entregar webhook');
            }
        }
    } catch (err) {
        log.error({ err: err.message }, 'erro no ciclo de webhooks');
    } finally {
        running = false;
    }
}

export function startWebhookWorker() {
    timer = setInterval(tick, 3000);
    timer.unref();
}

export function stopWebhookWorker() {
    if (timer) clearInterval(timer);
}
