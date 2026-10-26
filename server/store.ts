import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type Step = 'ask_name' | 'yesterday' | 'today' | 'blockers' | 'wrapup' | 'done'

export interface Person {
  phone: string
  name: string
}

export interface Update {
  id: string
  /** YYYY-MM-DD in the configured timezone */
  date: string
  callSid: string
  name: string
  phone: string
  yesterday: string
  today: string
  blockers: string
  complete: boolean
  createdAt: number
  updatedAt: number
}

export interface CallState {
  sid: string
  phone: string
  name: string
  step: Step
  retries: number
  updateId: string | null
  active: boolean
  startedAt: number
  updatedAt: number
}

export interface SmsRecord {
  id: string
  to: string
  body: string
  status: 'sent' | 'dry-run' | 'failed'
  detail?: string
  trigger: 'voice' | 'auto' | 'manual'
  at: number
}

interface Data {
  people: Record<string, Person>
  updates: Update[]
  calls: Record<string, CallState>
  sms: SmsRecord[]
  meta: {
    /** last time a call started or an update was written */
    lastActivityAt: number
    /** updates exist that haven't been included in a sent summary */
    dirty: boolean
    lastSummaryAt: number
  }
}

const empty = (): Data => ({
  people: {},
  updates: [],
  calls: {},
  sms: [],
  meta: { lastActivityAt: 0, dirty: false, lastSummaryAt: 0 },
})

/** Tiny JSON-file store. Single process, synchronous atomic writes. */
export class Store {
  data: Data
  file: string
  constructor(file = resolve(process.cwd(), process.env.DATA_FILE || 'data/standup.json')) {
    this.file = file
    this.data = empty()
    if (existsSync(file)) {
      try {
        this.data = { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) }
      } catch (err) {
        console.error('[david] could not read store, starting empty:', err)
      }
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
