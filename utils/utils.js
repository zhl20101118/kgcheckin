import { spawn } from 'child_process'

/** 延时 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等待本地 api 服务就绪（启动竞态修复）。
 * 原先各脚本在 startService() 后盲目 delay(2000)，
 * 在冷启动的 Actions runner 上可能因服务未就绪导致首个请求失败/超时。
 * 改为轮询探测：服务端口可响应任意 HTTP 即视为就绪，最多等待 timeoutMs。
 * @param {string} base 服务地址
 * @param {number} timeoutMs 最长等待毫秒
 */
async function waitForApi(base = 'http://127.0.0.1:3000', timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const resp = await fetch(base + '/user/detail', { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      // 任意 HTTP 响应（含 4xx/5xx）都说明服务已在监听端口
      return true
    } catch (err) {
      // 连接被拒（ECONNREFUSED）等服务尚未就绪，稍后重试
      await delay(500)
    }
  }
  throw new Error(`本地 API 服务在 ${timeoutMs}ms 内未就绪`)
}

/** 启动 api 服务（detached 使其成为独立进程组，便于整组强杀） */
function startService() {
  const api = spawn('npm', ['run', 'apiService'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  api.stdout.on('data', () => {})
  api.stderr.on('data', data => {
    const msg = String(data).trim()
    if (msg) console.log('[api stderr]', msg)
  })
  // 注意：close_api 以 SIGKILL 主动结束进程组时，close 事件的 code 为 null，退出信息在 signal 字段
  api.on('close', (code, signal) => console.log(`[api] 服务已退出（${signal ? `signal=${signal}` : `code=${code}`}）`))

  return api
}

/**
 * 关闭 api 服务。
 * 关键修复：npm 不会把 SIGTERM 转发给它的子进程（真正的 Express 服务），
 * 仅 api.kill() 会导致 3000 端口一直被占 → 下一阶段 startService 报 EADDRINUSE。
 * 因此用 detached 进程组 + process.kill(-pid) 强杀整组。
 */
function close_api(api) {
  if (!api || !api.pid) return
  try {
    process.kill(-api.pid, 'SIGKILL') // 杀掉整个进程组（npm + Express）
  } catch (e) {
    try { api.kill('SIGKILL') } catch (_) { /* 已退出 */ }
  }
}

/**
 * 发送请求到本地 api 服务（带超时 + 重试）
 * 超时 10 秒，失败后指数退避重试最多 3 次
 */
async function send(path, method, headers) {
  const MAX_RETRIES = 3
  const TIMEOUT_MS = 10000
  let lastError

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch('http://127.0.0.1:3000' + path, {
        method,
        headers,
        signal: controller.signal,
      })
      clearTimeout(timer)
      return await resp.json()
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt < MAX_RETRIES - 1) {
        const waitMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
        console.log(`[send] 第 ${attempt + 1} 次请求失败，${waitMs}ms 后重试: ${err.message}`)
        await delay(waitMs)
      }
    }
  }
  throw lastError
}

/**
 * 解析 VIP 到期时间，兼容 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD' / 秒或毫秒时间戳
 * @param {string|number} value
 * @returns {Date|null} 无法解析时返回 null
 */
function parseVipTime(value) {
  if (value == null || value === '') return null
  // 纯数字：秒级或毫秒级时间戳
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const num = Number(value)
    const ms = num < 1e12 ? num * 1000 : num
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d
  }
  // 字符串日期：'-' 换成 '/' 以提升各环境解析兼容性
  const d = new Date(String(value).trim().replace(/-/g, '/'))
  return isNaN(d.getTime()) ? null : d
}

/**
 * 计算到指定日期的剩余天数（向上取整；负数表示已过期）
 * @param {Date|null} date
 * @returns {number|null}
 */
function daysUntil(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null
  const ms = date.getTime() - Date.now()
  return Math.ceil(ms / (24 * 60 * 60 * 1000))
}

export { delay, startService, close_api, send, waitForApi, parseVipTime, daysUntil }
