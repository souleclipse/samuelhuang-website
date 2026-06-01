import { createClient } from '@supabase/supabase-js'
import { verifyKey } from 'discord-interactions'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Time parsing ─────────────────────────────────────────────────────────────

function parseWakeTime(text) {
  const lower = (text || '').toLowerCase().replace(/[.,!?]/g, '')
  const match = lower.match(/\b(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?\b/)
  if (!match) return new Date()
  let h = parseInt(match[1])
  const m = parseInt(match[2] || '0')
  const ampm = match[3]
  if (ampm === 'pm' && h < 12) h += 12
  else if (ampm === 'am' && h === 12) h = 0
  else if (!ampm && h >= 1 && h <= 6) h += 12
  const t = new Date()
  t.setHours(h, m, 0, 0)
  return t
}

function fmtTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kuala_Lumpur',
  })
}

// ── Schedule logic ────────────────────────────────────────────────────────────

async function buildAndSaveSchedule(wakeTime) {
  const { data: sessions, error } = await supabase
    .from('samuelh_sessions')
    .select('*')
    .eq('active', true)
    .order('session_number')
  if (error) throw new Error(`Supabase read: ${error.message}`)

  const today = new Date().toISOString().split('T')[0]
  await supabase.from('samuelh_today_schedule').delete().eq('date', today)

  const rows = sessions.map((s) => ({
    date: today,
    wake_time: wakeTime.toISOString(),
    session_id: s.id,
    session_number: s.session_number,
    session_name: s.session_name,
    scheduled_time: new Date(wakeTime.getTime() + s.delay_minutes * 60000).toISOString(),
    supplements: s.supplements,
    sent: false,
  }))

  const { error: ie } = await supabase.from('samuelh_today_schedule').insert(rows)
  if (ie) throw new Error(`Supabase insert: ${ie.message}`)

  return sessions.map((s, i) => ({ ...s, scheduledTime: new Date(rows[i].scheduled_time) }))
}

function buildMessage(wakeTime, schedule) {
  const lines = [`📋 **Schedule locked — wake: ${fmtTime(wakeTime)}**\n`]
  for (const s of schedule) {
    const tag = s.fasted ? ' _(fasted)_' : ''
    lines.push(`${s.emoji} **${fmtTime(s.scheduledTime)}** — ${s.session_name}${tag}`)
    if (s.supplements?.length) lines.push(`   ${s.supplements.map((x) => x.name).join(' · ')}`)
    if (s.reminder_note) lines.push(`   ↳ _${s.reminder_note}_`)
  }
  return lines.join('\n')
}

// ── Outbound ──────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
  })
}

async function sendDiscordMessage(content) {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CHANNEL_ID) return
  await fetch(`https://discord.com/api/v10/channels/${process.env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    },
    body: JSON.stringify({ content }),
  })
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')

  let text = ''
  let isDiscordInteraction = false
  let isWebRequest = false

  const sig = req.headers['x-signature-ed25519']

  if (sig) {
    // Discord Interactions — verify signature
    const ts = req.headers['x-signature-timestamp'] || ''
    const rawBody = JSON.stringify(req.body)
    const valid = await verifyKey(rawBody, sig, ts, process.env.DISCORD_APP_PUBLIC_KEY || '')
    if (!valid) return res.status(401).send('Unauthorized')

    const body = req.body
    if (body.type === 1) return res.json({ type: 1 }) // PING

    const timeOption = body.data?.options?.find((o) => o.name === 'time')
    text = timeOption?.value || body.data?.options?.[0]?.value || 'now'
    isDiscordInteraction = true
  } else if (req.body?.source === 'web') {
    // Web dashboard POST
    text = req.body.time || 'now'
    isWebRequest = true
  } else if (req.body?.message?.text) {
    // Telegram webhook
    text = req.body.message.text
    const triggers = ['gm', 'good morning', 'woke', 'wake', 'morning']
    const hasTrigger = triggers.some((t) => text.toLowerCase().includes(t))
    const hasTime = /\b\d{1,2}[:.]?\d{0,2}\s*(am|pm)?\b/i.test(text)
    if (!hasTrigger && !hasTime) return res.status(200).send('OK')
  } else {
    return res.status(200).send('OK')
  }

  try {
    const wakeTime = parseWakeTime(text)
    const schedule = await buildAndSaveSchedule(wakeTime)
    const message = buildMessage(wakeTime, schedule)

    if (isWebRequest) {
      return res.status(200).json({ ok: true, schedule, wakeTime: wakeTime.toISOString() })
    }

    await Promise.all([sendTelegram(message), sendDiscordMessage(message)])

    if (isDiscordInteraction) {
      return res.json({ type: 4, data: { content: message } })
    }

    res.status(200).send('OK')
  } catch (err) {
    console.error('wake-up error:', err)
    const errMsg = `❌ Error: ${err.message}`
    if (isWebRequest) return res.status(500).json({ ok: false, error: errMsg })
    await Promise.all([sendTelegram(errMsg), sendDiscordMessage(errMsg)]).catch(() => {})
    if (isDiscordInteraction) return res.json({ type: 4, data: { content: errMsg } })
    res.status(500).send('Error')
  }
}
