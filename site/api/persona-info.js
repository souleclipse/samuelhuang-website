import { requireDashboardAuth } from './_dashboard-auth.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed')
  if (!requireDashboardAuth(req, res)) return

  res.status(200).json({
    name: process.env.PERSONA_NAME || '',
    phone: process.env.PERSONA_PHONE || '',
    address: process.env.PERSONA_ADDRESS || '',
  })
}
