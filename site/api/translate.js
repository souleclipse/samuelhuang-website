import { requireDashboardAuth } from './_dashboard-auth.js'

export const maxDuration = 60

const PRIMARY_MODEL = 'openrouter/owl-alpha'
const FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
const REQUEST_TIMEOUT_MS = 25000

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return req.body || {}
}

function extractJson(text) {
  try { return JSON.parse(text) } catch {}
  const match = String(text || '').match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }
  return null
}

async function translateWithModel(model, { input }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://samuelhuang.org',
        'X-Title': 'ENG - THAI Translator',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You translate and rewrite between English and Thai.

If the input is English, rewrite it into natural English and provide a masculine, natural Thai translation.
If the input is Thai, rewrite it into natural Thai and provide a casual, natural English translation.

Avoid unnecessary slang, formality, and over-polishing. Sound normal and clear. Keep the response straightforward, concise, and easy to read.

Return strict JSON only:
{"source_language":"english|thai|mixed|unknown","english":"...","thai":"..."}`,
          },
          { role: 'user', content: input },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1200,
      }),
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`OpenRouter ${model} returned ${res.status}`)
    const payload = await res.json()
    const parsed = extractJson(payload?.choices?.[0]?.message?.content || '')
    if (!parsed) throw new Error(`OpenRouter ${model} returned unparseable response`)
    return {
      source_language: String(parsed.source_language || 'unknown').trim(),
      english: String(parsed.english || '').trim(),
      thai: String(parsed.thai || '').trim(),
      model_used: model,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function handlePost(req, res) {
  const body = readBody(req)
  const input = String(body.input || '').trim()

  if (!input) return res.status(400).json({ error: 'Text is required' })
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY is not configured' })

  try {
    return res.status(200).json({ translation: await translateWithModel(PRIMARY_MODEL, { input }) })
  } catch {
    try {
      return res.status(200).json({ translation: await translateWithModel(FALLBACK_MODEL, { input }) })
    } catch (fallbackErr) {
      return res.status(502).json({ error: fallbackErr.message || 'Translation failed' })
    }
  }
}

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return

  if (req.method === 'POST') return handlePost(req, res)
  res.status(405).send('Method not allowed')
}
