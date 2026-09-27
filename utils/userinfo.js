/**
 * 用户信息管理工具
 * 提供登录脚本共享的用户信息更新与保存逻辑
 */

import { printGreen, printRed, printYellow } from './colorOut.js'
import { hasSecretWriteToken, setRepoSecret } from './githubSecrets.js'
import { maskIdentifier, sanitizeForLog } from './safeLog.js'

/**
 * 将登录用户信息更新或追加到 userinfo 数组中
 * @param {Array} userinfo - 用户信息数组
 * @param {{ userid: string, token: string }} loginUser - 新登录的用户
 * @param {boolean} append - 是否追加模式（已存在则更新，否则添加）
 */
function upsertUser(userinfo, loginUser, append) {
  if (append) {
    for (const user of userinfo) {
      if (user.userid == loginUser.userid) {
        printYellow(`userid: ${maskIdentifier(user.userid)} 此账号已存在, 仅更新登录信息`)
        user.token = loginUser.token
        if (loginUser.dfid) user.dfid = loginUser.dfid
        return
      }
    }
  }
  // 保留 loginUser 上的 dfid 等附加字段
  userinfo.push({ userid: loginUser.userid, token: loginUser.token, ...(loginUser.dfid ? { dfid: loginUser.dfid } : {}) })
}

/**
 * 保存 userinfo 到 GitHub Secret。
 * 安全约束：任何情况下都不会把含 token 的 USERINFO 打印到 Actions 日志。
 * @param {Array} userinfo - 用户信息数组
 */
function saveUserinfo(userinfo) {
  if (!userinfo.length) return

  const userinfoJSON = JSON.stringify(userinfo)

  if (hasSecretWriteToken()) {
    try {
      setRepoSecret('USERINFO', userinfoJSON)
      printGreen('secret <USERINFO> 更改成功')
    } catch (error) {
      printRed('自动写入 secret <USERINFO> 出错')
      console.dir(sanitizeForLog({ message: error.message }), { depth: null })
      printSecureFallbackHint()
    }
  } else {
    printYellow('PAT/GH_TOKEN 未配置，无法自动写入 secret <USERINFO>')
    printSecureFallbackHint()
  }
}

/**
 * 仅在日志输出安全的引导信息，绝不回显 USERINFO 原文（含登录 token）。
 * 公开仓库的 Actions 日志对所有人可见，打印 token 等同于盗号。
 */
function printSecureFallbackHint() {
  printRed('为避免泄露 token，本项目不会把 USERINFO 打印到 Actions 日志。')
  printYellow('可选做法：')
  printYellow('  1) 配置最小权限 PAT（仅授权本仓库、Secrets 读写），以便自动回写 USERINFO；')
  printYellow('  2) 或将 fork 仓库设为 Private 后重新运行登录；')
  printYellow('  3) 详见 README「令牌（Token）机制说明」与「安全说明」。')
}

export { upsertUser, saveUserinfo }
