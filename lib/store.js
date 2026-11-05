'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const EMPTY = () => ({ version: 1, bindings: {} })

function bindingKey(session) {
  const platform = session?.platform || 'unknown'
  const userId = session?.userId != null ? String(session.userId) : 'unknown'
  return `${platform}:${userId}`
}

class BindingStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.logger = options.logger
    this._data = null
    this._writeChain = Promise.resolve()
  }

  async _load() {
    if (this._data) return this._data
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      this._data = parsed && typeof parsed === 'object' && parsed.bindings
        ? parsed
        : EMPTY()
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn?.(`deadlock-stats: 读取绑定文件失败，将使用空数据：${error.message}`)
      }
      this._data = EMPTY()
    }
    return this._data
  }

  async _save(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    try {
      await fs.rename(temp, this.filePath)
    } catch {
      await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      await fs.rm(temp, { force: true })
    }
  }

  async get(session) {
    const data = await this._load()
    return data.bindings[bindingKey(session)] || null
  }

  async set(session, binding) {
    const data = await this._load()
    data.bindings[bindingKey(session)] = {
      accountId: Number(binding.accountId),
      personaName: binding.personaName || '',
      platform: session?.platform || 'unknown',
      userId: session?.userId != null ? String(session.userId) : 'unknown',
      updatedAt: new Date().toISOString(),
    }
    this._writeChain = this._writeChain.then(() => this._save(data))
    await this._writeChain
    return data.bindings[bindingKey(session)]
  }

  async delete(session) {
    const data = await this._load()
    const key = bindingKey(session)
    const existed = Boolean(data.bindings[key])
    delete data.bindings[key]
    if (existed) {
      this._writeChain = this._writeChain.then(() => this._save(data))
      await this._writeChain
    }
    return existed
  }
}

module.exports = { BindingStore, bindingKey }
