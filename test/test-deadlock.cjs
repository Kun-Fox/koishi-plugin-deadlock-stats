'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DeadlockApi } = require('../lib/api')
const {
  formatMatchDetail,
  formatProfile,
  formatRecentMatches,
} = require('../lib/format')
const { BindingStore } = require('../lib/store')
const plugin = require('../lib/index')

const TEST_PLAYER = process.env.DEADLOCK_TEST_PLAYER || 'Shroud'

async function testApi() {
  const api = new DeadlockApi({ timeout: 30000, retries: 1 })
  const player = await api.resolvePlayer(TEST_PLAYER)
  assert.ok(player.account_id > 0, 'resolvePlayer should return account_id')
  assert.ok(player.personaname, 'resolvePlayer should return personaname')

  const overview = await api.getPlayerOverview(player.account_id, { limit: 5 })
  assert.ok(overview.history.length > 0, 'history should not be empty')
  assert.ok(overview.recent.length <= 5, 'recent should respect limit')
  assert.ok(overview.summary.total > 0, 'summary should count matches')

  const [heroMap, rankMap] = await Promise.all([api.getHeroMap(), api.getRankMap()])
  assert.ok(heroMap.size > 0, 'hero map should not be empty')
  assert.ok(rankMap.size > 0, 'rank map should not be empty')

  const profileText = formatProfile({ ...overview, profile: overview.profile || player }, { heroMap, rankMap })
  assert.match(profileText, /段位：/)
  const recentText = formatRecentMatches(overview.history, { heroMap, limit: 3 })
  assert.match(recentText, /最近 3 局/)

  const detail = await api.getMatchDetail(overview.recent[0].match_id)
  assert.equal(detail.players.length, 12, 'a standard match should have 12 players')
  const matchText = formatMatchDetail(detail, { rankMap })
  assert.match(matchText, /胜利方：Team/)
}

async function testStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadlock-store-'))
  const store = new BindingStore(path.join(dir, 'bindings.json'))
  const session = { platform: 'qq', userId: '42' }
  assert.equal(await store.get(session), null)
  await store.set(session, { accountId: 950062689, personaName: 'Shroud' })
  const binding = await store.get(session)
  assert.equal(binding.accountId, 950062689)
  assert.equal(binding.personaName, 'Shroud')
  assert.equal(await store.delete(session), true)
  assert.equal(await store.get(session), null)
  fs.rmSync(dir, { recursive: true, force: true })
}

async function testPlugin() {
  const handlers = {}
  const command = (name) => ({
    alias() { return this },
    usage() { return this },
    action(fn) { handlers[name] = fn; return this },
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadlock-plugin-'))
  const ctx = {
    baseDir: dir,
    command,
    logger: () => ({ warn: () => {}, info: () => {} }),
    on: () => {},
  }
  plugin.apply(ctx, { bindingsFile: 'bindings.json', recentLimit: 2, cooldown: 0 })
  const session = { platform: 'qq', userId: 'test-user' }
  const call = async (prefix, ...args) => {
    const key = Object.keys(handlers).find((name) => name.startsWith(prefix))
    assert.ok(key, `missing command ${prefix}`)
    return handlers[key]({ session }, ...args)
  }

  const bound = await call('deadlock.bind', TEST_PLAYER)
  assert.match(bound, /已绑定/)
  const whoami = await call('deadlock.whoami')
  assert.match(whoami, /当前绑定/)
  const profile = await call('deadlock.profile')
  assert.match(profile, /玩家：/)
  const recent = await call('deadlock.recent', 2)
  assert.match(recent, /最近 2 局/)
  const match = await call('deadlock.match', 131620367)
  assert.match(match, /比赛 #131620367/)
  const unbound = await call('deadlock.unbind')
  assert.match(unbound, /已解除绑定/)

  fs.rmSync(dir, { recursive: true, force: true })
}

;(async () => {
  await testStore()
  await testApi()
  await testPlugin()
  console.log('deadlock-stats tests passed')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
