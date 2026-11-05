'use strict'

const DEFAULT_BASE_URL = 'https://api.deadlock-api.com'

class DeadlockApiError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'DeadlockApiError'
    this.status = options.status
    this.url = options.url
    if (options.cause) this.cause = options.cause
  }
}

class AmbiguousPlayerError extends Error {
  constructor(query, candidates) {
    super(`找到多个名为“${query}”的玩家，请使用 deadlock.bindid <account_id> 指定`)
    this.name = 'AmbiguousPlayerError'
    this.query = query
    this.candidates = candidates
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createTimeoutSignal(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

class DeadlockApi {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.language = options.language || 'schinese'
    this.timeout = options.timeout || 12000
    this.retries = Number.isInteger(options.retries) ? options.retries : 2
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.logger = options.logger
    this._heroMap = null
    this._heroMapAt = 0
    this._rankMap = null
    this._rankMapAt = 0
    this._historyCache = new Map()
    this._cacheTtl = options.cacheTtl || 30000
  }

  _url(path, params) {
    const url = new URL(path, this.baseUrl + '/')
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item))
        } else {
          url.searchParams.set(key, String(value))
        }
      }
    }
    return url
  }

  async request(path, params, options = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new DeadlockApiError('当前 Node.js 没有全局 fetch，请使用 Node 18+')
    }
    const url = this._url(path, params)
    const retries = Number.isInteger(options.retries) ? options.retries : this.retries
    const timeout = options.timeout || this.timeout
    let lastError

    for (let attempt = 0; attempt <= retries; attempt++) {
      const timeoutSignal = createTimeoutSignal(timeout)
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'koishi-plugin-deadlock-stats/0.1.0',
          },
          signal: timeoutSignal.signal,
        })
        const text = await response.text()
        let body = null
        if (text) {
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
        }
        if (response.ok) return body

        const detail = typeof body === 'string' ? body.slice(0, 300) : body?.error || body?.message || ''
        lastError = new DeadlockApiError(
          `Deadlock API ${response.status}${detail ? `: ${detail}` : ''}`,
          { status: response.status, url: url.toString() },
        )
        if (response.status === 429 || response.status >= 500) {
          if (attempt < retries) {
            const retryAfter = Number(response.headers.get('retry-after'))
            const wait = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 400 * (attempt + 1)
            await sleep(wait)
            continue
          }
        }
        throw lastError
      } catch (error) {
        lastError = error
        if (error?.name === 'AbortError') {
          lastError = new DeadlockApiError(`Deadlock API 请求超时（${timeout}ms）`, {
            url: url.toString(),
            cause: error,
          })
        }
        if (attempt < retries) {
          await sleep(400 * (attempt + 1))
          continue
        }
        break
      } finally {
        timeoutSignal.clear()
      }
    }

    if (lastError instanceof DeadlockApiError) throw lastError
    throw new DeadlockApiError(`Deadlock API 请求失败：${lastError?.message || lastError}`, {
      url: url.toString(),
      cause: lastError,
    })
  }

  async searchPlayers(query, options = {}) {
    const rows = await this.request('/v1/players/steam-search', {
      search_query: query,
      limit: options.limit || 25,
      min_matches_played_last_30d: options.minMatchesPlayedLast30d ?? 0,
    })
    return Array.isArray(rows) ? rows : []
  }

  async getSteamProfiles(accountIds) {
    const ids = [...new Set((accountIds || []).map(Number).filter((id) => Number.isInteger(id) && id >= 0))]
    if (!ids.length) return []
    const rows = await this.request('/v1/players/steam', { account_ids: ids })
    return Array.isArray(rows) ? rows : []
  }

  async getRank(accountId) {
    return this.request(`/v1/players/${encodeURIComponent(accountId)}/rank`)
  }

  async getMatchHistory(accountId, options = {}) {
    const key = String(accountId)
    const now = Date.now()
    if (!options.force) {
      const cached = this._historyCache.get(key)
      if (cached && now - cached.at < this._cacheTtl) return cached.rows
    }
    const rows = await this.request(`/v1/players/${encodeURIComponent(accountId)}/match-history`, {
      force_refetch: options.force ? true : undefined,
    })
    const result = Array.isArray(rows) ? rows : []
    this._historyCache.set(key, { at: now, rows: result })
    return result
  }

  async getMatchMetadata(matchId) {
    return this.request(`/v1/matches/${encodeURIComponent(matchId)}/metadata`)
  }

  async getHeroMap() {
    if (this._heroMap && Date.now() - this._heroMapAt < 3600_000) return this._heroMap
    const rows = await this.request('/v1/assets/heroes', { language: this.language })
    const map = new Map()
    for (const hero of Array.isArray(rows) ? rows : []) {
      if (hero && Number.isInteger(hero.id)) map.set(hero.id, hero.name || `英雄#${hero.id}`)
    }
    this._heroMap = map
    this._heroMapAt = Date.now()
    return map
  }

  async getRankMap() {
    if (this._rankMap && Date.now() - this._rankMapAt < 3600_000) return this._rankMap
    const rows = await this.request('/v1/assets/ranks', { language: this.language })
    const map = new Map()
    for (const rank of Array.isArray(rows) ? rows : []) {
      if (rank && Number.isInteger(rank.tier)) map.set(rank.tier, rank.name || `段位${rank.tier}`)
    }
    this._rankMap = map
    this._rankMapAt = Date.now()
    return map
  }

  async resolvePlayer(query) {
    const text = String(query || '').trim()
    if (!text) throw new DeadlockApiError('请提供玩家名或 account_id')
    if (/^\d+$/.test(text)) {
      const profiles = await this.getSteamProfiles([Number(text)])
      if (!profiles.length) throw new DeadlockApiError(`找不到 account_id=${text} 的玩家`)
      return profiles[0]
    }

    const candidates = await this.searchPlayers(text, { limit: 25 })
    if (!candidates.length) throw new DeadlockApiError(`找不到名为“${text}”的玩家`)
    const exact = candidates.find((p) => String(p.personaname || '').toLowerCase() === text.toLowerCase())
    if (exact) return exact
    if (candidates.length === 1) return candidates[0]
    throw new AmbiguousPlayerError(text, candidates.slice(0, 8))
  }

  async getPlayerOverview(accountId, options = {}) {
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 20))
    const [profiles, rank, history] = await Promise.all([
      this.getSteamProfiles([accountId]),
      this.getRank(accountId).catch(() => null),
      this.getMatchHistory(accountId),
    ])
    const profile = profiles[0] || null
    const recent = history.slice(0, limit)
    const summary = summarizeHistory(recent)
    return { profile, rank, history, recent, summary }
  }

  async getMatchDetail(matchId) {
    const [metadata, heroes] = await Promise.all([
      this.getMatchMetadata(matchId),
      this.getHeroMap(),
    ])
    const info = metadata?.match_info || {}
    const players = Array.isArray(info.players) ? info.players : []
    const ids = players.map((p) => p.account_id).filter((id) => Number.isInteger(id))
    const profiles = ids.length ? await this.getSteamProfiles(ids).catch(() => []) : []
    return { metadata, info, players, profiles, heroes }
  }
}

function summarizeHistory(rows) {
  const result = {
    total: rows.length,
    wins: 0,
    losses: 0,
    other: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    heroes: new Map(),
  }
  for (const row of rows) {
    if (row.player_match_outcome === 1) result.wins++
    else if (row.player_match_outcome === 2) result.losses++
    else result.other++
    result.kills += Number(row.player_kills) || 0
    result.deaths += Number(row.player_deaths) || 0
    result.assists += Number(row.player_assists) || 0
    const heroId = row.hero_id
    result.heroes.set(heroId, (result.heroes.get(heroId) || 0) + 1)
  }
  result.kda = result.deaths > 0
    ? (result.kills + result.assists) / result.deaths
    : (result.kills + result.assists)
  result.winRate = result.total ? result.wins / result.total : 0
  return result
}

module.exports = {
  AmbiguousPlayerError,
  DeadlockApi,
  DeadlockApiError,
  DEFAULT_BASE_URL,
  summarizeHistory,
}
