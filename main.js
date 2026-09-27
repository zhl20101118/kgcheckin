import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { hasSecretWriteToken, setRepoSecret } from "./utils/githubSecrets.js";
import { maskDisplayName, maskIdentifier, sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { sendNotify } from "./utils/notify.js";
import { buildCheckinReport } from "./utils/notifyFormat.js";
import { close_api, daysUntil, delay, parseVipTime, send, startService, waitForApi } from "./utils/utils.js";
import { buildCookieHeader, ensureDfid } from "./utils/dfid.js";

/**
 * 构造接口错误详情，便于排查：
 * 优先返回非空 data（脱敏），再附 msg，最后附错误码；没有 data 时保留错误码。
 */
function bizErrDetail(res) {
  const parts = []
  const data = res?.data
  if (data != null && data !== '' && (typeof data !== 'object' || Object.keys(data).length > 0)) {
    parts.push(`data=${typeof data === 'object' ? JSON.stringify(sanitizeForLog(data)) : data}`)
  }
  const msg = res?.msg || res?.error_msg
  if (msg) parts.push(`msg=${msg}`)
  parts.push(`error_code=${res?.error_code ?? res?.status ?? '未知'}`)
  return parts.join(', ')
}

async function main() {

  const USERINFO = process.env.USERINFO
  // 刷新token
  let needRefresh = false
  if (!USERINFO) {
    throw new Error("未配置")
  }
  const userinfo = JSON.parse(USERINFO)

  // 启动服务并等待就绪（避免冷启动竞态导致首个请求失败）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  const today = new Date();
  // 服务器时间比国内慢8小时
  today.setTime(today.getTime() + 8 * 60 * 60 * 1000)
  //日期
  const DD = String(today.getDate()).padStart(2, '0'); // 获取日
  const MM = String(today.getMonth() + 1).padStart(2, '0'); //获取月份，1 月为 0
  const yyyy = today.getFullYear(); // 获取年份
  const date = yyyy + '-' + MM + '-' + DD

  const errorMsg = {}
  // 通知结果收集
  const notifyResults = []
  let hasError = false

  try {
    // 开始签到
    for (const user of userinfo) {
      // 单账号异常隔离：任何一个账号的请求/解析出错，只记录该账号失败，
      // 不影响其余账号继续执行，也保证后续通知与 secret 刷新一定能触发。
      try {
        // 确保设备指纹 dfid 存在（风控较严的接口要求真实 dfid；缺失时静默补取，获取到则稍后回写 USERINFO）
        if (!user.dfid && await ensureDfid(user)) {
          needRefresh = true
        }
        let headers = { 'cookie': buildCookieHeader(user) }
        const userDetail = await send(`/user/detail?timestrap=${Date.now()}`, "GET", headers)
        if (userDetail?.data?.nickname == null) {
          const safeUserId = maskIdentifier(user.userid)
          printRed(`token过期或账号不存在, userid: ${safeUserId}`)
          errorMsg[safeUserId] = {
            msg: `token过期或账号不存在, userid: ${safeUserId}`,
            data: summarizeResponse(userDetail)
          }
          notifyResults.push({
            nickname: safeUserId,
            status: '失败',
            listen: '账号不存在',
            vipClaim: '0/8',
            vipExpiry: '未知',
            dayVip: '-',
            upgrade: '-',
            remainDays: null,
            error: 'token过期或账号不存在'
          })
          hasError = true
          continue
        }
        const safeNickname = maskDisplayName(userDetail.data.nickname)
        printMagenta(`账号 ${safeNickname} 开始领取VIP...`)

        // 周日刷新token
        if (today.getDay() === 0) {
          const refreshToken = await send(`/login/token?timestrap=${Date.now()}`, "POST", headers)
          if (refreshToken?.status == 1) {
            if (refreshToken?.data?.token !== user.token) {
              needRefresh = true
              printYellow(`账号 ${safeNickname} 需要刷新token`)
              user.token = refreshToken.data.token
              // 用新 token 重建本次请求的 headers，使后续听歌/VIP 领取使用刷新后的凭证
              headers = { 'cookie': buildCookieHeader(user) }
            }
          }
        }

        // 开始听歌
        printYellow(`开始听歌领取VIP...`)
        // 听歌获取vip
        const listen = await send(`/youth/listen/song?timestrap=${Date.now()}`, "GET", headers)

        let listenStatus = '未知'
        if (listen.status === 1) {
          printGreen("听歌领取成功")
          listenStatus = '成功'
        } else if (listen.error_code === 130012) {
          printGreen("今日已领取")
          listenStatus = '今日已领取'
        } else {
          errorMsg[`${safeNickname} listen`] = summarizeResponse(listen)
          printRed("听歌领取失败")
          listenStatus = '失败'
          hasError = true
        }

        printYellow("开始领取VIP...")
        let claimCount = 0
        let claimTotal = 0
        for (let i = 1; i <= 8; i++) {
          // ad获取vip
          const ad = await send(`/youth/vip?timestrap=${Date.now()}`, "GET", headers)
          claimTotal = i
          if (ad.status === 1) {
            printGreen(`第${i}次领取成功`)
            claimCount++
            if (i != 8) {
              // 25~35 秒随机间隔，降低固定节奏被风控识别的概率
              await delay(25000 + Math.floor(Math.random() * 10000))
            }
          } else if (ad.error_code === 30002) {
            printGreen("今天次数已用光")
            break
          } else {
            printRed(`第${i}次领取失败`)
            errorMsg[`${safeNickname} ad`] = summarizeResponse(ad)
            hasError = true
            break
          }
        }

        // 先查 VIP 明细（/user/vip/detail），busi_vip 数组含 svip/tvip/dvip/qvip 等多项
        // 决策规则：svip 仍在有效期内 → 无需领取/升级；tvip 有效 → 直接升级；都过期 → 领取+升级
        let vip_details = await send(`/user/vip/detail?timestrap=${Date.now()}`, "GET", headers)
        let busiVip = (vip_details?.status === 1 && Array.isArray(vip_details?.data?.busi_vip)) ? vip_details.data.busi_vip : []
        const activeVipOf = (type) => busiVip.find(v => v?.product_type === type && v?.is_vip === 1 && (parseVipTime(v?.vip_end_time)?.getTime() || 0) > Date.now())
        let activeSvip = activeVipOf('svip')
        let activeTvip = activeVipOf('tvip')

        let dayVipStatus = '-'
        let upgradeStatus = '-'

        if (activeSvip) {
          // 目标已达成：svip 仍在有效期内，跳过领取与升级
          printGreen(`超级VIP(svip)仍在有效期内（至 ${activeSvip.vip_end_time}），无需领取与升级`)
          dayVipStatus = '超级VIP有效'
          upgradeStatus = '超级VIP有效'
        } else {
          let gotToday = false
          if (activeTvip) {
            printYellow("tvip 仍在有效期内，跳过领取，直接升级")
            dayVipStatus = '畅听VIP有效'
          } else {
            // 领取一天概念版 VIP（receive_day 传当天；勿频繁调用、勿领多日）
            printYellow("领取一天概念VIP...")
            const receiveRes = await send(`/youth/day/vip?receive_day=${date}&timestrap=${Date.now()}`, "GET", headers)
            if (receiveRes.status === 1) {
              printGreen("一天概念VIP领取成功")
              dayVipStatus = '成功'
              gotToday = true
            } else if (receiveRes.error_code === 131001) {
              // 131001：今日已签到领取，属正常情况而非失败
              printGreen("一天概念VIP今日已领取")
              dayVipStatus = '今日已领取'
              gotToday = true
            } else {
              dayVipStatus = `失败(${bizErrDetail(receiveRes)})`
              printRed(`一天概念VIP领取失败：${bizErrDetail(receiveRes)}`)
            }
          }

          // 升级为超级 VIP（需先领取一天 VIP，升级有效期 24h）
          // 仅在领取流程走过（含今天已领取 131001）时才调用；297000=无需升级/奖励不存在，属正常
          if (gotToday) {
            printYellow("升级超级VIP...")
            const upgradeRes = await send(`/youth/day/vip/upgrade?timestrap=${Date.now()}`, "GET", headers)
            const upgradeMsg = String(upgradeRes?.msg || upgradeRes?.error_msg || upgradeRes?.data?.msg || (typeof upgradeRes?.data === 'string' ? upgradeRes.data : '') || '')
            if (upgradeRes.status === 1) {
              printGreen("升级超级VIP成功")
              upgradeStatus = '成功'
            } else if (upgradeRes.error_code === 297000 || /已(经)?领取|无需|不能升级/.test(upgradeMsg)) {
              // 297000 等业务码：该账号当前无升级奖励可领（多为 svip 尚在有效期），属正常情况
              printGreen(`升级超级VIP：${upgradeMsg || '无需升级'}`)
              upgradeStatus = '无需升级'
            } else {
              upgradeStatus = `失败(${bizErrDetail(upgradeRes)})`
              printRed(`升级超级VIP失败：${bizErrDetail(upgradeRes)}`)
            }
          } else {
            upgradeStatus = '跳过'
          }
        }

        // 展示用：优先 svip 到期时间，其次任何仍在有效的 vip 项
        let vipExpiry = '未知'
        let remainDays = null
        const effective = busiVip.filter(v => v?.is_vip === 1 && (parseVipTime(v?.vip_end_time)?.getTime() || 0) > Date.now())
        const preferred = effective.find(v => v?.product_type === 'svip') || effective[0]
        if (preferred) {
          vipExpiry = preferred.vip_end_time
          remainDays = daysUntil(parseVipTime(vipExpiry))
          printBlue(`今天是：${date}`)
          printBlue(`VIP到期时间（${preferred.product_type}）：${vipExpiry}${remainDays != null ? `（还剩 ${remainDays} 天）` : ''}\n`)
        } else {
          printRed("VIP到期时间获取失败\n")
          errorMsg[`${safeNickname} vip_details`] = summarizeResponse(vip_details)
          hasError = true
        }

        notifyResults.push({
          nickname: safeNickname,
          status: listenStatus === '失败' || claimCount === 0 ? '部分失败' : '成功',
          listen: listenStatus,
          vipClaim: `${claimCount}/${claimTotal}`,
          dayVip: dayVipStatus,
          upgrade: upgradeStatus,
          vipExpiry,
          remainDays,
          error: ''
        })
      } catch (err) {
        const safeUserId = maskIdentifier(user.userid || '未知')
        printRed(`账号 ${safeUserId} 处理异常：${err && err.message ? err.message : String(err)}`)
        errorMsg[safeUserId] = { msg: '处理异常', error: err && err.message ? err.message : String(err) }
          notifyResults.push({
            nickname: safeUserId,
            status: '失败',
            listen: '异常',
            vipClaim: '0/8',
            vipExpiry: '未知',
            dayVip: '-',
            upgrade: '-',
            remainDays: null,
            error: err && err.message ? err.message : String(err)
          })
        hasError = true
        continue
      }
    }

  } finally {
    close_api(api)
  }

  // 更新secret <USERINFO>（使用完整 userinfo 数组，保留所有用户包括过期账号）
  let secretError = null
  if (needRefresh) {
    if (hasSecretWriteToken()) {
      const userinfoJSON = JSON.stringify(userinfo)
      try {
        setRepoSecret("USERINFO", userinfoJSON)
        printGreen("secret <USERINFO> token刷新成功")
      } catch (error) {
        printRed("token刷新失败")
        console.dir(sanitizeForLog({ message: error.message }), { depth: null })
        secretError = new Error("secret <USERINFO> token刷新失败")
      }
    } else {
      printYellow("存在账号数据变化（token刷新/dfid补齐），但是未配置PAT，无法回写；未刷新token最多两个月后过期")
    }
  }

  // 构建通知内容（放在 secret 更新之后、错误抛出之前，确保始终执行）
  const title = `酷狗签到${hasError ? '异常' : '成功'} ${date}`
  const content = buildCheckinReport(date, notifyResults)

  // 发送通知（确保即使 secret 更新失败也能发出）
  try {
    await sendNotify(title, content)
  } catch (e) {
    printYellow(`通知发送异常: ${e.message}`)
  }

  if (Object.keys(errorMsg).length > 0) {
    printRed("异常信息如下:")
    console.dir(sanitizeForLog(errorMsg), { depth: null })
    throw new Error("领取异常")
  }

  if (secretError) {
    throw secretError
  }

}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
