const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

let S3Client;
let GetObjectCommand;
let PutObjectCommand;
let HeadBucketCommand;
let mysql;

try {
  ({ S3Client, GetObjectCommand, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3'));
} catch (_) {
  // Optional dependency: only needed when CONFIG_BACKEND=s3.
}

try {
  mysql = require('mysql2/promise');
} catch (_) {
  // Optional dependency: only needed when CONFIG_BACKEND=mysql.
}

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  accounts: [],
  adminPassword: null
});

function cloneDefaultConfig() {
  return {
    version: 1,
    accounts: [],
    adminPassword: null
  };
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object') {
    return cloneDefaultConfig();
  }

  const accounts = Array.isArray(value.accounts) ? value.accounts : [];
  const adminPassword = typeof value.adminPassword === 'string' && value.adminPassword.length > 0
    ? value.adminPassword
    : null;

  return {
    version: Number.isInteger(value.version) ? value.version : 1,
    accounts,
    adminPassword
  };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function streamToString(stream) {
  if (!stream) {
    return '';
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class FileStore {
  constructor(filePath) {
    this.backend = 'file';
    this.filePath = filePath;
  }

  async load() {
    try {
      const raw = await fsPromises.readFile(this.filePath, 'utf8');
      return normalizeConfig(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new Error(`读取文件配置失败: ${error.message}`);
    }
  }

  async save(config) {
    const normalized = normalizeConfig(config);
    const dir = path.dirname(this.filePath);
    await fsPromises.mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    await fsPromises.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await fsPromises.rename(tmpPath, this.filePath);
  }

  async status() {
    const exists = fs.existsSync(this.filePath);
    return {
      backend: this.backend,
      ok: true,
      detail: exists ? '配置文件可读写' : '配置文件尚未创建'
    };
  }
}

class WebDavStore {
  constructor(options) {
    this.backend = 'webdav';
    this.url = options.url;
    this.timeoutMs = options.timeoutMs;
    this.authorization = options.username
      ? `Basic ${Buffer.from(`${options.username}:${options.password || ''}`).toString('base64')}`
      : null;
  }

  async request(method, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.authorization) {
      headers.Authorization = this.authorization;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(this.url, {
        method,
        headers,
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async load() {
    const response = await this.request('GET');
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`WebDAV GET 失败 (${response.status})`);
    }
    const raw = await response.text();
    if (!raw.trim()) {
      return cloneDefaultConfig();
    }
    return normalizeConfig(JSON.parse(raw));
  }

  async save(config) {
    const normalized = normalizeConfig(config);
    const response = await this.request('PUT', JSON.stringify(normalized, null, 2), {
      'Content-Type': 'application/json'
    });
    if (!response.ok) {
      throw new Error(`WebDAV PUT 失败 (${response.status})`);
    }
  }

  async status() {
    try {
      const response = await this.request('GET');
      const ok = response.ok || response.status === 404;
      return {
        backend: this.backend,
        ok,
        detail: ok ? 'WebDAV 可访问' : `WebDAV 返回状态 ${response.status}`
      };
    } catch (error) {
      return {
        backend: this.backend,
        ok: false,
        detail: `WebDAV 检查失败: ${error.message}`
      };
    }
  }
}

class S3Store {
  constructor(options) {
    if (!S3Client || !GetObjectCommand || !PutObjectCommand || !HeadBucketCommand) {
      throw new Error('S3 依赖缺失，请执行 npm install 安装依赖');
    }

    this.backend = 's3';
    this.bucket = options.bucket;
    this.key = options.key;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint || undefined,
      forcePathStyle: options.forcePathStyle,
      credentials: options.accessKeyId && options.secretAccessKey
        ? {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey
          }
        : undefined
    });
  }

  async load() {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key
      }));
      const raw = await streamToString(response.Body);
      if (!raw.trim()) {
        return cloneDefaultConfig();
      }
      return normalizeConfig(JSON.parse(raw));
    } catch (error) {
      const code = error?.name || error?.Code || '';
      if (code === 'NoSuchKey' || code === 'NotFound') {
        return null;
      }
      throw new Error(`S3 读取失败: ${error.message}`);
    }
  }

  async save(config) {
    const normalized = normalizeConfig(config);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Body: JSON.stringify(normalized, null, 2),
      ContentType: 'application/json'
    }));
  }

  async status() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return {
        backend: this.backend,
        ok: true,
        detail: 'S3 Bucket 可访问'
      };
    } catch (error) {
      return {
        backend: this.backend,
        ok: false,
        detail: `S3 检查失败: ${error.message}`
      };
    }
  }
}

class MysqlStore {
  constructor(options) {
    if (!mysql) {
      throw new Error('MySQL 依赖缺失，请执行 npm install 安装依赖');
    }
    this.backend = 'mysql';
    this.table = options.table;
    this.pool = options.url
      ? mysql.createPool(options.url)
      : mysql.createPool({
          host: options.host,
          port: options.port,
          user: options.user,
          password: options.password,
          database: options.database,
          charset: 'utf8mb4',
          connectionLimit: options.connectionLimit
        });
    this.initPromise = null;
  }

  async ensureInit() {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    return this.initPromise;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS \`${this.table}\` (
        \`k\` VARCHAR(64) NOT NULL PRIMARY KEY,
        \`v\` LONGTEXT NOT NULL,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }

  async load() {
    await this.ensureInit();
    const [rows] = await this.pool.query(
      `SELECT \`v\` FROM \`${this.table}\` WHERE \`k\` = ? LIMIT 1`,
      ['main']
    );
    if (!rows.length) {
      return null;
    }
    return normalizeConfig(JSON.parse(rows[0].v));
  }

  async save(config) {
    await this.ensureInit();
    const normalized = normalizeConfig(config);
    const payload = JSON.stringify(normalized);
    await this.pool.query(
      `INSERT INTO \`${this.table}\` (\`k\`, \`v\`) VALUES (?, ?) ON DUPLICATE KEY UPDATE \`v\` = VALUES(\`v\`)`,
      ['main', payload]
    );
  }

  async status() {
    try {
      await this.ensureInit();
      await this.pool.query('SELECT 1');
      return {
        backend: this.backend,
        ok: true,
        detail: 'MySQL 可访问'
      };
    } catch (error) {
      return {
        backend: this.backend,
        ok: false,
        detail: `MySQL 检查失败: ${error.message}`
      };
    }
  }
}

function createConfigStoreFromEnv(env = process.env) {
  const backend = (env.CONFIG_BACKEND || 'file').trim().toLowerCase();

  if (backend === 'webdav') {
    if (!env.WEBDAV_URL) {
      throw new Error('CONFIG_BACKEND=webdav 时必须设置 WEBDAV_URL');
    }
    return new WebDavStore({
      url: env.WEBDAV_URL,
      username: env.WEBDAV_USERNAME,
      password: env.WEBDAV_PASSWORD,
      timeoutMs: parseInteger(env.WEBDAV_TIMEOUT_MS, 10000)
    });
  }

  if (backend === 's3') {
    if (!env.S3_BUCKET) {
      throw new Error('CONFIG_BACKEND=s3 时必须设置 S3_BUCKET');
    }
    return new S3Store({
      bucket: env.S3_BUCKET,
      key: env.S3_KEY || 'zmon/config.json',
      region: env.S3_REGION || 'auto',
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: parseBoolean(env.S3_FORCE_PATH_STYLE, false)
    });
  }

  if (backend === 'mysql') {
    const table = env.MYSQL_TABLE || 'zmon_config';
    if (!/^[a-zA-Z0-9_]+$/.test(table)) {
      throw new Error('MYSQL_TABLE 仅允许字母、数字和下划线');
    }
    return new MysqlStore({
      url: env.MYSQL_URL,
      host: env.MYSQL_HOST,
      port: parseInteger(env.MYSQL_PORT, 3306),
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE,
      connectionLimit: parseInteger(env.MYSQL_CONNECTION_LIMIT, 5),
      table
    });
  }

  const configPath = env.CONFIG_FILE_PATH
    ? path.resolve(env.CONFIG_FILE_PATH)
    : path.join(__dirname, 'config.json');
  return new FileStore(configPath);
}

module.exports = {
  DEFAULT_CONFIG,
  createConfigStoreFromEnv,
  normalizeConfig
};
