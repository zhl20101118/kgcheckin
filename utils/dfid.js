/**
 * 设备指纹 dfid 获取工具
 *
 * 背景：酷狗风控较严的接口（如领取 VIP / 升级超级VIP / 获取歌曲 URL 等）
 * 要求请求携带真实 dfid，否则会返回"本次请求需要验证"之类的错误。
 * dfid 由 /register/dev（设备注册）接口下发，与账号无关、可长期复用，
 * 因此登录时获取一次并随 USERINFO 持久化即可；缺失时再自动补取。
 */

import { send } from './utils.js'
import { maskIdentifier } from './safeLog.js'
import { printGreen, printYellow } from './colorOut.js'

/**
 * 调用 /register/dev 为指定账号获取 dfid
 * @param {{ userid: string|number, token: string }} user
 * @returns {Promise<string|null>} 成功返回 dfid，失败返回 null
 */
async function fetchDfid(user) {
  try {
    const res = await send(`/register/dev?timestrap=${Date.now()}`, 'GET', {
      cookie: `token=${user.token}; userid=${user.userid}`,
    })
    const dfid = res?.data?.dfid
    if (res?.status === 1 && dfid) {
      return dfid
    }
    return null
  } catch {
    return null
  }
}

/**
 * 确保账号对象带有 dfid；缺失时自动调用 /register/dev 补齐。
 * @param {{ userid: string|number, token: string, dfid?: string }} user
 * @param {boolean} log 是否打印日志（默认 true）
 * @returns {Promise<boolean>} 是否新获取了 dfid（调用方可据此决定是否回写 USERINFO）
 */
async function ensureDfid(user, log = true) {
  if (user.dfid) return false
  const dfid = await fetchDfid(user)
  if (dfid) {
    user.dfid = dfid
    if (log) printGreen(`账号 ${maskIdentifier(user.userid)} 已获取设备指纹 dfid`)
    return true
  }
  if (log) printYellow(`账号 ${maskIdentifier(user.userid)} 获取 dfid 失败（后续部分接口可能无法使用）`)
  return false
}

/** 构造带 dfid 的请求 cookie 头 */
function buildCookieHeader(user) {
  const base = `token=${user.token}; userid=${user.userid}`
  return user.dfid ? `${base}; dfid=${user.dfid}` : base
}

export { fetchDfid, ensureDfid, buildCookieHeader }
