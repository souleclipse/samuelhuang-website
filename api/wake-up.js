import { createClient } from '@supabase/supabase-js'
import { verifyKey } from 'discord-interactions'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Time parsing ────────────────────────────────────────────────────────────

function parseWakeTime(text) {
  const lower = text.toLowerCase().replace(/[.,!?]/g, '')

  // Patterns: "10:30am", "10:30", "1030", "10am", "10 am"
  const match = lower.match(/\b(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?\b/)
  if (!match) return new Date() // fallback to now

  let h = parseInt(match[1])
  const m = parseInt(match[2] || '0')
  const ampm = match[3]

  if (ampm === 'pm' && h < 12) h += 12
  else if (ampm === 'am' && h === 12) h = 0
  else if (!ampm && h >= 1 && h <= 6) h += 12 // ambiguous hour 1–6 → assume PM

  const t = new Date()
  t.setHours(h, m, 0, 0)
  return t
}

function fmt(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: process.env.TZ || 'Asia/Kuala_Lumpur',
  })
}

// ── Schedule logic ──────────────────────────────────────────────────────────

async function buildAndSaveSchedule(wakeTime) {
  const { data: sessions, error } = await supabase
    .from('samuelh_sessions')
    .select('*')
    .eq('active', true)
    .order('session_number')

  if (error) throw new Error(`Supabase read failed: ${error.message}`)

  const today = new Date().toISOString().split('T')[0]

  // Wipe today's old schedule (idempotent re-runs)
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

  const { error: insertError } = await supabase.from('samuelh_today_schedule').insert(rows)
  if (insertError) throw new Error(`Supabase insert failed: ${insertError.message}`)

  return sessions.map((s, i) => ({ ...s, scheduledTime: new Date(rows[i].scheduled_time) }))
}

// ── Message formatting ──────────────────────────────────────────────────────

function buildMessage(wakeTime, schedule) {
  const lines = [`📋 **Schedule locked — wake: ${fmt(wakeTime)}**\n`]

  for (const s of schedule) {
    const time = fmt(s.scheduledTime)
    const tag = s.fasted ? ' _(fasted)_' : ''
    lines.push(`${s.emoji} **${time}** — ${s.session_name}${tag}`)

    if (s.supplements?.length) {
      lines.push(`   ${s.supplements.map((x) => x.name).join(' · ')}`)
    }
    if (s.reminder_note) {
      lines.push(`   ↳ _${s.reminder_note}_`)
    }
  }

  return lines.join('\n')
}

// ── Outbound senders ────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    }
  )
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

// ── Discord signature verification ─────────────────────────────────────────

async function verifyDiscordRequest(req) {
  const sig = req.headers.get('x-signature-ed25519')
  const ts = req.headers.get('x-signature-timestamp')
  if (!sig || !ts || !process.env.DISCORD_APP_PUBLIC_KEY) return false
  const body = await req.text()
  return verifyKey(body, sig, ts, process.env.DISCORD_APP_PUBLIC_KEY)
}

// ── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let text = ''
  let isDiscordInteraction = false

  const sig = req.headers.get('x-signature-ed25519')

  if (sig) {
    // Discord Interactions endpoint
    const valid = await verifyDiscordRequest(req.clone())
    if (!valid) return new Response('Unauthorized', { status: 401 })

    const body = await req.json()

    // Discord PING (required during setup)
    if (body.type === 1) {
      return new Response(JSON.stringify({ type: 1 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Slash command: /woke [time]
    const timeOption = body.data?.options?.find((o) => o.name === 'time')
    text = timeOption?.value || body.data?.options?.[0]?.value || 'now'
    isDiscordInteraction = true
  } else {
    // Telegram webhook
    const body = await req.json()
    text = body?.message?.text || ''
  }

  // Must contain a wake-up trigger word or time
  const triggers = ['gm', 'good morning', 'woke', 'wake', 'morning', 'up']
  const hasTrigger = triggers.some((t) => text.toLowerCase().includes(t))
  const hasTime = /\b\d{1,2}[:.]?\d{0,2}\s*(am|pm)?\b/i.test(text)

  if (!hasTrigger && !hasTime && !isDiscordInteraction) {
    return new Response('OK', { status: 200 }) // Ignore unrelated Telegram messages
  }

  try {
    const wakeTime = parseWakeTime(text)
    const schedule = await buildAndSaveSchedule(wakeTime)
    const message = buildMessage(wakeTime, schedule)

    // Always fire to Telegram
    await sendTelegram(message)

    if (isDiscordInteraction) {
      // Reply directly to Discord slash command interaction
      return new Response(
        JSON.stringify({ type: 4, data: { content: message } }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    } else {
      // Telegram was the source; also send to Discord webhook
      await sendDiscordMessage(message)
      return new Response('OK', { status: 200 })
    }
  } catch (err) {
    console.error('wake-up error:', err)
    const errMsg = `❌ Error building schedule: ${err.message}`
    await sendTelegram(errMsg).catch(() => {})
    if (isDiscordInteraction) {
      return new Response(
        JSON.stringify({ type: 4, data: { content: errMsg } }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    return new Response('Error', { status: 500 })
  }
}

export const config = { runtime: 'edge' }
