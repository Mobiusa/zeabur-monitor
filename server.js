require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encryptData, decryptData } = require('./crypto-utils');
const { createConfigStoreFromEnv, DEFAULT_CONFIG, normalizeConfig } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

// 加密密钥（用于加密存储的 API Token）
const ACCOUNTS_SECRET = process.env.ACCOUNTS_SECRET;
const ENCRYPTION_ENABLED = ACCOUNTS_SECRET && ACCOUNTS_SECRET.length === 64;
const CONFIG_CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS || 5000);
const GRAPHQL_TIMEOUT_MS = Number(process.env.GRAPHQL_TIMEOUT_MS || 10000);
const GRAPHQL_RETRY_MAX = Number(process.env.GRAPHQL_RETRY_MAX || 2);
const ACCOUNT_FETCH_CONCURRENCY = Number(process.env.ACCOUNT_FETCH_CONCURRENCY || 4);
const LEGACY_ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const LEGACY_PASSWORD_FILE = path.join(__dirname, 'password.json');
const ZEABUR_KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Session管理 - 存储在内存中,重启服务器后清空
const activeSessions = new Map(); // { token: { createdAt: timestamp } }
const SESSION_DURATION = 10 * 24 * 60 * 60 * 1000; // 10天
const configStore = createConfigStoreFromEnv();
let configCache = {
  value: normalizeConfig(DEFAULT_CONFIG),
  loadedAt: 0
};

// 生成随机token
function generateToken() {
  return 'session_' + crypto.randomBytes(24).toString('hex');
}

// 清理过期session
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of activeSessions.entries()) {
    if (now - session.createdAt > SESSION_DURATION) {
      activeSessions.delete(token);
    }
  }
}

// 每小时清理一次过期session
setInterval(cleanExpiredSessions, 60 * 60 * 1000).unref();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJsonSafe(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function decodeStoredAccounts(accounts) {
  if (!Array.isArray(accounts)) {
    return [];
  }

  return accounts.map(account => {
    if (!account || typeof account !== 'object') {
      return null;
    }

    if (ENCRYPTION_ENABLED && account.encryptedToken && !account.token) {
      try {
        const token = decryptData(account.encryptedToken, ACCOUNTS_SECRET);
        return { ...account, token, encryptedToken: undefined };
      } catch (error) {
        console.error(`❌ 解密账号 [${account.name || '未知'}] Token 失败:`, error.message);
        return account;
      }
    }

    return account;
  }).filter(Boolean);
}

function encodeAccountsForStorage(accounts) {
  if (!Array.isArray(accounts)) {
    return [];
  }

  if (!ENCRYPTION_ENABLED) {
    return accounts.map(account => ({ ...account }));
  }

  const encrypted = accounts.map(account => {
    if (account && account.token) {
      try {
        const encryptedToken = encryptData(account.token, ACCOUNTS_SECRET);
        const { token, ...rest } = account;
        return { ...rest, encryptedToken };
      } catch (error) {
        console.error(`❌ 加密账号 [${account.name || '未知'}] Token 失败:`, error.message);
        return account;
      }
    }
    return account;
  });
  console.log('🔐 账号 Token 已加密存储');
  return encrypted;
}

function readLegacyAccounts() {
  try {
    if (!fs.existsSync(LEGACY_ACCOUNTS_FILE)) {
      return [];
    }
    const data = fs.readFileSync(LEGACY_ACCOUNTS_FILE, 'utf8');
    const accounts = parseJsonSafe(data, []);
    return decodeStoredAccounts(accounts);
  } catch (error) {
    console.error('❌ 读取旧版账号文件失败:', error.message);
    return [];
  }
}

function readLegacyPassword() {
  try {
    if (!fs.existsSync(LEGACY_PASSWORD_FILE)) {
      return null;
    }
    const data = fs.readFileSync(LEGACY_PASSWORD_FILE, 'utf8');
    const parsed = parseJsonSafe(data, {});
    return typeof parsed.password === 'string' && parsed.password.length > 0 ? parsed.password : null;
  } catch (error) {
    console.error('❌ 读取旧版密码文件失败:', error.message);
    return null;
  }
}

function updateConfigCache(config) {
  configCache = {
    value: normalizeConfig(config),
    loadedAt: Date.now()
  };
}

async function loadRuntimeConfig(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && now - configCache.loadedAt < CONFIG_CACHE_TTL_MS) {
    return configCache.value;
  }

  const loaded = await configStore.load();
  const normalized = normalizeConfig(loaded || DEFAULT_CONFIG);
  updateConfigCache(normalized);
  return normalized;
}

async function saveRuntimeConfig(config) {
  const normalized = normalizeConfig(config);
  await configStore.save(normalized);
  updateConfigCache(normalized);
}

async function bootstrapConfig() {
  let existing;
  try {
    existing = await configStore.load();
  } catch (error) {
    throw new Error(`初始化配置失败: ${error.message}`);
  }

  if (existing) {
    updateConfigCache(existing);
    return;
  }

  const legacyAccounts = readLegacyAccounts();
  const legacyPassword = readLegacyPassword();
  const initial = normalizeConfig({
    ...DEFAULT_CONFIG,
    accounts: encodeAccountsForStorage(legacyAccounts),
    adminPassword: legacyPassword
  });

  await saveRuntimeConfig(initial);
  if (legacyAccounts.length > 0 || legacyPassword) {
    console.log('♻️ 已完成旧版配置迁移到新存储后端');
  }
}

async function loadServerAccounts() {
  const config = await loadRuntimeConfig();
  return decodeStoredAccounts(config.accounts);
}

async function saveServerAccounts(accounts) {
  const config = await loadRuntimeConfig();
  config.accounts = encodeAccountsForStorage(accounts);
  await saveRuntimeConfig(config);
  return true;
}

async function loadAdminPassword() {
  const config = await loadRuntimeConfig();
  return config.adminPassword || null;
}

async function saveAdminPassword(password) {
  const config = await loadRuntimeConfig();
  config.adminPassword = password;
  await saveRuntimeConfig(config);
  return true;
}

// 密码验证中间件
async function requireAuth(req, res, next) {
  try {
    const password = req.headers['x-admin-password'];
    const sessionToken = req.headers['x-session-token'];
    const savedPassword = await loadAdminPassword();

    if (!savedPassword) {
      next();
      return;
    }

    if (sessionToken && activeSessions.has(sessionToken)) {
      const session = activeSessions.get(sessionToken);
      if (Date.now() - session.createdAt < SESSION_DURATION) {
        next();
        return;
      }
      activeSessions.delete(sessionToken);
      res.status(401).json({ error: 'Session已过期，请重新登录' });
      return;
    }

    if (password === savedPassword) {
      next();
      return;
    }

    res.status(401).json({ error: '密码错误或Session无效' });
  } catch (error) {
    next(error);
  }
}

app.use(express.static('public'));

function isRetryableError(error) {
  if (!error || !error.message) {
    return false;
  }
  const message = error.message.toLowerCase();
  return [
    'timeout',
    'socket hang up',
    'econnreset',
    'enotfound',
    'eai_again',
    'etimedout',
    'econnrefused',
    'zeabur api 429',
    'bad gateway',
    'service unavailable',
    'gateway timeout'
  ].some(keyword => message.includes(keyword));
}

async function requestZeaburGraphQL(token, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.zeabur.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: GRAPHQL_TIMEOUT_MS,
      agent: ZEABUR_KEEP_ALIVE_AGENT
    };

    const req = https.request(options, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode >= 500) {
          reject(new Error(`Zeabur API ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.write(data);
    req.end();
  });
}

async function requestZeaburWithRetry(token, payload) {
  let lastError;
  for (let attempt = 0; attempt <= GRAPHQL_RETRY_MAX; attempt += 1) {
    try {
      return await requestZeaburGraphQL(token, payload);
    } catch (error) {
      lastError = error;
      if (attempt >= GRAPHQL_RETRY_MAX || !isRetryableError(error)) {
        throw error;
      }
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError || new Error('Zeabur 请求失败');
}

async function queryZeabur(token, query) {
  return requestZeaburWithRetry(token, { query });
}

// 获取用户信息和项目
async function fetchAccountData(token) {
  // 查询用户信息
  const userQuery = `
    query {
      me {
        _id
        username
        email
        credit
      }
    }
  `;
  
  // 查询项目信息
  const projectsQuery = `
    query {
      projects {
        edges {
          node {
            _id
            name
            region {
              name
            }
            environments {
              _id
            }
            services {
              _id
              name
              status
              template
              resourceLimit {
                cpu
                memory
              }
              domains {
                domain
                isGenerated
              }
            }
          }
        }
      }
    }
  `;
  
  // 查询 AI Hub 余额
  const aihubQuery = `
    query GetAIHubTenant {
      aihubTenant {
        balance
        keys {
          keyID
          alias
          cost
        }
      }
    }
  `;
  
  const [userData, projectsData, aihubData] = await Promise.all([
    queryZeabur(token, userQuery),
    queryZeabur(token, projectsQuery),
    queryZeabur(token, aihubQuery).catch(() => ({ data: { aihubTenant: null } }))
  ]);
  
  return {
    user: userData.data?.me || {},
    projects: (projectsData.data?.projects?.edges || []).map(edge => edge.node),
    aihub: aihubData.data?.aihubTenant || null
  };
}

// 获取项目用量数据
async function fetchUsageData(token, userID, projects = []) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // 使用明天的日期确保包含今天的所有数据
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const toDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  
  const usageQuery = {
    operationName: 'GetHeaderMonthlyUsage',
    variables: {
      from: fromDate,
      to: toDate,
      groupByEntity: 'PROJECT',
      groupByTime: 'DAY',
      groupByType: 'ALL',
      userID: userID
    },
    query: `query GetHeaderMonthlyUsage($from: String!, $to: String!, $groupByEntity: GroupByEntity, $groupByTime: GroupByTime, $groupByType: GroupByType, $userID: ObjectID!) {
      usages(
        from: $from
        to: $to
        groupByEntity: $groupByEntity
        groupByTime: $groupByTime
        groupByType: $groupByType
        userID: $userID
      ) {
        categories
        data {
          id
          name
          groupByEntity
          usageOfEntity
          __typename
        }
        __typename
      }
    }`
  };
  
  const result = await requestZeaburWithRetry(token, usageQuery);
  const usages = result.data?.usages?.data || [];

  const projectCosts = {};
  let totalUsage = 0;

  usages.forEach(project => {
    const projectTotal = project.usageOfEntity.reduce((a, b) => a + b, 0);
    const displayCost = projectTotal > 0 ? Math.ceil(projectTotal * 100) / 100 : 0;
    projectCosts[project.id] = displayCost;
    totalUsage += projectTotal;
  });

  return {
    projectCosts,
    totalUsage,
    freeQuotaRemaining: 5 - totalUsage,
    freeQuotaLimit: 5
  };
}

async function mapWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const maxWorkers = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: maxWorkers }, runWorker));
  return results;
}

// 临时账号API - 获取账号信息
app.post('/api/temp-accounts', requireAuth, async (req, res) => {
  const { accounts } = req.body;
  
  console.log('📥 收到账号请求:', accounts?.length, '个账号');
  
  if (!accounts || !Array.isArray(accounts)) {
    return res.status(400).json({ error: '无效的账号列表' });
  }
  
  const results = await mapWithConcurrency(accounts, ACCOUNT_FETCH_CONCURRENCY, async (account) => {
    try {
      console.log(`🔍 正在获取账号 [${account.name}] 的数据...`);
      const { user, projects, aihub } = await fetchAccountData(account.token);
      console.log(`   API 返回的 credit: ${user.credit}`);
      
      // 获取用量数据
      let usageData = { totalUsage: 0, freeQuotaRemaining: 5, freeQuotaLimit: 5 };
      if (user._id) {
        try {
          usageData = await fetchUsageData(account.token, user._id, projects);
          console.log(`💰 [${account.name}] 用量: $${usageData.totalUsage.toFixed(2)}, 剩余: $${usageData.freeQuotaRemaining.toFixed(2)}`);
        } catch (e) {
          console.log(`⚠️ [${account.name}] 获取用量失败:`, e.message);
        }
      }
      
      // 计算剩余额度并转换为 credit（以分为单位）
      const creditInCents = Math.round(usageData.freeQuotaRemaining * 100);
      
      return {
        name: account.name,
        success: true,
        data: {
          ...user,
          credit: creditInCents, // 使用计算的剩余额度
          totalUsage: usageData.totalUsage,
          freeQuotaLimit: usageData.freeQuotaLimit
        },
        aihub: aihub
      };
    } catch (error) {
      console.error(`❌ [${account.name}] 错误:`, error.message);
      return {
        name: account.name,
        success: false,
        error: error.message
      };
    }
  });
  
  console.log('📤 返回结果:', results.length, '个账号');
  res.json(results);
});

// 临时账号API - 获取项目信息
app.post('/api/temp-projects', requireAuth, express.json(), async (req, res) => {
  const { accounts } = req.body;
  
  console.log('📥 收到项目请求:', accounts?.length, '个账号');
  
  if (!accounts || !Array.isArray(accounts)) {
    return res.status(400).json({ error: '无效的账号列表' });
  }
  
  const results = await mapWithConcurrency(accounts, ACCOUNT_FETCH_CONCURRENCY, async (account) => {
    try {
      console.log(`🔍 正在获取账号 [${account.name}] 的项目...`);
      const { user, projects } = await fetchAccountData(account.token);
      
      // 获取用量数据
      let projectCosts = {};
      if (user._id) {
        try {
          const usageData = await fetchUsageData(account.token, user._id, projects);
          projectCosts = usageData.projectCosts;
        } catch (e) {
          console.log(`⚠️ [${account.name}] 获取用量失败:`, e.message);
        }
      }
      
      console.log(`📦 [${account.name}] 找到 ${projects.length} 个项目`);
      
      const projectsWithCost = projects.map(project => {
        const cost = projectCosts[project._id] || 0;
        console.log(`  - ${project.name}: $${cost.toFixed(2)}`);
        
        return {
          _id: project._id,
          name: project.name,
          region: project.region?.name || 'Unknown',
          environments: project.environments || [],
          services: project.services || [],
          cost: cost,
          hasCostData: cost > 0
        };
      });
      
      return {
        name: account.name,
        success: true,
        projects: projectsWithCost
      };
    } catch (error) {
      console.error(`❌ [${account.name}] 错误:`, error.message);
      return {
        name: account.name,
        success: false,
        error: error.message
      };
    }
  });
  
  console.log('📤 返回项目结果');
  res.json(results);
});

// 验证账号
app.post('/api/validate-account', requireAuth, express.json(), async (req, res) => {
  const { accountName, apiToken } = req.body;
  
  if (!accountName || !apiToken) {
    return res.status(400).json({ error: '账号名称和 API Token 不能为空' });
  }
  
  try {
    const { user } = await fetchAccountData(apiToken);
    
    if (user._id) {
      res.json({
        success: true,
        message: '账号验证成功！',
        userData: user,
        accountName,
        apiToken
      });
    } else {
      res.status(400).json({ error: 'API Token 无效或没有权限' });
    }
  } catch (error) {
    res.status(400).json({ error: 'API Token 验证失败: ' + error.message });
  }
});

// 从环境变量读取预配置的账号
function getEnvAccounts() {
  const accountsEnv = process.env.ACCOUNTS;
  if (!accountsEnv) return [];
  
  try {
    // 格式: "账号1名称:token1,账号2名称:token2"
    return accountsEnv.split(',').map(item => {
      const [name, token] = item.split(':');
      return { name: name.trim(), token: token.trim() };
    }).filter(acc => acc.name && acc.token);
  } catch (e) {
    console.error('❌ 解析环境变量 ACCOUNTS 失败:', e.message);
    return [];
  }
}

// 检查是否已设置密码
// 检查加密密钥是否已设置
app.get('/api/check-encryption', (req, res) => {
  // 生成一个随机密钥供用户使用
  const suggestedSecret = crypto.randomBytes(32).toString('hex');
  
  res.json({
    isConfigured: ENCRYPTION_ENABLED,
    suggestedSecret: suggestedSecret
  });
});

app.get('/api/check-password', async (req, res, next) => {
  try {
    const savedPassword = await loadAdminPassword();
    res.json({ hasPassword: !!savedPassword });
  } catch (error) {
    next(error);
  }
});

app.get('/api/storage/status', requireAuth, async (req, res, next) => {
  try {
    const status = await configStore.status();
    res.json({
      ...status,
      backendConfigured: (process.env.CONFIG_BACKEND || 'file').toLowerCase()
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const storage = await configStore.status();
    res.json({
      ok: storage.ok,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      storage,
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// 设置管理员密码（首次）
app.post('/api/set-password', async (req, res, next) => {
  try {
    const { password } = req.body;
    const savedPassword = await loadAdminPassword();

    if (savedPassword) {
      return res.status(400).json({ error: '密码已设置，无法重复设置' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: '密码长度至少6位' });
    }

    await saveAdminPassword(password);
    console.log('✅ 管理员密码已设置');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// 验证密码
app.post('/api/verify-password', async (req, res, next) => {
  try {
    const { password } = req.body;
    const savedPassword = await loadAdminPassword();

    if (!savedPassword) {
      return res.status(400).json({ success: false, error: '请先设置密码' });
    }

    if (password === savedPassword) {
      const sessionToken = generateToken();
      activeSessions.set(sessionToken, { createdAt: Date.now() });
      console.log(`✅ 用户登录成功，生成Session: ${sessionToken.substring(0, 20)}...`);
      res.json({ success: true, sessionToken });
    } else {
      res.status(401).json({ success: false, error: '密码错误' });
    }
  } catch (error) {
    next(error);
  }
});

// 获取所有账号（服务器存储 + 环境变量）
app.get('/api/server-accounts', requireAuth, async (req, res, next) => {
  try {
    const serverAccounts = await loadServerAccounts();
    const envAccounts = getEnvAccounts();

    const allAccounts = [...envAccounts, ...serverAccounts];
    console.log(`📋 返回 ${allAccounts.length} 个账号 (环境变量: ${envAccounts.length}, 服务器: ${serverAccounts.length})`);
    res.json(allAccounts);
  } catch (error) {
    next(error);
  }
});

// 保存账号到服务器
app.post('/api/server-accounts', requireAuth, async (req, res, next) => {
  try {
    const { accounts } = req.body;

    if (!accounts || !Array.isArray(accounts)) {
      return res.status(400).json({ error: '无效的账号列表' });
    }

    await saveServerAccounts(accounts);
    console.log(`✅ 保存 ${accounts.length} 个账号到服务器`);
    res.json({ success: true, message: '账号已保存到服务器' });
  } catch (error) {
    next(error);
  }
});

// 删除服务器账号
app.delete('/api/server-accounts/:index', requireAuth, async (req, res, next) => {
  try {
    const index = Number.parseInt(req.params.index, 10);
    const accounts = await loadServerAccounts();

    if (index >= 0 && index < accounts.length) {
      const removed = accounts.splice(index, 1);
      await saveServerAccounts(accounts);
      console.log(`🗑️ 删除账号: ${removed[0].name}`);
      res.json({ success: true, message: '账号已删除' });
    } else {
      res.status(404).json({ error: '账号不存在' });
    }
  } catch (error) {
    next(error);
  }
});

// 服务器配置的账号API（兼容旧版本，用于 session 校验）
app.get('/api/accounts', requireAuth, async (req, res) => {
  res.json([]);
});

app.get('/api/projects', requireAuth, async (req, res) => {
  res.json([]);
});

// 暂停服务
app.post('/api/service/pause', requireAuth, async (req, res) => {
  const { token, serviceId, environmentId } = req.body;
  
  if (!token || !serviceId || !environmentId) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  
  try {
    const mutation = `mutation { suspendService(serviceID: "${serviceId}", environmentID: "${environmentId}") }`;
    const result = await queryZeabur(token, mutation);
    
    if (result.data?.suspendService) {
      res.json({ success: true, message: '服务已暂停' });
    } else {
      res.status(400).json({ error: '暂停失败', details: result });
    }
  } catch (error) {
    res.status(500).json({ error: '暂停服务失败: ' + error.message });
  }
});

// 重启服务
app.post('/api/service/restart', requireAuth, async (req, res) => {
  const { token, serviceId, environmentId } = req.body;
  
  if (!token || !serviceId || !environmentId) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  
  try {
    const mutation = `mutation { restartService(serviceID: "${serviceId}", environmentID: "${environmentId}") }`;
    const result = await queryZeabur(token, mutation);
    
    if (result.data?.restartService) {
      res.json({ success: true, message: '服务已重启' });
    } else {
      res.status(400).json({ error: '重启失败', details: result });
    }
  } catch (error) {
    res.status(500).json({ error: '重启服务失败: ' + error.message });
  }
});

// 获取服务日志
app.post('/api/service/logs', requireAuth, express.json(), async (req, res) => {
  const { token, serviceId, environmentId, projectId, limit = 200 } = req.body;
  
  if (!token || !serviceId || !environmentId || !projectId) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  
  try {
    const query = `
      query {
        runtimeLogs(
          projectID: "${projectId}"
          serviceID: "${serviceId}"
          environmentID: "${environmentId}"
        ) {
          message
          timestamp
        }
      }
    `;
    
    const result = await queryZeabur(token, query);
    
    if (result.data?.runtimeLogs) {
      // 按时间戳排序，最新的在最后
      const sortedLogs = result.data.runtimeLogs.sort((a, b) => {
        return new Date(a.timestamp) - new Date(b.timestamp);
      });
      
      // 获取最后 N 条日志
      const logs = sortedLogs.slice(-limit);
      
      res.json({ 
        success: true, 
        logs,
        count: logs.length,
        totalCount: result.data.runtimeLogs.length
      });
    } else {
      res.status(400).json({ error: '获取日志失败', details: result });
    }
  } catch (error) {
    res.status(500).json({ error: '获取日志失败: ' + error.message });
  }
});

// 重命名项目
app.post('/api/project/rename', requireAuth, async (req, res) => {
  const { accountId, projectId, newName } = req.body;
  
  console.log(`📝 收到重命名请求: accountId=${accountId}, projectId=${projectId}, newName=${newName}`);
  
  if (!accountId || !projectId || !newName) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  
  try {
    const allAccounts = [...getEnvAccounts(), ...(await loadServerAccounts())];
    const account = allAccounts.find(acc => (acc.id || acc.name) === accountId);
    
    if (!account || !account.token) {
      return res.status(404).json({ error: '未找到账号或token' });
    }
    
    const mutation = `mutation { renameProject(_id: "${projectId}", name: "${newName}") }`;
    console.log(`🔍 发送 GraphQL mutation:`, mutation);
    
    const result = await queryZeabur(account.token, mutation);
    console.log(`📥 API 响应:`, JSON.stringify(result, null, 2));
    
    if (result.data?.renameProject) {
      console.log(`✅ 项目已重命名: ${newName}`);
      res.json({ success: true, message: '项目已重命名' });
    } else {
      console.log(`❌ 重命名失败:`, result);
      res.status(400).json({ error: '重命名失败', details: result });
    }
  } catch (error) {
    console.log(`❌ 异常:`, error);
    res.status(500).json({ error: '重命名项目失败: ' + error.message });
  }
});

// 获取当前版本
app.get('/api/version', (req, res) => {
  const packageJson = require('./package.json');
  res.json({ version: packageJson.version });
});

// 获取GitHub最新版本
app.get('/api/latest-version', async (req, res) => {
  try {
    const options = {
      hostname: 'raw.githubusercontent.com',
      path: '/jiujiu532/zeabur-monitor/main/package.json',
      method: 'GET',
      timeout: 5000,
      agent: ZEABUR_KEEP_ALIVE_AGENT
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          const packageJson = JSON.parse(data);
          res.json({ version: packageJson.version });
        } catch (e) {
          res.status(500).json({ error: '解析版本信息失败' });
        }
      });
    });

    request.on('error', (error) => {
      res.status(500).json({ error: '获取最新版本失败: ' + error.message });
    });

    request.on('timeout', () => {
      request.destroy();
      res.status(500).json({ error: '请求超时' });
    });

    request.end();
  } catch (error) {
    res.status(500).json({ error: '获取最新版本失败: ' + error.message });
  }
});

app.use((error, req, res, next) => {
  console.error('❌ 请求处理失败:', error.message);
  if (res.headersSent) {
    return next(error);
  }
  res.status(500).json({ error: '服务器内部错误', detail: error.message });
});

process.on('unhandledRejection', (error) => {
  console.error('❌ 未处理 Promise 异常:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获异常:', error);
});

async function startServer() {
  await bootstrapConfig();

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✨ Zeabur Monitor 运行在 http://0.0.0.0:${PORT}`);

    if (ENCRYPTION_ENABLED) {
      console.log('🔐 Token 加密存储: 已启用 (AES-256-GCM)');
    } else {
      console.log('⚠️  Token 加密存储: 未启用 (建议设置 ACCOUNTS_SECRET 环境变量)');
    }

    const storeStatus = await configStore.status();
    console.log(`💾 配置存储后端: ${(process.env.CONFIG_BACKEND || 'file').toLowerCase()} (${storeStatus.ok ? '可用' : '异常'})`);
    if (!storeStatus.ok) {
      console.log(`⚠️ 存储后端状态: ${storeStatus.detail}`);
    }

    const envAccounts = getEnvAccounts();
    const serverAccounts = await loadServerAccounts();
    const totalAccounts = envAccounts.length + serverAccounts.length;

    if (totalAccounts > 0) {
      console.log(`📋 已加载 ${totalAccounts} 个账号`);
      if (envAccounts.length > 0) {
        console.log(`   环境变量: ${envAccounts.length} 个`);
        envAccounts.forEach(acc => console.log(`     - ${acc.name}`));
      }
      if (serverAccounts.length > 0) {
        console.log(`   存储后端: ${serverAccounts.length} 个`);
        serverAccounts.forEach(acc => console.log(`     - ${acc.name}`));
      }
    } else {
      console.log('📊 准备就绪，等待添加账号...');
    }
  });
}

startServer().catch((error) => {
  console.error('❌ 服务启动失败:', error.message);
  process.exit(1);
});
