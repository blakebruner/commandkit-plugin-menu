/**
 * Stand-ins for a real database and a real music player, so the example runs without either.
 * In a real bot, `load()` in each menu would read from Prisma/Mongo/Lavalink instead.
 */

export interface Ticket {
  id: string
  channelId: string
  openedBy: string
  status: "open" | "claimed" | "closed"
  claimedBy: string | null
  notes: string[]
}

export const tickets = new Map<string, Ticket>()

export interface Track {
  id: string
  title: string
  requestedBy: string
}

const queues = new Map<string, { current: Track | null; upcoming: Track[] }>()

export function getQueue(guildId: string) {
  let queue = queues.get(guildId)
  if (!queue) {
    queue = { current: null, upcoming: [] }
    queues.set(guildId, queue)
  }
  return queue
}

let trackCounter = 0
export function nextTrackId() {
  return `t${++trackCounter}`
}
