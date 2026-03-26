export const dynamic = 'force-dynamic'
export const maxDuration = 10

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { getUserIdFromToken } from '@/lib/jwt'
import {
  getCachedFeed, setCachedFeed,
  getCachedBlocked, setCachedBlocked,
  getCachedFollowing, setCachedFollowing,
} from '@/lib/redis'

type FeedFilter = 'global' | 'nearby' | 'city' | 'friends' | 'room'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)

  // Health check: /api/feed?health=1
  if (searchParams.get('health') === '1') {
    const check = (key: string) => {
      const val = process.env[key]
      return { key, set: !!val, length: val?.length ?? 0, prefix: val ? val.slice(0, 12) + '...' : '(empty)' }
    }

    // Generate REAL ImageKit auth credentials and test them
    const crypto = require('crypto')
    const pk = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim()
    const pubKey = process.env.NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY || ''
    const token = crypto.randomUUID()
    const expire = Math.floor(Date.now() / 1000) + 600

    let signatureTest = 'not tested'
    let liveTestResult = 'not tested'

    if (pk) {
      const sig = crypto.createHmac('sha1', pk).update(`${token}${expire}`).digest('hex')
      signatureTest = `OK (sig=${sig.slice(0, 10)}... token=${token.slice(0, 8)}... expire=${expire})`

      // Actually test with ImageKit API to see if signature is accepted
      try {
        const testForm = new URLSearchParams()
        testForm.append('publicKey', pubKey)
        testForm.append('signature', sig)
        testForm.append('expire', String(expire))
        testForm.append('token', token)
        testForm.append('fileName', 'test.txt')
        testForm.append('file', 'data:text/plain;base64,dGVzdA==')

        const ikRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
          method: 'POST',
          body: testForm,
        })
        const ikData = await ikRes.json()
        if (ikRes.ok) {
          liveTestResult = `SUCCESS: uploaded as ${ikData.url?.slice(0, 50)}`
        } else {
          liveTestResult = `FAIL (${ikRes.status}): ${ikData.message || JSON.stringify(ikData)}`
        }
      } catch (e: any) {
        liveTestResult = `ERROR: ${e.message}`
      }
    } else {
      signatureTest = 'FAIL: IMAGEKIT_PRIVATE_KEY is empty'
    }

    return NextResponse.json({
      status: 'ok', node: process.version,
      env: [
        check('NEXT_PUBLIC_SUPABASE_URL'), check('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
        check('SUPABASE_SERVICE_ROLE_KEY'), check('NEXT_PUBLIC_IMAGEKIT_URL'),
        check('NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY'), check('IMAGEKIT_PRIVATE_KEY'),
        check('UPSTASH_REDIS_REST_URL'), check('UPSTASH_REDIS_REST_TOKEN'),
      ],
      signatureTest, liveTestResult,
      debugInfo: { publicKeyLen: pubKey.length, privateKeyLen: pk.length, token: token.slice(0, 12), expire },
      timestamp: new Date().toISOString(),
    })
  }

  const supabase = createRouteClient()

  const filter    = (searchParams.get('filter') || 'global') as FeedFilter
  const limit     = Math.min(parseInt(searchParams.get('limit') || '20'), 30)
  const cursor    = searchParams.get('cursor') || null
  const lat       = parseFloat(searchParams.get('lat') || '0') || null
  const lng       = parseFloat(searchParams.get('lng') || '0') || null
  const cityParam = searchParams.get('city') || null
  const roomSlug  = searchParams.get('room') || null
  const seenParam = searchParams.get('seen') || ''

  // ── Auth: get user from JWT (zero DB calls) ──────────────
  const authHeader = req.headers.get('authorization')
  const authUserId = getUserIdFromToken(authHeader)  // JWT decode - no network

  let userId: string | null = null
  let userCity: string | null = null

  if (authUserId) {
    const { data: profile } = await supabase
      .from('users').select('id, city').eq('auth_id', authUserId).single()
    userId   = profile?.id   ?? null
    userCity = profile?.city ?? null
  }

  try {
    // ── Redis cache check ──────────────────────────────────
    const cacheKey = `feed:${filter}:${userId || 'anon'}:${cityParam || userCity || ''}:${cursor || ''}:v2`
    const cached = await getCachedFeed(cacheKey)
    if (cached) {
      const res = NextResponse.json(cached)
      res.headers.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=30')
      res.headers.set('X-Cache', 'HIT')
      return res
    }

    let posts: any[] = []

    // ── Setup: blocked/following with Redis caching ──────────
    let blockedIds: string[] = []
    let followingIds: string[] = []

    if (userId) {
      const [cachedBlocked, cachedFollowing] = await Promise.all([
        getCachedBlocked(userId),
        (filter === 'friends' || filter === 'global') ? getCachedFollowing(userId) : Promise.resolve(null),
      ])

      if (cachedBlocked) {
        blockedIds = cachedBlocked
      } else {
        const { data: blkData } = await supabase.from('user_blocks').select('blocked_id').eq('blocker_id', userId).limit(500)
        blockedIds = (blkData || []).map((b: any) => b.blocked_id)
        setCachedBlocked(userId, blockedIds)  // fire-and-forget
      }

      if (filter === 'friends' || filter === 'global') {
        if (cachedFollowing) {
          followingIds = cachedFollowing
        } else {
          const { data: followData } = await supabase.from('follows').select('following_id').eq('follower_id', userId).limit(1000)
          followingIds = (followData || []).map((f: any) => f.following_id)
          setCachedFollowing(userId, followingIds)  // fire-and-forget
        }
      }
    }

    // ── Base query ──────────────────────────────────────────
    const baseSelect = `
      id, user_id, content, image_url, video_url, is_anonymous, is_mystery,
      view_count, reveal_count, city, tags, created_at,
      user:users!user_id(id, username, display_name, avatar_url, is_verified)
    `

    if (filter === 'nearby') {
      if (!lat || !lng) {
        return NextResponse.json({ error: 'Location required', data: [] }, { status: 400 })
      }
      let q = supabase.from('posts').select(baseSelect)
        .eq('is_deleted', false).eq('scope', 'nearby')
        .order('created_at', { ascending: false }).limit(limit)
      if (cursor) q = q.lt('created_at', cursor)
      if (blockedIds.length) q = q.not('user_id', 'in', `(${blockedIds.join(',')})`)
      const { data, error } = await q
      if (error) throw error
      posts = data || []

    } else if (filter === 'friends') {
      if (!followingIds.length) {
        return NextResponse.json({ data: [], hasMore: false, nextCursor: null })
      }
      let q = supabase.from('posts').select(baseSelect)
        .eq('is_deleted', false).in('user_id', followingIds.slice(0, 500))
        .order('created_at', { ascending: false }).limit(limit)
      if (cursor) q = q.lt('created_at', cursor)
      const { data, error } = await q
      if (error) throw error
      posts = data || []

    } else if (filter === 'room' && roomSlug) {
      const { data: room } = await supabase
        .from('topic_rooms').select('id').eq('slug', roomSlug).single()
      if (room) {
        let q = supabase.from('posts').select(baseSelect)
          .eq('is_deleted', false).eq('room_id', room.id)
          .order('created_at', { ascending: false }).limit(limit)
        if (cursor) q = q.lt('created_at', cursor)
        const { data, error } = await q
        if (error) throw error
        posts = data || []
      }

    } else if (filter === 'city') {
      const city = cityParam || userCity
      if (!city) {
        return NextResponse.json({ error: 'Please select a city', needsCitySelect: true, data: [] })
      }
      let q = supabase.from('posts').select(baseSelect)
        .eq('is_deleted', false).eq('city', city)
        .or('scope.eq.global,scope.is.null,scope.eq.city')
        .order('created_at', { ascending: false }).limit(limit)
      if (cursor) q = q.lt('created_at', cursor)
      if (blockedIds.length) q = q.not('user_id', 'in', `(${blockedIds.join(',')})`)
      const { data, error } = await q
      if (error) throw error
      posts = data || []

    } else {
      // GLOBAL feed
      let q = supabase.from('posts').select(baseSelect)
        .eq('is_deleted', false).or('scope.eq.global,scope.is.null,scope.eq.city')
        .order('created_at', { ascending: false }).limit(limit)
      if (cursor) q = q.lt('created_at', cursor)
      if (blockedIds.length) q = q.not('user_id', 'in', `(${blockedIds.join(',')})`)
      // Exclude seen posts
      const seenIds = seenParam.split(',').filter(id => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 50)
      if (seenIds.length) q = q.not('id', 'in', `(${seenIds.join(',')})`)
      const { data, error } = await q
      if (error) throw error
      posts = data || []
    }

    if (!posts.length) {
      const empty = { data: [], hasMore: false, nextCursor: null }
      setCachedFeed(cacheKey, empty)  // cache empty result too
      return NextResponse.json(empty)
    }

    // ── Enrich: user reactions only ──────────────────────────
    let userReactionMap: Record<string, string> = {}
    let userRevealSet = new Set<string>()

    if (userId && posts.length) {
      const postIds = posts.map((p: any) => p.id)
      const mysteryIds = posts.filter((p: any) => p.is_mystery).map((p: any) => p.id)

      const [rxnRes, revealRes] = await Promise.all([
        supabase.from('reactions').select('post_id,type')
          .in('post_id', postIds).eq('user_id', userId),
        mysteryIds.length
          ? supabase.from('mystery_reveals').select('post_id')
              .in('post_id', mysteryIds).eq('user_id', userId)
          : Promise.resolve({ data: [] })
      ])

      userReactionMap = Object.fromEntries(
        (rxnRes.data || []).map((r: any) => [r.post_id, r.type])
      )
      userRevealSet = new Set((revealRes.data || []).map((r: any) => r.post_id))
    }

    // ── Build response ──────────────────────────────────────
    const enriched = posts.map((p: any) => ({
      ...p,
      user_reaction: userReactionMap[p.id] || null,
      has_revealed:  userRevealSet.has(p.id),
      reaction_counts: {
        interesting: 0, funny: 0, deep: 0, curious: 0,
        ...(p.reaction_counts || {}),
      },
    }))

    const responseData = {
      data:        enriched,
      hasMore:     enriched.length === limit,
      nextCursor:  enriched.length === limit ? enriched[enriched.length - 1]?.created_at : null,
    }

    // ── Cache in Redis (60s TTL) ─────────────────────────────
    setCachedFeed(cacheKey, responseData)  // fire-and-forget

    const res = NextResponse.json(responseData)
    res.headers.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=30')
    res.headers.set('X-Cache', 'MISS')
    return res

  } catch (err: any) {
    console.error('[feed]', err.message)
    return NextResponse.json({ error: err.message, data: [] }, { status: 500 })
  }
}
