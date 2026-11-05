'use strict'

const SUBRANKS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI']

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${pad2(rest)}`
}

function formatDate(unixSeconds) {
  const value = Number(unixSeconds)
  if (!Number.isFinite(value) || value <= 0) return '未知时间'
  const date = new Date(value * 1000)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function formatNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return new Intl.NumberFormat('zh-CN').format(Math.round(number))
}

function outcomeText(outcome) {
  switch (Number(outcome)) {
    case 1: return '胜'
    case 2: return '负'
    case 3: return '惩罚'
    case 4: return '惩罚'
    case 5: return '未计分'
    default: return '未知'
  }
}

function heroName(heroMap, id) {
  return heroMap?.get?.(Number(id)) || `英雄#${id}`
}

function rankText(rank, rankMap) {
  if (!rank || !Number(rank.badge)) return '未定级'
  const tier = Number.isInteger(rank.rank) ? rank.rank : Math.floor(Number(rank.badge) / 10)
  const subrank = Number.isInteger(rank.subrank) ? rank.subrank : Number(rank.badge) % 10
  const name = rankMap?.get?.(tier) || `段位${tier}`
  return subrank ? `${name} ${SUBRANKS[subrank] || subrank}` : name
}

function formatProfile(overview, helpers = {}) {
  const { profile, rank, summary, recent } = overview
  const { heroMap, rankMap } = helpers
  if (!profile) return '没有找到玩家资料。'

  const lines = []
  lines.push(`玩家：${profile.personaname || '未知'}（account_id ${profile.account_id}）`)
  if (profile.profileurl) lines.push(`Steam：${profile.profileurl}`)
  lines.push(`段位：${rankText(rank, rankMap)}`)

  if (summary?.total) {
    const winRate = (summary.winRate * 100).toFixed(1)
    const kda = summary.kda.toFixed(2)
    lines.push(`近 ${summary.total} 局：${summary.wins} 胜 ${summary.losses} 负` +
      `${summary.other ? ` / ${summary.other} 其他` : ''} · 胜率 ${winRate}% · KDA ${kda}`)

    const topHeroes = [...summary.heroes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => `${heroName(heroMap, id)} ×${count}`)
    if (topHeroes.length) lines.push(`常用英雄：${topHeroes.join('、')}`)
  } else {
    lines.push('近期没有可查询的对局。')
  }

  const last = recent?.[0]
  if (last) {
    lines.push(`最近一局：${formatDate(last.start_time)} · ${heroName(heroMap, last.hero_id)} · ` +
      `${outcomeText(last.player_match_outcome)} · ` +
      `${last.player_kills}/${last.player_deaths}/${last.player_assists} · ` +
      `#${last.match_id}`)
  }
  return lines.join('\n')
}

function formatRecentMatches(rows, helpers = {}) {
  const { heroMap, limit = 5 } = helpers
  const list = (rows || []).slice(0, Math.max(1, limit))
  if (!list.length) return '近期没有可查询的对局。'

  const lines = [`最近 ${list.length} 局：`]
  list.forEach((row, index) => {
    lines.push(
      `${index + 1}. ${formatDate(row.start_time)} · ${heroName(heroMap, row.hero_id)} · ` +
      `${outcomeText(row.player_match_outcome)} · ` +
      `${row.player_kills}/${row.player_deaths}/${row.player_assists} · ` +
      `${formatDuration(row.match_duration_s)} · #${row.match_id}`,
    )
  })
  return lines.join('\n')
}

function formatMatchDetail(detail, helpers = {}) {
  const { info, players, profiles, heroes } = detail
  const { rankMap } = helpers
  if (!info || !players?.length) return '没有找到这场比赛的数据。'

  const profileMap = new Map((profiles || []).map((p) => [Number(p.account_id), p]))
  const winningTeam = Number(info.winning_team)
  const lines = [
    `比赛 #${info.match_id || '?'} · ${formatDate(info.start_time)} · ${formatDuration(info.duration_s)}`,
    `胜利方：Team ${Number.isFinite(winningTeam) ? winningTeam : '?'}`,
  ]

  for (const team of [0, 1]) {
    const teamPlayers = players
      .filter((p) => Number(p.team) === team)
      .sort((a, b) => Number(a.player_slot) - Number(b.player_slot))
    if (!teamPlayers.length) continue
    lines.push('', `Team ${team}${team === winningTeam ? '（胜）' : ''}：`)
    for (const player of teamPlayers) {
      const profile = profileMap.get(Number(player.account_id))
      const name = profile?.personaname || `玩家${player.account_id}`
      const rank = player.player_rank_data?.rank
        ? ` · ${rankText(player.player_rank_data, rankMap)}`
        : ''
      lines.push(
        `- ${heroName(heroes, player.hero_id)} · ${name} · ` +
        `${player.kills}/${player.deaths}/${player.assists} · ` +
        `净值 ${formatNumber(player.net_worth)} · 补刀 ${player.last_hits}/${player.denies} · Lv${player.level}${rank}`,
      )
    }
  }
  return lines.join('\n')
}

function formatSearch(candidates) {
  if (!candidates?.length) return '没有找到匹配的玩家。'
  const lines = ['匹配到的玩家：']
  candidates.slice(0, 10).forEach((profile, index) => {
    lines.push(`${index + 1}. ${profile.personaname || '未知'} · account_id ${profile.account_id}` +
      (profile.matches_played_last_30d != null ? ` · 近30天 ${profile.matches_played_last_30d} 局` : ''))
  })
  lines.push('', '绑定：deadlock.bindid <account_id>')
  return lines.join('\n')
}

module.exports = {
  formatDate,
  formatDuration,
  formatMatchDetail,
  formatNumber,
  formatProfile,
  formatRecentMatches,
  formatSearch,
  heroName,
  outcomeText,
  rankText,
}
