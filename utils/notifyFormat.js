/**
 * 通知消息格式化（签到报表 / 账号管理报表）
 * 输出 Markdown 风格的纯文本，兼容所有通知渠道（飞书/企业微信/邮箱等）。
 * 注意不使用等宽对齐表格，避免手机端 emoji/全角宽度导致的错位。
 */

/* '2026-09-25 10:51:58' -> '09-25' */
function shortDate(s) {
  const m = String(s || '').match(/^\d{4}-(\d{2}-\d{2})/)
  return m ? m[1] : String(s || '-')
}

/**
 * 签到日报
 * @param {string} date  北京时间日期 'YYYY-MM-DD'
 * @param {Array} results  { nickname, status, listen, vipClaim, dayVip, upgrade, vipExpiry, remainDays, error }
 */
function buildCheckinReport(date, results) {
  const total = results.length
  const okCount = results.filter(r => r.status === '成功').length
  const icon = okCount === total ? '✅' : okCount === 0 ? '❌' : '⚠️'
  const headline = okCount === total ? '全部成功' : okCount === 0 ? '全部失败' : '部分成功'

  const lines = [
    `📋 酷狗签到 ｜ ${date}`,
    `${icon} ${headline}（${okCount}/${total}）`,
  ]

  // 临期提醒（超级VIP ≤3 天）
  const expiring = results.filter(r => r.remainDays != null && r.remainDays <= 3)
  if (expiring.length) {
    lines.push('')
    lines.push('⏳ 临期提醒')
    for (const r of expiring) lines.push(`• ${r.nickname}：超级VIP 还剩 ${r.remainDays} 天`)
  }

  lines.push('')
  lines.push('── 账号明细 ──────────')
  results.forEach((r, i) => {
    if (i > 0) lines.push('')
    lines.push(`【${r.nickname}】`)
    lines.push(`🎵 听歌: ${r.listen}  ｜  🎁 广告: ${r.vipClaim}`)
    lines.push(`🎫 单日: ${r.dayVip}  ｜  ⬆️ 升级: ${r.upgrade}`)
    lines.push(`⏰ 到期: ${shortDate(r.vipExpiry)}${r.remainDays != null ? `（还剩 ${r.remainDays} 天）` : ''}`)
    if (r.error) lines.push(`⚠️ ${r.error}`)
  })

  // 异常账号单独汇总
  const fails = results.filter(r => r.error)
  if (fails.length) {
    lines.push('')
    lines.push('── 异常账号 ────────')
    for (const r of fails) lines.push(`• ${r.nickname}：${r.error}`)
  }

  return lines.join('\n')
}

/**
 * 账号管理报表（vip 查询 / refresh 刷新）
 * @param {'vip'|'refresh'} op
 * @param {Array} rows  vip: { account, ok, detail(endText|err), remain, soon }
 *                      refresh: { account, ok, detail }
 */
function buildAccountReport(op, rows) {
  const okCount = rows.filter(r => r.ok).length
  const title = op === 'refresh' ? '登录刷新' : 'VIP 状态'
  const lines = [`${okCount === rows.length ? '✅' : '⚠️'} ${title}（${okCount}/${rows.length} 成功）`, '']

  rows.forEach((r, i) => {
    if (i > 0) lines.push('')
    const mark = r.ok ? '✅' : '❌'
    if (op === 'vip') {
      lines.push(`${mark} 【${r.account}】`)
      lines.push(`⏰ ${r.detail}${r.remain != null ? `（还剩 ${r.remain} 天${r.soon ? ' ⚠️ 临期' : ''}）` : ''}`)
    } else {
      lines.push(`${mark} 【${r.account}】 ${r.detail}`)
    }
  })

  return lines.join('\n')
}

export { buildCheckinReport, buildAccountReport }
