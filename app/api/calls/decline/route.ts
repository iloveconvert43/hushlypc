export const dynamic = 'force-dynamic'
export const maxDuration = 10
import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { isValidUUID } from '@/lib/security'

export async function POST(req: NextRequest) {
  try {
    const { caller_id } = await req.json()
    if (!caller_id || !isValidUUID(caller_id)) return NextResponse.json({ ok: true })

    const supabase = createRouteClient()
    const { getUserIdFromToken: _getUID } = await import('@/lib/jwt')
    const _authId = _getUID(req.headers.get('authorization'))
    const sessionUser = _authId ? { id: _authId } : null
    // (auth.getUser replaced with JWT decode)
    if (!sessionUser) return NextResponse.json({ ok: true })
    const { data: me } = await supabase.from('users').select('id').eq('auth_id', sessionUser.id).single()
    if (!me) return NextResponse.json({ ok: true })

    // Broadcast decline signal to caller's channel
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const channelId = [caller_id, me.id].sort().join('-')
    const ch = adminClient.channel(`call:${channelId}`)
    await ch.send({ type: 'broadcast', event: 'call-decline', payload: { from: me.id } })
    await adminClient.removeChannel(ch)

    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ ok: true }) }
}
