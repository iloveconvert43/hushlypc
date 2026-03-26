export const dynamic = 'force-dynamic'
export const maxDuration = 10

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase-server'
import { sendMessageSchema, validate } from '@/lib/validation/schemas'
import { sanitizeInput, rateLimit, getClientIP, isValidUUID } from '@/lib/security'
import { queuePush } from '@/lib/push'

export async function POST(req: NextRequest) {
  try {
    const { getUserIdFromToken: _getUID } = await import('@/lib/jwt')
    const _authId = _getUID(req.headers.get('authorization'))
    if (!_authId) return NextResponse.json({ error: 'Sign in to send messages' }, { status: 401 })

    const admin = createAdminClient()
    const { data: me } = await admin
      .from('users').select('id, is_banned').eq('auth_id', _authId).single()
    if (!me) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    if (me.is_banned) return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

    // Rate limit: 60 messages per minute per user
    const rl = rateLimit(`msg:${me.id}`, { max: 60, windowMs: 60000 })
    if (!rl.allowed) {
      return NextResponse.json({ error: 'Sending too fast. Slow down.' }, { status: 429 })
    }

    let rawBody: any
    try { rawBody = await req.json() }
    catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

    const v = validate(sendMessageSchema, rawBody)
    if (!v.success) return NextResponse.json({ error: v.error }, { status: 400 })

    const { to_user_id, content, image_url } = v.data

    // UUID validation
    if (!isValidUUID(to_user_id)) {
      return NextResponse.json({ error: 'Invalid recipient ID' }, { status: 400 })
    }
    if (to_user_id === me.id) {
      return NextResponse.json({ error: 'Cannot message yourself' }, { status: 400 })
    }

    // Sanitize message content
    const sanitizedContent = sanitizeInput(content)
    if (!sanitizedContent) {
      return NextResponse.json({ error: 'Message cannot be empty' }, { status: 400 })
    }

    const { data: receiver } = await admin
      .from('users').select('id, is_banned, display_name').eq('id', to_user_id).single()
    if (!receiver || receiver.is_banned) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 })
    }

    // ── Permission check ──────────────────────────────────
    // Uses SQL function: returns 'free' | 'request_needed' | 'request_accepted' | 'blocked' etc.
    const { data: permission } = await admin
      .rpc('get_dm_permission', { p_sender_id: me.id, p_receiver_id: to_user_id })

    if (permission === 'blocked') {
      return NextResponse.json({ error: 'Cannot message this user' }, { status: 403 })
    }
    if (permission === 'request_needed') {
      return NextResponse.json({
        error: 'Send a message request first',
        code:  'REQUEST_REQUIRED',
        hint:  'Use POST /api/messages/requests to send a message request'
      }, { status: 403 })
    }
    if (permission === 'request_pending') {
      return NextResponse.json({
        error: 'Your message request is pending — wait for them to accept',
        code:  'REQUEST_PENDING'
      }, { status: 403 })
    }
    if (permission === 'request_declined') {
      return NextResponse.json({
        error: 'Cannot message this user',
        code:  'REQUEST_DECLINED'
      }, { status: 403 })
    }
    // 'free' or 'request_accepted' → proceed

    const { data, error } = await admin.from('direct_messages')
      .insert({ sender_id: me.id, receiver_id: to_user_id, content: sanitizedContent, ...(image_url ? { image_url } : {}) })
      .select('*, sender:users!sender_id(id,username,display_name,avatar_url)')
      .single()

    if (error) throw error

    // Notify receiver (non-blocking)
    admin.from('notifications').insert({
      user_id: to_user_id,
      actor_id: me.id,
      type: 'new_message',
      message: 'sent you a message' }).then(() => {}).catch(() => {})

    queuePush(to_user_id, {
      title: 'New message',
      body: sanitizedContent.slice(0, 80),
      url: `/messages?user=${me.id}` }).then(() => {}).catch(() => {})

    return NextResponse.json({ data }, { status: 201 })
  } catch (err: any) {
    console.error('[messages/send]', err.message)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { getUserIdFromToken: _getUID } = await import('@/lib/jwt')
    const _authId = _getUID(req.headers.get('authorization'))
    if (!_authId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const admin = createAdminClient()
    const { data: me } = await admin.from('users').select('id').eq('auth_id', _authId).single()
    if (!me) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const { message_id } = await req.json()
    if (!message_id) return NextResponse.json({ error: 'message_id required' }, { status: 400 })
    // Only allow deleting own messages
    const { data: msg } = await admin.from('direct_messages')
      .select('sender_id').eq('id', message_id).single()
    if (!msg || msg.sender_id !== me.id) {
      return NextResponse.json({ error: 'Cannot delete this message' }, { status: 403 })
    }
    await admin.from('direct_messages').update({ is_deleted: true, content: 'Message deleted' }).eq('id', message_id)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  // Mark all messages in a conversation as read
  try {
    const { getUserIdFromToken: _getUID } = await import('@/lib/jwt')
    const _authId = _getUID(req.headers.get('authorization'))
    if (!_authId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // Use admin client for EVERYTHING to bypass RLS
    const admin = createAdminClient()
    const { data: me } = await admin.from('users').select('id').eq('auth_id', _authId).single()
    if (!me) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    const { conversation_with } = await req.json()
    if (!conversation_with) return NextResponse.json({ ok: true })
    const { error } = await admin.from('direct_messages')
      .update({ is_read: true })
      .eq('receiver_id', me.id)
      .eq('sender_id', conversation_with)
      .eq('is_read', false)
    if (error) console.error('[mark-as-read] DB error:', error.message)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[mark-as-read] Error:', err.message)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
