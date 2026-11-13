import pino from 'pino';
import { config } from './config.js';

export const logger = pino({ level: config.logLevel });

// O Baileys é muito verboso; usamos um logger filho em nível mais alto
export const baileysLogger = logger.child({ mod: 'baileys' });
baileysLogger.level = config.logLevel === 'debug' ? 'debug' : 'warn';
