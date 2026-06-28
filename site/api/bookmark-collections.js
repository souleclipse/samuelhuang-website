import { createClient } from '@supabase/supabase-js'
import { requireDashboardAuth } from './_dashboard-auth.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return
  if (req.method === 'POST') return handlePost(req, res)
  if (req.method === 'PATCH') return handlePatch(req, res)
  if (req.method === 'DELETE') return handleDelete(req, res)
  if (req.method !== 'GET') return res.status(405).send('Method not allowed')

  const [collectionsRes, countsRes] = await Promise.all([
    supabase
      .from('samuelh_bookmark_collections')
      .select('id,slug,name,icon,sort_order,parent_id')
      .order('sort_order'),
    supabase
      .from('samuelh_bookmarks')
      .select('collection_id')
      .is('deleted_at', null),
  ])

  if (collectionsRes.error) return res.status(500).json({ error: collectionsRes.error.message })
  if (countsRes.error) return res.status(500).json({ error: countsRes.error.message })

  const counts = new Map()
  let inboxCount = 0
  for (const row of countsRes.data || []) {
    if (!row.collection_id) {
      inboxCount += 1
      continue
    }
    counts.set(row.collection_id, (counts.get(row.collection_id) || 0) + 1)
  }

  const flat = (collectionsRes.data || []).map((c) => ({
    ...c,
    count: counts.get(c.id) || 0,
  }))

  // Build nested tree: parent collections contain a `children` array
  const byId = new Map(flat.map((c) => [c.id, { ...c, children: [] }]))
  const roots = []
  for (const c of byId.values()) {
    if (c.parent_id && byId.has(c.parent_id)) {
      byId.get(c.parent_id).children.push(c)
      // Roll sub-count up to parent
      byId.get(c.parent_id).count += c.count
    } else {
      roots.push(c)
    }
  }

  const inbox = {
    id: '__inbox',
    slug: '__inbox',
    name: 'Inbox',
    icon: '📥',
    sort_order: -1,
    parent_id: null,
    count: inboxCount,
    children: [],
  }
  const hasRealInbox = flat.some((c) => c.slug === 'inbox')

  res.status(200).json({
    collections: hasRealInbox ? roots : [inbox, ...roots],
    flat: hasRealInbox ? flat : [inbox, ...flat],
    total: (countsRes.data || []).length,
  })
}

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return req.body || {}
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'folder'
}

async function resolveParentId(parent) {
  if (!parent || parent === '__inbox') return null
  const byId = await supabase.from('samuelh_bookmark_collections').select('id').eq('id', parent).maybeSingle()
  if (byId.data) return byId.data.id
  const bySlug = await supabase.from('samuelh_bookmark_collections').select('id').eq('slug', parent).maybeSingle()
  return bySlug.data?.id || null
}

async function handleReorder(req, res, ids) {
  const clean = ids.filter((id) => id && id !== '__inbox')
  if (!clean.length) return res.status(400).json({ error: 'reorder must be a non-empty array of folder ids' })
  const results = await Promise.all(clean.map((id, i) =>
    supabase.from('samuelh_bookmark_collections').update({ sort_order: (i + 1) * 10 }).eq('id', id)
  ))
  const failed = results.find((r) => r.error)
  if (failed) return res.status(500).json({ error: failed.error.message })
  return res.status(200).json({ ok: true, reordered: clean.length })
}

async function handlePost(req, res) {
  const body = readBody(req)
  if (Array.isArray(body.reorder)) return handleReorder(req, res, body.reorder)
  const name = String(body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Folder name is required' })
  const icon = String(body.icon || '').trim() || '📁'
  const parentId = await resolveParentId(body.parent ?? body.parent_id)

  // Build a unique slug.
  const { data: existing, error: existingError } = await supabase
    .from('samuelh_bookmark_collections')
    .select('slug,sort_order')
  if (existingError) return res.status(500).json({ error: existingError.message })
  const used = new Set((existing || []).map((c) => c.slug))
  const base = slugify(name)
  let slug = base
  let n = 2
  while (used.has(slug)) slug = `${base}-${n++}`

  const maxSort = (existing || []).reduce((m, c) => Math.max(m, c.sort_order || 0), 0)

  const { data, error } = await supabase
    .from('samuelh_bookmark_collections')
    .insert({ slug, name, icon, parent_id: parentId, sort_order: maxSort + 1 })
    .select('id,slug,name,icon,sort_order,parent_id')
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json({ collection: data })
}

async function collectDescendantIds(id) {
  const { data, error } = await supabase
    .from('samuelh_bookmark_collections')
    .select('id,parent_id')
  if (error) throw error

  const childrenByParent = new Map()
  for (const row of data || []) {
    if (!row.parent_id) continue
    const children = childrenByParent.get(row.parent_id) || []
    children.push(row.id)
    childrenByParent.set(row.parent_id, children)
  }

  const ids = [id]
  for (let i = 0; i < ids.length; i += 1) {
    for (const childId of childrenByParent.get(ids[i]) || []) ids.push(childId)
  }
  return ids
}

async function handlePatch(req, res) {
  const body = readBody(req)
  const id = body.id
  if (!id || id === '__inbox') return res.status(400).json({ error: 'A real folder id is required' })

  const updates = {}
  if (body.name !== undefined) updates.name = String(body.name || '').trim()
  if (body.icon !== undefined) updates.icon = String(body.icon || '').trim() || '📁'
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updates provided' })
  if (updates.name === '') return res.status(400).json({ error: 'Folder name is required' })

  const { data, error } = await supabase
    .from('samuelh_bookmark_collections')
    .update(updates)
    .eq('id', id)
    .select('id,slug,name,icon,sort_order,parent_id')
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(200).json({ collection: data })
}

async function handleDelete(req, res) {
  const body = readBody(req)
  const id = body.id || req.query.id
  if (!id || id === '__inbox') return res.status(400).json({ error: 'A real folder id is required' })

  let ids
  try {
    ids = await collectDescendantIds(id)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }

  const moveRes = await supabase
    .from('samuelh_bookmarks')
    .update({ collection_id: null, updated_at: new Date().toISOString() })
    .in('collection_id', ids)
  if (moveRes.error) return res.status(500).json({ error: moveRes.error.message })

  const { error } = await supabase
    .from('samuelh_bookmark_collections')
    .delete()
    .eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  res.status(200).json({ ok: true, moved_to_inbox: true, deleted_ids: ids })
}
