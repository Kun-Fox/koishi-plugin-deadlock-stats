'use strict'

const path = require('node:path')
const { AmbiguousPlayerError, DeadlockApi, DeadlockApiError } = require('./api')
const {
  formatMatchDetail,
  formatProfile,
  formatRecentMatches,
  formatSearch,
} = require('./format')
const { BindingStore } = require('./store')

let Schema = null
try {
  Schema = require('koishi').Schema
} catch {
  Schema = null
}

const name = 'deadlock-stats'
const inject = []

const DEFAULTS = {
  apiBase: 'https://api.deadlock-api.com',
  language: 'schinese',
  timeout: 12000,
  retries: 2,
  recentLimit: 5,
  maxRecent: 20,
  cooldown: 0,
  bindingsFile: 'data/deadlock-stats/bindings.json',
}

const Config = Schema
  ? Schema.object({
    apiBase: Schema.string().default(DEFAULTS.apiBase).description('Deadlock API 地址，一般不需要改。'),
    language: Schema.string().default(DEFAULTS.language).description('英雄/段位本地化语言，如 schinese、english。'),
    timeout: Schema.number().min(1000).max(60000).default(DEFAULTS.timeout).description('单次 API 请求超时（毫秒）。'),
    retries: Schema.number().min(0).max(5).default(DEFAULTS.retries).description('失败重试次数。'),
    recentLimit: Schema.number().min(1).max(20).default(DEFAULTS.recentLimit).description('deadlock.recent 默认显示局数。'),
    maxRecent: Schema.number().min(1).max(50).default(DEFAULTS.maxRecent).description('deadlock.recent 允许的最大局数。'),
    cooldown: Schema.number().min(0).max(60000).default(DEFAULTS.cooldown).description('同一用户命令冷却（毫秒），0 表示不限制。'),
    bindingsFile: Schema.string().default(DEFAULTS.bindingsFile).description('绑定数据文件，相对路径基于 Koishi 根目录。'),
  })
  : undefined

function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  const baseDir = ctx.baseDir || process.cwd()
  const bindingsFile = path.isAbsolute(options.bindingsFile)
    ? options.bindingsFile
    : path.join(baseDir, options.bindingsFile)

  const api = new DeadlockApi({
    baseUrl: options.apiBase,
    language: options.language,
    timeout: options.timeout,
    retries: options.retries,
    cacheTtl: 30000,
    logger: ctx.logger?.(name),
  })
  const store = new BindingStore(bindingsFile, { logger: ctx.logger?.(name) })

  async function helpers() {
    const [heroMap, rankMap] = await Promise.all([
      api.getHeroMap().catch(() => new Map()),
      api.getRankMap().catch(() => new Map()),
    ])
    return { heroMap, rankMap }
  }

  function errorText(error) {
    if (error instanceof AmbiguousPlayerError) return formatSearch(error.candidates)
    if (error instanceof DeadlockApiError) return `查询失败：${error.message}`
    return `查询失败：${error?.message || error}`
  }

  const lastCallAt = new Map()

  function action(handler) {
    return async (argv, ...args) => {
      const session = argv?.session
      const cooldownKey = `${session?.platform || 'unknown'}:${session?.userId || 'unknown'}`
      const now = Date.now()
      if (options.cooldown > 0) {
        const previous = lastCallAt.get(cooldownKey) || 0
        if (now - previous < options.cooldown) {
          return `操作太快，请 ${Math.ceil((options.cooldown - (now - previous)) / 1000)} 秒后再试。`
        }
        lastCallAt.set(cooldownKey, now)
      }
      try {
        return await handler(session, ...args)
      } catch (error) {
        ctx.logger?.(name)?.warn?.(error)
        return errorText(error)
      }
    }
  }

  async function resolveTarget(session, query) {
    const text = String(query || '').trim()
    if (text) return api.resolvePlayer(text)
    const binding = await store.get(session)
    if (!binding) {
      throw new DeadlockApiError('还没有绑定玩家。请先使用 deadlock.bind <玩家名> 或 deadlock.bindid <account_id>。')
    }
    const profiles = await api.getSteamProfiles([binding.accountId])
    return profiles[0] || {
      account_id: binding.accountId,
      personaname: binding.personaName || `account_id ${binding.accountId}`,
    }
  }

  async function bindProfile(session, profile) {
    await store.set(session, {
      accountId: profile.account_id,
      personaName: profile.personaname,
    })
    return `已绑定：${profile.personaname || '未知'}（account_id ${profile.account_id}）\n` +
      '使用 deadlock.profile 查看资料，deadlock.recent 查看近期战绩。'
  }

  const root = ctx.command('deadlock', 'Deadlock 战绩查询')
  root.alias('dl')
  root.usage([
    'deadlock.bind <玩家名>          绑定玩家',
    'deadlock.bindid <account_id>    用 account_id 绑定',
    'deadlock.profile [玩家名]       玩家资料与近期汇总',
    'deadlock.recent [局数]          近期战绩',
    'deadlock.match <match_id>       指定一局详情',
    'deadlock.last                   最近一局详情',
    'deadlock.search <玩家名>        搜索玩家',
    'deadlock.unbind                 解除绑定',
  ].join('\n'))

  ctx.command('deadlock.bind <query:text>', '绑定 Deadlock 玩家')
    .action(action(async (session, query) => {
      const profile = await api.resolvePlayer(query)
      return bindProfile(session, profile)
    }))

  ctx.command('deadlock.bindid <accountId:number>', '用 account_id 绑定玩家')
    .action(action(async (session, accountId) => {
      const profiles = await api.getSteamProfiles([Number(accountId)])
      if (!profiles.length) throw new DeadlockApiError(`找不到 account_id=${accountId} 的玩家`)
      return bindProfile(session, profiles[0])
    }))

  ctx.command('deadlock.unbind', '解除 Deadlock 绑定')
    .action(action(async (session) => {
      const existed = await store.delete(session)
      return existed ? '已解除绑定。' : '当前没有绑定玩家。'
    }))

  ctx.command('deadlock.whoami', '查看当前绑定')
    .action(action(async (session) => {
      const binding = await store.get(session)
      return binding
        ? `当前绑定：${binding.personaName || '未知'}（account_id ${binding.accountId}）`
        : '当前没有绑定玩家。'
    }))

  ctx.command('deadlock.profile [query:text]', '查询玩家资料')
    .action(action(async (session, query) => {
      const profile = await resolveTarget(session, query)
      const overview = await api.getPlayerOverview(profile.account_id, { limit: 20 })
      const maps = await helpers()
      return formatProfile({
        ...overview,
        profile: overview.profile || profile,
      }, maps)
    }))

  ctx.command('deadlock.recent [count:number]', '查询近期战绩')
    .action(action(async (session, count) => {
      const profile = await resolveTarget(session)
      const requested = Number.isFinite(Number(count)) ? Number(count) : options.recentLimit
      const limit = Math.max(1, Math.min(options.maxRecent, requested))
      const history = await api.getMatchHistory(profile.account_id)
      const maps = await helpers()
      return formatRecentMatches(history, { ...maps, limit })
    }))

  ctx.command('deadlock.match <matchId:number>', '查询指定对局')
    .action(action(async (_session, matchId) => {
      const detail = await api.getMatchDetail(Number(matchId))
      const maps = await helpers()
      return formatMatchDetail(detail, maps)
    }))

  ctx.command('deadlock.last', '查询最近一局')
    .action(action(async (session) => {
      const profile = await resolveTarget(session)
      const history = await api.getMatchHistory(profile.account_id)
      if (!history.length) return '近期没有可查询的对局。'
      const detail = await api.getMatchDetail(history[0].match_id)
      const maps = await helpers()
      return formatMatchDetail(detail, maps)
    }))

  ctx.command('deadlock.search <query:text>', '搜索 Deadlock 玩家')
    .action(action(async (_session, query) => {
      const rows = await api.searchPlayers(query, { limit: 10 })
      return formatSearch(rows)
    }))
}

module.exports = { name, inject, Config, apply }
