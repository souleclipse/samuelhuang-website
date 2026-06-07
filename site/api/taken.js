import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function getPin(req) {
  return req.headers['x-samuel-os-pin'] || req.headers['x-dashboard-pin'] || req.body?.pin || ''
}

function requireDashboardPin(req, res) {
  const expected = process.env.SAMUEL_OS_PIN || process.env.DASHBOARD_PIN || ''
  if (!expected) return true
  if (getPin(req) === expected) return true
  res.status(401).json({ error: 'PIN required' })
  return false
}

async function updateScheduleRow(id, values) {
  return supabase
    .from('samuelh_today_schedule')
    .update(values)
    .eq('id', id)
    .select('*')
    .single()
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')
  if (!requireDashboardPin(req, res)) return

  const { id, taken = true } = req.body || {}
  if (!id) return res.status(400).json({ error: 'Missing schedule row id' })

  const takenAt = taken ? new Date().toISOString() : null
  let result = await updateScheduleRow(id, { sent: Boolean(taken), taken_at: takenAt })

  if (result.error && /taken_at|column/i.test(result.error.message || '')) {
    result = await updateScheduleRow(id, { sent: Boolean(taken) })
  }

  if (result.error) return res.status(500).json({ error: result.error.message })

  res.status(200).json({
    ok: true,
    row: result.data,
    takenAt,
  })
}
