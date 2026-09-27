import { printBlue, printGreen, printRed, printYellow } from "./utils/colorOut.js";
import { hasSecretWriteToken, setRepoSecret } from "./utils/githubSecrets.js";
import { maskDisplayName, maskIdentifier, summarizeResponse } from "./utils/safeLog.js";
import { sendNotify } from "./utils/notify.js";
import { buildAccountReport } from "./utils/notifyFormat.js";
import { close_api, daysUntil, parseVipTime, send, startService, waitForApi } from "./utils/utils.js";
import { buildCookieHeader, ensureDfid } from "./utils/dfid.js";

// VIP 距到期不超过该天数视为“临期”，在通知中高亮提醒
const RENEW_SOON_DAYS = 3

async function main() {
  const USERINFO = process.env.USERINFO
  if (!USERINFO) throw new Error("未配置 Secret USERINFO")
  const userinfo = JSON.parse(USERINFO)
  // 支持 env OPERATION 或命令行参数：refresh | vip（默认 vip）
  const operation = String(process.env.OPERATION || process.argv[2] || 'vip').toLowerCase()
  const isRefresh = operation === 'refresh'

  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  const results = []
  const errors = []
  let changed = false

  try {
    for (const user of userinfo) {
      // 补充设备指纹 dfid（老数据可能缺失；获取到时统一回写持久化）
      if (!user.dfid && await ensureDfid(user, false)) {
        changed = true
      }
      const headers = { cookie: buildCookieHeader(user) }
      const idLabel = maskIdentifier(user.userid)
      try {
        if (isRefresh) {
          // 刷新登录 token
          const r = await send(`/login/token?timestrap=${Date.now()}`, 'POST', headers)
          if (r?.status === 1 && r?.data?.token) {
            if (r.data.token !== user.token) {
              user.token = r.data.token
              changed = true
            }
            printGreen(`账号 ${idLabel} 登录已刷新`)
            results.push({ account: idLabel, ok: true, detail: '登录已刷新' })
          } else {
            printRed(`账号 ${idLabel} 刷新失败`)
            results.push({ account: idLabel, ok: false, detail: '刷新失败' })
            errors.push(`${idLabel}: 刷新失败 ${JSON.stringify(summarizeResponse(r))}`)
          }
        } else {
          // 查询 VIP 状态
          const detail = await send(`/user/detail?timestrap=${Date.now()}`, 'GET', headers)
          const nickname = detail?.data?.nickname ? maskDisplayName(detail.data.nickname) : idLabel
          const vip = await send(`/user/vip/detail?timestrap=${Date.now()}`, 'GET', headers)

          let endText = '未知'
          let remain = null
          let soon = false
          const ok = vip?.status === 1 && Array.isArray(vip?.data?.busi_vip) && vip.data.busi_vip.length > 0
          if (ok) {
            endText = vip.data.busi_vip[0].vip_end_time
            remain = daysUntil(parseVipTime(endText))
            soon = remain != null && remain <= RENEW_SOON_DAYS
            printBlue(`账号 ${nickname} VIP 到期：${endText}${remain != null ? `（还剩 ${remain} 天）` : ''}`)
          } else {
            printRed(`账号 ${nickname} 查询 VIP 失败`)
            errors.push(`${nickname}: 查询 VIP 失败 ${JSON.stringify(summarizeResponse(vip))}`)
          }
          results.push({ account: nickname, ok, detail: `VIP到期 ${endText}`, remain, soon })
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e)
        printRed(`账号 ${idLabel} 处理异常：${msg}`)
        results.push({ account: idLabel, ok: false, detail: '异常' })
        errors.push(`${idLabel}: ${msg}`)
      }
    }
  } finally {
    close_api(api)
  }

  // token 刷新或 dfid 补齐导致数据变化 → 回写 USERINFO（需 PAT）
  if (changed) {
    if (hasSecretWriteToken()) {
      try {
        setRepoSecret('USERINFO', JSON.stringify(userinfo))
        printGreen('secret <USERINFO> 已更新')
      } catch (e) {
        printRed('secret <USERINFO> 更新失败')
        console.dir(summarizeResponse({ message: e.message }), { depth: null })
        errors.push('写回 USERINFO 失败')
      }
    } else {
      printYellow('未配置 PAT，刷新后的 token 未能回写 secret（仅在本次运行内存中生效）')
    }
  }

  // 汇总通知
  const okCount = results.filter(r => r.ok).length
  const title = `账号${isRefresh ? '登录刷新' : 'VIP 状态'} ${okCount}/${results.length} 成功`
  let content = buildAccountReport(isRefresh ? 'refresh' : 'vip', results)
  if (errors.length) {
    content += `\n── 异常 ────────\n` + errors.map(e => `• ${e}`).join('\n')
  }
  try {
    await sendNotify(title, content)
  } catch (e) {
    printYellow(`通知发送异常: ${e.message}`)
  }

  // 仅在“全部失败”时非零退出，便于 Actions 标红；部分失败不阻断
  if (results.length && results.every(r => !r.ok)) {
    throw new Error('全部账号处理失败')
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
