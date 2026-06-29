import { createClient } from '@supabase/supabase-js'
import { requireDashboardAuth } from './_dashboard-auth.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// AI proofread + AI search call OpenRouter, which can exceed Vercel's 10s Hobby
// default. Raise the ceiling to 60s (Hobby max) so the function returns JSON
// instead of being killed into a non-JSON error page.
export const maxDuration = 60

const PROOFREAD_MODEL = 'openrouter/owl-alpha'
const PROOFREAD_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
const PROOFREAD_TIMEOUT_MS = 20000

const AI_SEARCH_MODEL = 'openrouter/owl-alpha'
const AI_SEARCH_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
const AI_SEARCH_TIMEOUT_MS = 25000
const AI_SEARCH_MAX_RESULTS = 24

const TRANSLATE_MODEL = 'openrouter/owl-alpha'
const TRANSLATE_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
const TRANSLATE_TIMEOUT_MS = 25000

// Soft-delete: deleted bookmarks sit in "Recently deleted" for this many days, then purge.
const TRASH_RETENTION_DAYS = 30

// Hard-delete anything sitting in trash past the retention window. Best-effort; ignore errors.
async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  try {
    await supabase.from('samuelh_bookmarks').delete().not('deleted_at', 'is', null).lt('deleted_at', cutoff)
  } catch {}
}

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return req.body || {}
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    url.hash = ''
    url.hostname = url.hostname.replace(/^www\./, '').toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    if (url.pathname === '/') url.pathname = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase()
  }
}

function extractJson(text) {
  try { return JSON.parse(text) } catch {}
  const match = String(text || '').match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }
  return null
}

async function proofreadWithModel(model, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROOFREAD_TIMEOUT_MS)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Proofread bookmark metadata. Keep the meaning accurate, concise, and useful for search. Do not invent facts. Return strict JSON only: {"title":"...","description":"...","notes":"...","tags":["..."]}',
          },
          {
            role: 'user',
            content: `URL: ${body.url || ''}\nTitle: ${body.title || ''}\nDescription: ${body.description || ''}\nNotes: ${body.notes || ''}\nTags: ${(body.tags || []).join(', ')}`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`OpenRouter ${model} returned ${res.status}`)
    const payload = await res.json()
    const parsed = extractJson(payload?.choices?.[0]?.message?.content || '')
    if (!parsed) throw new Error(`OpenRouter ${model} returned unparseable response`)
    return {
      title: String(parsed.title || body.title || '').trim(),
      description: String(parsed.description || body.description || '').trim(),
      notes: String(parsed.notes || body.notes || '').trim(),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 8) : body.tags || [],
      model_used: model,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function proofreadBookmark(body) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured')
  try {
    return await proofreadWithModel(PROOFREAD_MODEL, body)
  } catch {
    return await proofreadWithModel(PROOFREAD_FALLBACK_MODEL, body)
  }
}

function bookmarkDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function truncateText(str, n) {
  const s = String(str || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

const AI_SEARCH_SYSTEM = `You are a search assistant for a personal bookmark library. You are given the user's natural-language query and a numbered list of bookmarks. Pick the bookmarks that best satisfy the query, matching on meaning and intent — not just exact keywords (e.g. "facebook account" should match listings about buying Facebook ad accounts).

Return STRICT JSON only, no prose:
{"ids":[<numbers, best match first, max ${AI_SEARCH_MAX_RESULTS}>],"answer":"<one or two sentence summary of what you found, or that nothing matched>"}

Rules:
- ids are the leading numbers of the matching bookmarks.
- Order ids from most to least relevant.
- If nothing is a reasonable match, return "ids":[] and say so in answer.
- Never invent bookmarks or numbers that are not in the list.`

async function aiSearchWithModel(model, query, corpus) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AI_SEARCH_TIMEOUT_MS)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://samuelhuang.org',
        'X-Title': 'Bookmark AI Search',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: AI_SEARCH_SYSTEM },
          { role: 'user', content: `Query: ${query}\n\nBookmarks:\n${corpus}` },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 700,
      }),
    })
    if (!res.ok) throw new Error(`OpenRouter ${model} returned ${res.status}`)
    const payload = await res.json()
    const parsed = extractJson(payload?.choices?.[0]?.message?.content || '')
    if (!parsed) throw new Error(`OpenRouter ${model} returned unparseable response`)
    return parsed
  } finally {
    clearTimeout(timeout)
  }
}

async function handleAiSearch(req, res, body) {
  const query = String(body.query || '').trim()
  if (!query) return res.status(400).json({ error: 'query is required' })
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI search is not configured' })

  const { data, error } = await supabase
    .from('samuelh_bookmarks')
    .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })

  const bookmarks = data || []
  if (!bookmarks.length) return res.status(200).json({ bookmarks: [], answer: 'No bookmarks to search yet.', model_used: AI_SEARCH_MODEL })

  const corpus = bookmarks.map((b, i) => {
    const parts = [
      truncateText(b.title || bookmarkDomain(b.url) || b.url, 90),
      bookmarkDomain(b.url),
      (b.tags && b.tags.length) ? `tags: ${b.tags.slice(0, 8).join(', ')}` : '',
      b.collection?.name ? `folder: ${b.collection.name}` : '',
      truncateText(b.description || b.notes, 140),
    ].filter(Boolean)
    return `[${i}] ${parts.join(' — ')}`
  }).join('\n')

  let parsed
  let modelUsed = AI_SEARCH_MODEL
  try {
    parsed = await aiSearchWithModel(AI_SEARCH_MODEL, query, corpus)
  } catch {
    try {
      modelUsed = AI_SEARCH_FALLBACK_MODEL
      parsed = await aiSearchWithModel(AI_SEARCH_FALLBACK_MODEL, query, corpus)
    } catch (err) {
      return res.status(502).json({ error: err.message || 'AI search failed' })
    }
  }

  const ids = Array.isArray(parsed.ids) ? parsed.ids : []
  const seen = new Set()
  const matched = []
  for (const raw of ids) {
    const idx = Number(raw)
    if (!Number.isInteger(idx) || idx < 0 || idx >= bookmarks.length || seen.has(idx)) continue
    seen.add(idx)
    matched.push(bookmarks[idx])
    if (matched.length >= AI_SEARCH_MAX_RESULTS) break
  }

  return res.status(200).json({
    bookmarks: matched,
    answer: String(parsed.answer || '').trim() || (matched.length ? 'Here are the closest matches.' : 'No bookmarks matched that query.'),
    model_used: modelUsed,
  })
}

async function translateWithModel(model, input) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS)
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

If the input is English, always rewrite it into proper, natural English first, then provide a masculine, natural Thai translation. Fix grammar, casing, missing subjects, missing verbs, and casual shorthand while keeping the meaning. Do not simply echo fragmentary English back.
If the input is Thai, rewrite it into natural Thai and provide a casual, natural English translation.

Examples:
- "doing what?" -> English: "What are you doing?"
- "you go where" -> English: "Where are you going?"
- "i no have work tomorrow" -> English: "I do not have work tomorrow."

Avoid unnecessary slang, formality, and over-polishing. Sound normal and clear. Keep the response straightforward, concise, and easy to read.
Also provide a simple readable romanization for the Thai line, similar to "Phrùng nī̂ mī ngān mậy?". Put only Latin characters and tone marks in the romanization, not Thai script.

Return strict JSON only:
{"source_language":"english|thai|mixed|unknown","english":"...","thai":"...","thai_romanization":"..."}`,
          },
          { role: 'user', content: input },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1200,
      }),
    })
    if (!res.ok) throw new Error(`OpenRouter ${model} returned ${res.status}`)
    const payload = await res.json()
    const parsed = extractJson(payload?.choices?.[0]?.message?.content || '')
    if (!parsed) throw new Error(`OpenRouter ${model} returned unparseable response`)
    return {
      source_language: String(parsed.source_language || 'unknown').trim(),
      english: String(parsed.english || '').trim(),
      thai: String(parsed.thai || '').trim(),
      thai_romanization: String(parsed.thai_romanization || '').trim(),
      model_used: model,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function handleTranslate(req, res, body) {
  const input = String(body.input || '').trim()
  if (!input) return res.status(400).json({ error: 'Text is required' })
  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'Translation is not configured' })

  try {
    return res.status(200).json({ translation: await translateWithModel(TRANSLATE_MODEL, input) })
  } catch {
    try {
      return res.status(200).json({ translation: await translateWithModel(TRANSLATE_FALLBACK_MODEL, input) })
    } catch (err) {
      return res.status(502).json({ error: err.message || 'Translation failed' })
    }
  }
}

async function handleGet(req, res) {
  const { collection, q, tag, favorite, id } = req.query

  // "Frequently used prompts" tab: reusable clipboard snippets, own table.
  if (req.query.resource === 'prompts') {
    const { data, error } = await supabase
      .from('samuelh_prompts')
      .select('id,name,body,sort_order')
      .order('sort_order', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ prompts: data || [] })
  }

  if (id) {
    const { data, error } = await supabase
      .from('samuelh_bookmarks')
      .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
      .eq('id', id)
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({ bookmark: data })
  }

  // "Recently deleted" view: only soft-deleted bookmarks, newest-deleted first.
  if (req.query.trash === '1' || req.query.trash === 'true') {
    await purgeExpiredTrash()
    const { data, error } = await supabase
      .from('samuelh_bookmarks')
      .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ bookmarks: data || [], retention_days: TRASH_RETENTION_DAYS })
  }

  let query = supabase
    .from('samuelh_bookmarks')
    .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (collection === '__inbox') {
    query = query.is('collection_id', null)
  } else if (collection) {
    const { data: col } = await supabase
      .from('samuelh_bookmark_collections')
      .select('id')
      .eq('slug', collection)
      .maybeSingle()
    if (!col) return res.status(200).json({ bookmarks: [] })
    query = query.eq('collection_id', col.id)
  }

  if (favorite === '1' || favorite === 'true') query = query.eq('is_favorite', true)
  if (tag) query = query.contains('tags', [tag])
  if (q) {
    // Match every word (AND), each word may appear in title/description/url/notes.
    const terms = String(q).split(/\s+/).map((t) => t.trim()).filter(Boolean)
    for (const term of terms) {
      const safe = term.replace(/[%,]/g, ' ')
      query = query.or(`title.ilike.%${safe}%,description.ilike.%${safe}%,url.ilike.%${safe}%,notes.ilike.%${safe}%`)
    }
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  res.status(200).json({ bookmarks: data || [] })
}

async function resolveCollectionId(slugOrId) {
  if (!slugOrId || slugOrId === '__inbox') return null
  const byId = await supabase.from('samuelh_bookmark_collections').select('id').eq('id', slugOrId).maybeSingle()
  if (byId.data) return byId.data.id
  const bySlug = await supabase.from('samuelh_bookmark_collections').select('id').eq('slug', slugOrId).maybeSingle()
  return bySlug.data?.id || null
}

async function handleReorder(req, res, body) {
  const ids = body.reorder
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'reorder must be a non-empty array' })
  await Promise.all(ids.map((id, i) =>
    supabase.from('samuelh_bookmarks').update({ sort_order: (i + 1) * 10 }).eq('id', id)
  ))
  return res.status(200).json({ ok: true })
}

async function handlePromptReorder(req, res, body) {
  const ids = body.promptReorder
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'promptReorder must be a non-empty array' })
  await Promise.all(ids.map((id, i) =>
    supabase.from('samuelh_prompts').update({ sort_order: (i + 1) * 10 }).eq('id', id)
  ))
  return res.status(200).json({ ok: true })
}

async function handlePromptCreate(req, res, body) {
  const name = String(body.prompt.name || '').trim()
  const text = String(body.prompt.body || '').trim()
  if (!name) return res.status(400).json({ error: 'name is required' })
  if (!text) return res.status(400).json({ error: 'body is required' })

  const { data: maxRow } = await supabase
    .from('samuelh_prompts')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const newSortOrder = ((maxRow?.sort_order || 0) + 10)

  const { data, error } = await supabase
    .from('samuelh_prompts')
    .insert({ name, body: text, sort_order: newSortOrder })
    .select('id,name,body,sort_order')
    .single()
  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ prompt: data })
}

async function handlePost(req, res) {
  const body = readBody(req)
  if (body.reorder) return handleReorder(req, res, body)
  if (body.promptReorder) return handlePromptReorder(req, res, body)
  if (body.prompt) return handlePromptCreate(req, res, body)
  if (body.aiSearch) return handleAiSearch(req, res, body)
  if (body.translate) return handleTranslate(req, res, body)
  if (body.proofread) {
    try {
      const proofread = await proofreadBookmark({
        url: body.url,
        title: body.title,
        description: body.description,
        notes: body.notes,
        tags: Array.isArray(body.tags) ? body.tags : [],
      })
      return res.status(200).json({ proofread })
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not proofread bookmark' })
    }
  }

  const url = String(body.url || '').trim()
  if (!url) return res.status(400).json({ error: 'url is required' })

  const collectionId = await resolveCollectionId(body.collection)

  const { data: existingRows, error: existingError } = await supabase
    .from('samuelh_bookmarks')
    .select('id,url,title,description,favicon_url,collection_id,tags,notes,is_favorite,source,sort_order,created_at,updated_at,deleted_at,collection:samuelh_bookmark_collections(slug,name,icon)')
  if (existingError) return res.status(500).json({ error: existingError.message })

  const normalizedInput = normalizeUrl(url)
  const duplicate = (existingRows || []).find((row) => normalizeUrl(row.url) === normalizedInput)
  if (duplicate) {
    // Re-adding a URL that's sitting in the trash restores it instead of erroring.
    if (duplicate.deleted_at) {
      const { data: restored, error: restoreErr } = await supabase
        .from('samuelh_bookmarks')
        .update({ deleted_at: null, updated_at: new Date().toISOString() })
        .eq('id', duplicate.id)
        .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
        .single()
      if (restoreErr) return res.status(500).json({ error: restoreErr.message })
      return res.status(200).json({ bookmark: restored, restored: true })
    }
    return res.status(200).json({ bookmark: duplicate, duplicate: true })
  }

  const { data: minRow } = await supabase
    .from('samuelh_bookmarks')
    .select('sort_order')
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle()
  const newSortOrder = minRow ? Math.max(0, (minRow.sort_order || 0) - 10) : 0

  const { data, error } = await supabase
    .from('samuelh_bookmarks')
    .insert({
      url,
      title: body.title || null,
      description: body.description || null,
      favicon_url: body.favicon_url || null,
      collection_id: collectionId,
      tags: Array.isArray(body.tags) ? body.tags : [],
      notes: body.notes || body.description || null,
      is_favorite: Boolean(body.is_favorite),
      source: 'manual',
      sort_order: newSortOrder,
    })
    .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json({ bookmark: data })
}

async function handlePatch(req, res) {
  const body = readBody(req)

  // Frequently used prompts: update name/body.
  if (body.promptId) {
    const updates = { updated_at: new Date().toISOString() }
    if (body.name !== undefined) updates.name = String(body.name || '').trim()
    if (body.body !== undefined) updates.body = String(body.body || '').trim()
    const { data, error } = await supabase
      .from('samuelh_prompts')
      .update(updates)
      .eq('id', body.promptId)
      .select('id,name,body,sort_order')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ prompt: data })
  }

  const id = body.id
  if (!id) return res.status(400).json({ error: 'id is required' })

  const updates = { updated_at: new Date().toISOString() }
  // Restore from "Recently deleted".
  if (body.restore) updates.deleted_at = null
  if (body.url !== undefined) updates.url = String(body.url || '').trim()
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.notes !== undefined) updates.notes = body.notes
  if (body.tags !== undefined) updates.tags = Array.isArray(body.tags) ? body.tags : []
  if (body.is_favorite !== undefined) updates.is_favorite = Boolean(body.is_favorite)
  if (body.collection !== undefined) updates.collection_id = await resolveCollectionId(body.collection)

  const { data, error } = await supabase
    .from('samuelh_bookmarks')
    .update(updates)
    .eq('id', id)
    .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(200).json({ bookmark: data })
}

async function handleDelete(req, res) {
  const body = readBody(req)

  // Frequently used prompts: hard delete (lightweight, no trash).
  if (body.promptId) {
    const { error } = await supabase.from('samuelh_prompts').delete().eq('id', body.promptId)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  const id = body.id || req.query.id
  if (!id) return res.status(400).json({ error: 'id is required' })

  // purge=1 hard-deletes (used by "Delete forever" in the trash view). Default is soft-delete.
  const purge = body.purge === true || req.query.purge === '1'
  if (purge) {
    const { error } = await supabase.from('samuelh_bookmarks').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, purged: true })
  }

  const { error } = await supabase
    .from('samuelh_bookmarks')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(200).json({ ok: true, soft_deleted: true })
}

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return

  if (req.method === 'GET') return handleGet(req, res)
  if (req.method === 'POST') return handlePost(req, res)
  if (req.method === 'PATCH') return handlePatch(req, res)
  if (req.method === 'DELETE') return handleDelete(req, res)

  res.status(405).send('Method not allowed')
}
