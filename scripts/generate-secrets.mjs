import { randomBytes } from 'node:crypto';
console.log('ADMIN_TOKEN=' + randomBytes(32).toString('hex'));
console.log('SESSION_ENCRYPTION_KEY=' + randomBytes(32).toString('hex'));
