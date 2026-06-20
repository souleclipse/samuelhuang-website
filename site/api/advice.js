import { requireDashboardAuth } from './_dashboard-auth.js'
import {
  buildAdviceDatabase,
  compactMatches,
  contextForMatches,
  rankAdviceRecords,
  readAdviceArchive,
} from './_advice-db.js'
import { SPECIAL } from './_special-content.js'

const SYSTEM_PROMPT = `You are the private AI Search Advice assistant for samuelhuang.org/advice.

You answer using only the provided ADVICE DATABASE context extracted from the user's paid Slack community archive.

Rules:
- Be practical and direct. Prefer step-by-step actions when the user asks how to do something.
- Cite only the best one or two database records with bracket numbers like [1], [2].
- Prefer one citation. Add a second citation only when it materially changes the answer.
- Explain what is synthesized advice versus what was directly shared in Slack source summaries.
- Include only the most useful source lookup detail: channel, date, started-by person, and the best Slack search phrase.
- Do not provide a long list of alternative source searches.
- Do not invent sources, people, dates, links, or test results.
- Do not output raw Slack dumps, private Slack permalinks, Slack file URLs, Slack user IDs, or Slack-wide broadcast handles.
- If the archive does not contain enough evidence, say what is missing and suggest a small test.
- Member names may be used because this is a private authenticated page, but keep the answer concise.`

function lastUserQuestion(messages) {
  const last = [...messages].reverse().find((message) => message?.role === 'user' && message?.content)
  return String(last?.content || '').slice(0, 1200)
}

function cleanMessages(messages) {
  return messages
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .slice(-8)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 2000) }))
}

function fallbackAnswer(question, matches) {
  if (!matches.length) {
    return `I could not find a strong match in the saved advice database for "${question}". Try searching by a tool name, channel, member name, or phrase from Slack.`
  }

  const top = matches.slice(0, 2)
  return [
    `I found ${top.length} relevant database record${top.length === 1 ? '' : 's'} for "${question}". Owl Alpha is not configured or did not return an answer, so this is the deterministic fallback.`,
    '',
    ...top.map((match, index) => {
      const source = match.sourceRefs[0]
      const lookup = source ? ` Source: #${source.channel}, ${source.date}, started by ${source.startedBy}.` : ''
      return `[${index + 1}] ${match.title}: ${match.text.split('\n').slice(0, 5).join(' ')}${lookup}`
    }),
  ].join('\n')
}

function distinctSourceMatches(matches, limit = 2) {
  const seenSources = new Set()
  const seenTitles = new Set()
  const distinct = []
  const bestScore = Number(matches[0]?.score || 0)

  for (const match of matches) {
    if (distinct.length > 0 && bestScore && Number(match.score || 0) < bestScore * 0.8) continue
    const sourceKey = match.sourceRefs?.[0]?.id || ''
    const titleKey = String(match.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (sourceKey && seenSources.has(sourceKey)) continue
    if (titleKey && seenTitles.has(titleKey)) continue
    if (sourceKey) seenSources.add(sourceKey)
    if (titleKey) seenTitles.add(titleKey)
    distinct.push(match)
    if (distinct.length >= limit) break
  }

  return distinct
}

async function answerFromAdviceDatabase(messages) {
  const question = lastUserQuestion(messages)
  if (!question) return { status: 400, body: { error: 'user question required' } }

  const archive = await readAdviceArchive()
  const database = buildAdviceDatabase(archive)
  const matches = rankAdviceRecords(database, question, 6)
  const answerMatches = distinctSourceMatches(matches, 2)
  const citations = compactMatches(answerMatches)
  const context = contextForMatches(answerMatches, 9000)

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return {
      status: 200,
      body: {
        answer: fallbackAnswer(question, answerMatches),
        citations,
        database: database.counts,
        model: 'deterministic-fallback',
      },
    }
  }

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://samuelhuang.org/advice',
      'X-Title': 'AI Search Advice Database',
    },
    body: JSON.stringify({
      model: 'openrouter/owl-alpha',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `ADVICE DATABASE CONTEXT\n${context || 'No matching database records found.'}\n\nCurrent user question: ${question}`,
        },
        ...cleanMessages(messages),
      ],
      max_tokens: 1400,
    }),
  })

  const data = await upstream.json()
  if (!upstream.ok) {
    return {
      status: 200,
      body: {
        answer: fallbackAnswer(question, answerMatches),
        citations,
        database: database.counts,
        model: 'deterministic-fallback',
        warning: data?.error?.message || 'Owl Alpha upstream error',
      },
    }
  }

  return {
    status: 200,
    body: {
      answer: data?.choices?.[0]?.message?.content || fallbackAnswer(question, answerMatches),
      citations,
      database: database.counts,
      model: 'openrouter/owl-alpha',
    },
  }
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).send('Method not allowed')
  if (!requireDashboardAuth(req, res)) return

  try {
    if (req.method === 'GET') {
      // Serves the sensitive #secret-channel strategy content (formerly /api/special).
      if (String(req.query?.action || '') === 'special') {
        const slug = String(req.query?.slug || '')
        const html = SPECIAL[slug]
        if (!html) return res.status(404).json({ error: 'Not found' })
        return res.status(200).json({ html })
      }
      const archive = await readAdviceArchive()
      return res.status(200).json(archive)
    }

    const { messages } = req.body || {}
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' })
    }

    const result = await answerFromAdviceDatabase(messages)
    return res.status(result.status).json(result.body)
  } catch (error) {
    console.error('Advice API failed', error)
    res.status(500).json({ error: 'Could not load advice archive' })
  }
}
