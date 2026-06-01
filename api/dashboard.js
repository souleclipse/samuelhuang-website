import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })

  const today = new Date().toISOString().split('T')[0]

  const [scheduleRes, sessionsRes] = await Promise.all([
    supabase
      .from('samuelh_today_schedule')
      .select('*')
      .eq('date', today)
      .order('session_number'),
    supabase
      .from('samuelh_sessions')
      .select('session_number, session_name, delay_minutes, emoji, fasted, supplements, reminder_note')
      .eq('active', true)
      .order('session_number'),
  ])

  return new Response(
    JSON.stringify({
      today,
      schedule: scheduleRes.data || [],
      sessions: sessionsRes.data || [],
      hasSchedule: (scheduleRes.data || []).length > 0,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}

export const config = { runtime: 'edge' }
