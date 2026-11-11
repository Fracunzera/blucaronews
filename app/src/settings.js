// Configuración leída de variables de entorno (ver .env.example).
import path from 'node:path';

const env = process.env;

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const settings = {
  dataDir: env.DATA_DIR || path.resolve('data'),
  seedDir: env.SEED_DIR || path.resolve(import.meta.dirname, '../config-seed'),
  publicDir: path.resolve(import.meta.dirname, '../public'),
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  domain: env.DOMAIN || 'localhost',
  contactEmail: env.CONTACT_EMAIL || 'contacto@example.com',
  siteName: env.SITE_NAME || 'Blucaro News',
  adminUser: env.ADMIN_USER || 'admin',
  adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
  // En producción va detrás de HTTPS (Caddy); para pruebas locales por http poner COOKIE_SECURE=false.
  cookieSecure: env.COOKIE_SECURE !== 'false',
  ytApiKey: env.YT_API_KEY || '',
  rssIntervalSec: Math.max(60, Math.min(120, num(env.RSS_INTERVAL_SEC, 90))),
  newsMaxAgeHours: 48,
  weather: {
    name: env.WEATHER_NAME || 'Río Gallegos',
    lat: Number(env.WEATHER_LAT || -51.6226),
    lon: Number(env.WEATHER_LON || -69.2181),
    tz: env.WEATHER_TZ || 'America/Argentina/Rio_Gallegos',
  },
  userAgent: `${env.SITE_NAME || 'BlucaroNews'}/1.0 (+https://${env.DOMAIN || 'localhost'}/terminos)`,
};
