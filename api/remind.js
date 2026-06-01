import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kuala_Lumpur',
  })
}

function buildPing(row) {
  const lines = [`⏰ **${row.session_name}** — ${fmtTime(row.scheduled_time)}`]
  if (row.supplements?.length) {
    lines.push(row.supplements.map((s) => `• ${s.name}`).join('\n'))
  }
  const firstNote = row.supplements?.[0]?.notes
  if (firstNote) lines.push(`_${firstNote}_`)
  return lines.join('\n')
}

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

export default async function handler(req, res) {
  const now = new Date().toISOString()
  const today = now.split('T')[0]

  const { data: due, error } = await supabase
    .from('samuelh_today_schedule')
    .select('*')
    .eq('date', today)
    .eq('sent', false)
    .lte('scheduled_time', now)
    .order('scheduled_time')

  if (error) {
    console.error('Supabase error:', error)
    return res.status(500).json({ error: error.message })
  }

  if (!due || due.length === 0) {
    return res.status(200).json({ sent: 0 })
  }

  const sent = []
  for (const row of due) {
    const message = buildPing(row)
    await Promise.all([sendTelegram(message), sendDiscordMessage(message)])
    await supabase.from('samuelh_today_schedule').update({ sent: true }).eq('id', row.id)
    sent.push(row.session_name)
  }

  res.status(200).json({ sent: sent.length, sessions: sent })
}
