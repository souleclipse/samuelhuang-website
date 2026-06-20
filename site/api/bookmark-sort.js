import { createClient } from '@supabase/supabase-js'
import { requireDashboardAuth } from './_dashboard-auth.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// AI research crawls a page + calls OpenRouter (with a fallback model), which can
// take far longer than Vercel's 10s Hobby default. Raise the function ceiling to
// 60s (the Hobby max) so the platform doesn't kill it mid-request and return a
// non-JSON error page. Internal timeouts below MUST stay comfortably under this.
export const maxDuration = 60

const PRIMARY_MODEL = 'openrouter/owl-alpha'
const FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
const PRIMARY_TIMEOUT_MS = 20000
const FALLBACK_TIMEOUT_MS = 20000

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return req.body || {}
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim()
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

function extractReadableText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim().slice(0, 2000)
}

async function fetchPageMetadata(url) {
  const fallback = {
    title: '',
    description: '',
    text: '',
    favicon_url: '',
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SamuelBookmarkBot/1.0)' },
    })
    clearTimeout(timeout)
    if (!res.ok) return fallback

    const html = await res.text()
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
    const ogSiteMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i)

    const hostname = new URL(url).hostname
    return {
      title: decodeEntities(ogTitleMatch?.[1] || titleMatch?.[1]) || hostname,
      description: decodeEntities(ogDescMatch?.[1] || descMatch?.[1]),
      site_name: decodeEntities(ogSiteMatch?.[1]),
      text: extractReadableText(html),
      favicon_url: `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hostname)}`,
    }
  } catch {
    try {
      const hostname = new URL(url).hostname
      return { ...fallback, title: hostname, favicon_url: `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hostname)}` }
    } catch {
      return fallback
    }
  }
}

function extractJson(text) {
  try { return JSON.parse(text) } catch {}
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }
  return null
}

async function classifyWithModel(model, timeoutMs, { url, title, description, text, siteName, context, collectionList }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Build a flat label list showing parent > child hierarchy for the AI to pick from.
    // The AI should pick the most specific slug that fits.
    const collectionLines = collectionList.map((c) => {
      const parent = c.parent_id
        ? collectionList.find((p) => p.id === c.parent_id)
        : null
      const label = parent ? `${parent.name} > ${c.name}` : c.name
      return `${c.slug} — ${label}`
    })
    const systemPrompt = `You organize bookmarks for a personal bookmark manager. Using the page content provided AND your own knowledge of the website, do FOUR jobs:\n` +
      `1. SORT: pick the MOST SPECIFIC folder slug that fits (prefer a sub-folder over its parent). If nothing clearly fits, use "inbox".\n` +
      `2. DESCRIBE: write a clear, accurate description of 1–2 sentences explaining what this page/site is and why someone would save it. Rewrite in plain English — do NOT copy raw marketing or meta text. If the page content is thin (a login page, a JS app, a paywall), rely on what you already know about the site to describe it.\n` +
      `3. TAG + TITLE: give a concise human title and up to 6 short lowercase tags.\n` +
      `4. NOTES: if the user gave a note/context, return a corrected, cleaned-up version — fix spelling, casing and grammar while KEEPING their original meaning and intent (e.g. "microst offie acc" becomes "Microsoft Office account"). Do NOT add new facts or turn it into a description. If the user gave no note, return an empty string.\n\n` +
      `Available folders (slug — full path):\n${collectionLines.join('\n')}\n\n` +
      `"confidence" = how sure you are about the FOLDER choice (0.0–1.0).\n` +
      `Reply with strict JSON only: {"collection":"<slug>","title":"<concise title>","description":"<1-2 sentence rewrite>","notes":"<cleaned user note or empty>","tags":["..."],"confidence":0.0-1.0}`

    const userPrompt = `URL: ${url}\n` +
      `Site name: ${siteName || '(none)'}\n` +
      `Page title: ${title || '(none)'}\n` +
      `Meta description: ${description || '(none)'}\n` +
      `Page text (truncated): ${text || '(none)'}\n` +
      `User's own note/context: ${context || '(none)'}`

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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`OpenRouter ${model} returned ${res.status}`)

    const payload = await res.json()
    const content = payload?.choices?.[0]?.message?.content || ''
    const parsed = extractJson(content)
    if (!parsed || !parsed.collection) throw new Error(`OpenRouter ${model} returned unparseable response`)

    return {
      collection: String(parsed.collection),
      title: parsed.title ? String(parsed.title).trim() : '',
      description: parsed.description ? String(parsed.description).trim() : '',
      notes: parsed.notes ? String(parsed.notes).trim() : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 6) : [],
      confidence: Number(parsed.confidence) || 0,
      raw_response: payload,
      model_used: model,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function classify(input) {
  try {
    return await classifyWithModel(PRIMARY_MODEL, PRIMARY_TIMEOUT_MS, input)
  } catch {
    return await classifyWithModel(FALLBACK_MODEL, FALLBACK_TIMEOUT_MS, input)
  }
}

async function handlePost(req, res) {
  const body = readBody(req)
  const url = String(body.url || '').trim()
  const context = String(body.context || body.description || '').trim()
  // forcedSlug = user picked a folder in the add bar; still run AI research for
  // title/description/tags, but file it in THIS folder instead of the AI's pick.
  const forcedSlug = String(body.collection || '').trim()
  // refresh = re-research an existing bookmark: re-crawl + rewrite, return the
  // suggestion WITHOUT saving (the edit modal applies it, the user reviews + saves).
  const refresh = body.refresh === true
  if (!url) return res.status(400).json({ error: 'url is required' })
  try { new URL(url) } catch { return res.status(400).json({ error: 'Invalid URL' }) }

  if (!refresh) {
    const { data: existingRows, error: existingError } = await supabase
      .from('samuelh_bookmarks')
      .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
    if (existingError) return res.status(500).json({ error: existingError.message })
    const normalizedInput = normalizeUrl(url)
    const duplicate = (existingRows || []).find((row) => normalizeUrl(row.url) === normalizedInput)
    if (duplicate) return res.status(200).json({
      bookmark: duplicate,
      collection: duplicate.collection,
      confidence: duplicate.ai_confidence || 1,
      model_used: 'duplicate-check',
      duplicate: true,
    })
  }

  if (!process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY is not configured' })

  const { data: collectionList, error: colError } = await supabase
    .from('samuelh_bookmark_collections')
    .select('id,slug,name,icon,parent_id')
    .order('sort_order')
  if (colError) return res.status(500).json({ error: colError.message })

  const meta = await fetchPageMetadata(url)

  let classification
  try {
    classification = await classify({
      url,
      title: meta.title,
      description: meta.description,
      text: meta.text,
      siteName: meta.site_name,
      context,
      collectionList,
    })
  } catch (err) {
    classification = {
      collection: 'inbox',
      title: '',
      description: '',
      notes: '',
      tags: [],
      confidence: 0,
      raw_response: { error: String(err?.message || err) },
      model_used: 'none (classification failed)',
    }
  }

  const matched = collectionList.find((c) => c.slug === classification.collection)
  const inboxCollection = collectionList.find((c) => c.slug === 'inbox')
  let targetCollection
  if (forcedSlug && forcedSlug !== '__inbox') {
    // User chose a folder: honour it, fall back to AI pick only if the slug is unknown.
    targetCollection = collectionList.find((c) => c.slug === forcedSlug)
      || (matched && classification.confidence >= 0.4 ? matched : inboxCollection)
  } else if (forcedSlug === '__inbox') {
    targetCollection = inboxCollection
  } else {
    targetCollection = (matched && classification.confidence >= 0.4) ? matched : inboxCollection
  }

  // Prefer the AI-written description; fall back to raw meta, then the user's note.
  const description = classification.description || meta.description || context || null
  const title = classification.title || meta.title || url
  // Cleaned-up version of the user's own note (typos/casing fixed); keep raw if AI returned nothing.
  const notes = classification.notes || context || null

  // Re-research mode.
  if (refresh) {
    // save + id: persist in place (used by the bulk "Enhance blanks" runner). Description
    // is always refreshed; title/notes/tags only filled when currently blank; folder untouched.
    if (body.save === true && body.id) {
      const { data: existing, error: exErr } = await supabase
        .from('samuelh_bookmarks')
        .select('id,title,url,notes,tags')
        .eq('id', body.id)
        .maybeSingle()
      if (exErr) return res.status(500).json({ error: exErr.message })
      if (!existing) return res.status(404).json({ error: 'Bookmark not found' })

      const updates = { updated_at: new Date().toISOString() }
      if (description) updates.description = description
      const titleBlank = !existing.title || existing.title === existing.url || /^https?:\/\//i.test(existing.title)
      if (titleBlank && title) updates.title = title
      if ((!existing.notes || !String(existing.notes).trim()) && notes) updates.notes = notes
      if ((!existing.tags || existing.tags.length === 0) && classification.tags.length) updates.tags = classification.tags

      const { data: updated, error: upErr } = await supabase
        .from('samuelh_bookmarks')
        .update(updates)
        .eq('id', body.id)
        .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
        .single()
      if (upErr) return res.status(500).json({ error: upErr.message })
      return res.status(200).json({ saved: true, bookmark: updated, model_used: classification.model_used })
    }

    // Otherwise hand the rewrite back to the edit modal, don't persist.
    return res.status(200).json({
      refresh: true,
      title,
      description,
      notes,
      tags: classification.tags,
      suggested_collection: targetCollection ? { slug: targetCollection.slug, name: targetCollection.name } : null,
      confidence: classification.confidence,
      model_used: classification.model_used,
    })
  }

  const { data: bookmark, error: insertError } = await supabase
    .from('samuelh_bookmarks')
    .upsert({
      url,
      title,
      description,
      favicon_url: meta.favicon_url || null,
      collection_id: targetCollection?.id || null,
      tags: classification.tags,
      notes,
      source: 'ai-sort',
      ai_confidence: classification.confidence,
    }, { onConflict: 'url' })
    .select('*, collection:samuelh_bookmark_collections(slug,name,icon)')
    .single()

  if (insertError) return res.status(500).json({ error: insertError.message })

  const { data: historyRow, error: historyError } = await supabase
    .from('samuelh_bookmark_sort_history')
    .insert({
      bookmark_id: bookmark.id,
      url,
      model_used: classification.model_used,
      suggested_collection: classification.collection,
      confidence: classification.confidence,
      raw_response: classification.raw_response,
    })
    .select()
    .single()
  if (historyError) return res.status(500).json({ error: historyError.message })

  res.status(200).json({
    bookmark,
    collection: bookmark.collection,
    confidence: classification.confidence,
    model_used: classification.model_used,
    history: historyRow,
  })
}

async function handleGetHistory(req, res) {
  const { data, error } = await supabase
    .from('samuelh_bookmark_sort_history')
    .select('id,url,model_used,suggested_collection,confidence,created_at')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return res.status(500).json({ error: error.message })
  res.status(200).json({ history: data || [] })
}

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return

  if (req.method === 'GET' && (req.query.history === '1' || req.query.history === 'true')) return handleGetHistory(req, res)
  if (req.method === 'POST') return handlePost(req, res)

  res.status(405).send('Method not allowed')
}
