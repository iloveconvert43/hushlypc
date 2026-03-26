'use client'

import { cn, getRelativeTime } from '@/lib/utils'
import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR, { mutate as globalMutate } from 'swr'
import {
  ArrowLeft, Send, Loader2, MessageCircle, Check, CheckCheck,
  Video, MoreVertical, Trash2, Image as ImageIcon,
  Search, X, Mic, MicOff, VideoOff, PhoneOff
} from 'lucide-react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { api, getErrorMessage, swrFetcher } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import Avatar from '@/components/ui/Avatar'
import BottomNav from '@/components/layout/BottomNav'
import DesktopSidebar from '@/components/layout/DesktopSidebar'
import toast from 'react-hot-toast'
import { sendMessageSchema, validate } from '@/lib/validation/schemas'
import { analytics } from '@/lib/analytics'

// ── Phone icon ─────────────────────────────────────────────────
function PhoneIcon({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 8.81 19.79 19.79 0 01.01 2.18 2 2 0 012 .01h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 7.91a16 16 0 006.18 6.18l1.27-.64a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
    </svg>
  )
}

// ── WebRTC Call Hook ───────────────────────────────────────────
function useCall(myId: string | null, otherUserId: string | null) {
  const [callState,    setCallState]    = useState<'idle'|'calling'|'incoming'|'connected'>('idle')
  const [callType,     setCallType]     = useState<'audio'|'video'>('audio')
  const [isMuted,      setIsMuted]      = useState(false)
  const [isVideoOff,   setIsVideoOff]   = useState(false)
  const [callDuration, setCallDuration] = useState(0)

  const pcRef          = useRef<RTCPeerConnection|null>(null)
  const localStream    = useRef<MediaStream|null>(null)
  const channelRef     = useRef<any>(null)
  const timerRef       = useRef<ReturnType<typeof setInterval>|null>(null)
  const localVideoRef  = useRef<HTMLVideoElement|null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement|null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement|null>(null)
  const answerLock     = useRef(false)
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([])
  const channelReady   = useRef(false)

  // ICE servers — STUN for direct connections + free TURN for NAT traversal
  const ICE_CONFIG = { iceServers:[
    { urls:'stun:stun.l.google.com:19302' },
    { urls:'stun:stun1.l.google.com:19302' },
    { urls:'stun:stun.relay.metered.ca:80' },
    { urls:'turn:a.relay.metered.ca:80', username:'e8dd65c92aee94c2bdfcf5a1', credential:'uR6VHbl/bMzcPOKJ' },
    { urls:'turn:a.relay.metered.ca:80?transport=tcp', username:'e8dd65c92aee94c2bdfcf5a1', credential:'uR6VHbl/bMzcPOKJ' },
    { urls:'turn:a.relay.metered.ca:443', username:'e8dd65c92aee94c2bdfcf5a1', credential:'uR6VHbl/bMzcPOKJ' },
    { urls:'turns:a.relay.metered.ca:443?transport=tcp', username:'e8dd65c92aee94c2bdfcf5a1', credential:'uR6VHbl/bMzcPOKJ' },
  ]}

  function createPC() {
    const pc = new RTCPeerConnection(ICE_CONFIG)
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (!stream) return
      // Video calls: attach to video element
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream
      // Audio calls: ALWAYS attach to hidden audio element (video element may not exist)
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream
        remoteAudioRef.current.play().catch(() => {})
      }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate && channelRef.current && channelReady.current)
        channelRef.current.send({ type:'broadcast', event:'ice-candidate', payload:{ from:myId, candidate:e.candidate } })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setCallState('connected')
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') endCall(false)
    }
    return pc
  }

  useEffect(() => {
    if (!myId || !otherUserId) return
    channelReady.current = false
    const channelId = [myId, otherUserId].sort().join('-')
    const ch = supabase.channel(`call:${channelId}`, {
      config: { broadcast: { self: false } }
    })
      .on('broadcast', { event:'call-offer' }, async ({ payload }: any) => {
        if (payload.from === myId) return
        setCallType(payload.callType || 'audio')
        setCallState('incoming')
        try {
          if (pcRef.current) { pcRef.current.close(); pcRef.current = null }
          const pc = createPC()
          pcRef.current = pc
          await pc.setRemoteDescription(new RTCSessionDescription(payload.offer))
          // Flush any ICE candidates that arrived before the offer
          for (const c of pendingCandidates.current) {
            await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
          }
          pendingCandidates.current = []
        } catch(err) { console.error('[call] setRemoteDesc', err) }
      })
      .on('broadcast', { event:'call-answer' }, async ({ payload }: any) => {
        if (payload.from === myId) return
        try {
          if (pcRef.current) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer))
            // Flush pending candidates
            for (const c of pendingCandidates.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
            }
            pendingCandidates.current = []
          }
          setCallState('connected')
          startCallTimer()
        } catch(err) { console.error('[call] setAnswer', err) }
      })
      .on('broadcast', { event:'ice-candidate' }, async ({ payload }: any) => {
        if (payload.from === myId) return
        if (pcRef.current && pcRef.current.remoteDescription) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {})
        } else {
          // Queue candidates that arrive before offer/answer
          pendingCandidates.current.push(payload.candidate)
        }
      })
      .on('broadcast', { event:'call-end' }, ({ payload }: any) => {
        if (payload.from === myId) return
        endCall(false)
      })
      .on('broadcast', { event:'call-decline' }, ({ payload }: any) => {
        if (payload.from === myId) return
        endCall(false); toast('Call declined')
      })
      .on('broadcast', { event:'request-offer' }, ({ payload }: any) => {
        if (payload.from === myId) return
        // Caller resends offer when receiver requests it (e.g. after navigating to messages page)
        if (pcRef.current && channelRef.current) {
          const offer = pcRef.current.localDescription
          if (offer) channelRef.current.send({ type:'broadcast', event:'call-offer', payload:{ from:myId, offer, callType } })
        }
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          channelReady.current = true
          console.log('[call] Channel subscribed:', channelId)
        }
      })
    channelRef.current = ch
    return () => {
      supabase.removeChannel(ch)
      channelRef.current = null
      channelReady.current = false
      pendingCandidates.current = []
    }
  }, [myId, otherUserId]) // eslint-disable-line

  function startCallTimer() {
    setCallDuration(0)
    timerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000)
  }
  function stopCallTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }

  async function startCall(type: 'audio'|'video') {
    if (!myId || !otherUserId) { toast.error('Cannot start call'); return }
    setCallType(type); setCallState('calling')
    try {
      // Request mic/camera FIRST before anything else
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true, video: type==='video' ? { facingMode:'user' } : false })
      localStream.current = stream

      // Wait for channel to be ready
      if (!channelReady.current) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (channelReady.current) { clearInterval(check); resolve() }
          }, 100)
          setTimeout(() => { clearInterval(check); resolve() }, 3000) // max 3s wait
        })
      }

      const pc = createPC()
      pcRef.current = pc
      stream.getTracks().forEach(t => pc.addTrack(t, stream))
      if (localVideoRef.current && type==='video') localVideoRef.current.srcObject = stream

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // Send offer on the shared call channel
      if (channelRef.current) {
        channelRef.current.send({ type:'broadcast', event:'call-offer', payload:{ from:myId, offer, callType:type } })
      }

      // Also send to receiver's personal channel (for GlobalCallUI)
      const rcvCh = supabase.channel(`user-calls:${otherUserId}`)
      await rcvCh.subscribe()
      rcvCh.send({ type:'broadcast', event:'call-offer', payload:{ from:myId, offer, callType:type } })
      setTimeout(() => supabase.removeChannel(rcvCh), 5000)

      // Trigger push notification via API
      fetch('/api/calls/ring', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ recipient_id:otherUserId, call_type:type }) }).catch(()=>{})

      // Auto-timeout after 45 seconds if no answer
      setTimeout(() => {
        if (pcRef.current && !pcRef.current.remoteDescription) {
          toast('No answer')
          endCall(true)
        }
      }, 45000)
    } catch(err: any) {
      console.error('[call] startCall error:', err)
      if (err?.name === 'NotAllowedError') {
        toast.error('Mic/camera permission denied. Allow it in browser settings and try again.')
      } else if (err?.name === 'NotFoundError') {
        toast.error('No microphone found. Connect a mic and try again.')
      } else if (err?.name === 'NotReadableError') {
        toast.error('Mic/camera is in use by another app. Close it and try again.')
      } else {
        toast.error('Could not start call: ' + (err?.message || 'Unknown error'))
      }
      localStream.current?.getTracks().forEach(t => t.stop())
      localStream.current = null
      setCallState('idle')
    }
  }

  async function answerCall() {
    // Mutex lock — prevent double-answer from auto-answer + manual click
    if (answerLock.current) return
    answerLock.current = true
    try {
      // Wait for channel to be ready
      if (!channelReady.current) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (channelReady.current) { clearInterval(check); resolve() }
          }, 100)
          setTimeout(() => { clearInterval(check); resolve() }, 3000)
        })
      }
      if (!channelRef.current) { toast.error('Call connection lost'); setCallState('idle'); return }

      const stream = await navigator.mediaDevices.getUserMedia({ audio:true, video: callType==='video' ? { facingMode:'user' } : false })
      localStream.current = stream

      if (!pcRef.current || !pcRef.current.remoteDescription) {
        // Peer connection not ready — request the caller to resend their offer
        if (channelRef.current) {
          channelRef.current.send({ type:'broadcast', event:'request-offer', payload:{ from:myId } })
        }
        // Wait up to 5s for the offer to arrive
        const gotOffer = await new Promise<boolean>((resolve) => {
          const check = setInterval(() => {
            if (pcRef.current?.remoteDescription) { clearInterval(check); resolve(true) }
          }, 200)
          setTimeout(() => { clearInterval(check); resolve(false) }, 5000)
        })
        if (!gotOffer || !pcRef.current) {
          toast.error('Call expired. Ask caller to call again.')
          stream.getTracks().forEach(t => t.stop()); localStream.current = null; setCallState('idle'); return
        }
      }

      stream.getTracks().forEach(t => pcRef.current!.addTrack(t, stream))
      if (localVideoRef.current && callType==='video') localVideoRef.current.srcObject = stream
      const answer = await pcRef.current.createAnswer()
      await pcRef.current.setLocalDescription(answer)
      channelRef.current.send({ type:'broadcast', event:'call-answer', payload:{ from:myId, answer } })
      setCallState('connected')
      startCallTimer()
    } catch(err: any) {
      console.error('[call] answerCall error:', err)
      toast.error(err?.name==='NotAllowedError' ? 'Mic permission denied. Allow it in settings.' : 'Could not answer call')
      answerLock.current = false
      endCall(true)
    }
  }

  function declineCall() {
    channelRef.current?.send({ type:'broadcast', event:'call-decline', payload:{ from:myId } })
    cleanup(); setCallState('idle')
  }
  function endCall(sendSignal = true) {
    if (sendSignal && channelRef.current)
      channelRef.current.send({ type:'broadcast', event:'call-end', payload:{ from:myId } })
    stopCallTimer(); cleanup(); setCallState('idle')
  }
  function cleanup() {
    localStream.current?.getTracks().forEach(t => t.stop())
    localStream.current = null; pcRef.current?.close(); pcRef.current = null
    pendingCandidates.current = []; answerLock.current = false
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = null; remoteAudioRef.current.pause() }
  }
  function toggleMute() { localStream.current?.getAudioTracks().forEach(t => { t.enabled = !t.enabled }); setIsMuted(m => !m) }
  function toggleVideo() { localStream.current?.getVideoTracks().forEach(t => { t.enabled = !t.enabled }); setIsVideoOff(v => !v) }
  function setIncomingCall(type: 'audio'|'video') { setCallType(type); setCallState('incoming') }
  function formatDuration(s: number) { return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}` }

  return {
    callState, callType, isMuted, isVideoOff,
    callDuration: formatDuration(callDuration),
    localVideoRef, remoteVideoRef, remoteAudioRef, channelRef,
    startCall, answerCall, declineCall, endCall, toggleMute, toggleVideo, setIncomingCall,
  }
}

// ── Call Overlay ───────────────────────────────────────────────
function CallOverlay({ call, otherUser, autoAnswering }: { call: ReturnType<typeof useCall>; otherUser: any; autoAnswering?: boolean }) {
  const { callState, callType, isMuted, isVideoOff, callDuration,
          localVideoRef, remoteVideoRef, remoteAudioRef, answerCall, declineCall, endCall, toggleMute, toggleVideo } = call
  if (callState === 'idle') return null
  // When auto-answering (from GlobalCallUI accept), treat 'incoming' like 'calling' — no Accept/Decline
  const showConnecting = autoAnswering && callState === 'incoming'
  return (
    <div className="fixed inset-0 z-[300] bg-gradient-to-b from-gray-900 to-black flex flex-col items-center justify-between py-16 px-6">
      {/* Hidden audio element — CRITICAL for audio-only calls. Always present. */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {callType === 'video' && callState === 'connected' && (
        <video ref={remoteVideoRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover" />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/80" />
      <div className="relative z-10 flex flex-col items-center gap-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-primary/25 animate-ping scale-125" />
          <div className="relative w-24 h-24 rounded-full overflow-hidden border-4 border-white/20 shadow-2xl">
            {otherUser?.avatar_url
              ? <img src={otherUser.avatar_url} className="w-full h-full object-cover" alt="" />
              : <div className="w-full h-full bg-gradient-to-br from-primary to-accent-red flex items-center justify-center text-white text-3xl font-bold">{(otherUser?.display_name||'?')[0]}</div>}
          </div>
        </div>
        <div className="text-center">
          <p className="text-white text-2xl font-bold">{otherUser?.display_name || otherUser?.username}</p>
          <p className="text-white/60 text-sm mt-1 animate-pulse">
            {showConnecting ? 'Connecting…' : callState==='calling' ? 'Calling…' : callState==='incoming' ? `Incoming ${callType} call` : callDuration}
          </p>
        </div>
      </div>
      {callType==='video' && callState==='connected' && (
        <video ref={localVideoRef} autoPlay playsInline muted className="absolute bottom-36 right-4 w-28 h-40 rounded-2xl object-cover border-2 border-white/20 z-20" />
      )}
      <div className="relative z-10 flex items-center gap-8">
        {callState === 'incoming' && !showConnecting ? (
          <>
            <div className="flex flex-col items-center gap-2">
              <button onClick={declineCall} className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow-2xl active:scale-90 transition-all">
                <PhoneOff size={24} />
              </button>
              <span className="text-white/60 text-xs">Decline</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <button onClick={answerCall} className="w-16 h-16 rounded-full bg-green-500 hover:bg-green-600 flex items-center justify-center text-white shadow-2xl active:scale-90 transition-all">
                <PhoneIcon size={24} />
              </button>
              <span className="text-white/60 text-xs">Accept</span>
            </div>
          </>
        ) : (
          <>
            <button onClick={toggleMute}
              className={cn("w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90", isMuted ? "bg-white/30" : "bg-white/10 hover:bg-white/20")}>
              {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
            {callType==='video' && (
              <button onClick={toggleVideo}
                className={cn("w-14 h-14 rounded-full flex items-center justify-center text-white transition-all active:scale-90", isVideoOff ? "bg-white/30" : "bg-white/10 hover:bg-white/20")}>
                {isVideoOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
            )}
            <button onClick={() => endCall(true)} className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow-2xl active:scale-90 transition-all">
              <PhoneOff size={24} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── Conversation List ──────────────────────────────────────────
const ConversationList = memo(function ConversationList({ activeUserId }: { activeUserId: string|null }) {
  const [search, setSearch] = useState('')
  const { data, isLoading } = useSWR('/api/messages/conversations', swrFetcher, {
    refreshInterval: 5000, revalidateOnFocus: true, keepPreviousData: true
  })
  const all: any[] = (data as any)?.data || []
  const conversations = search
    ? all.filter(c => (c.other_user?.display_name||c.other_user?.username||'').toLowerCase().includes(search.toLowerCase()))
    : all

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-3 flex-shrink-0 border-b border-border">
        <h2 className="text-lg font-bold mb-3">Messages</h2>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            className="w-full bg-bg-card2 rounded-xl pl-9 pr-8 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-text-muted" />
          {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2"><X size={13} className="text-text-muted" /></button>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1,2,3,4].map(i => (
              <div key={i} className="flex items-center gap-3 animate-pulse">
                <div className="w-12 h-12 rounded-full bg-bg-card2 flex-shrink-0" />
                <div className="flex-1 space-y-2"><div className="h-3 bg-bg-card2 rounded w-28" /><div className="h-2.5 bg-bg-card2 rounded w-44" /></div>
              </div>
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-6">
            <MessageCircle size={32} className="text-text-muted opacity-30 mb-3" />
            <p className="text-sm text-text-muted">{search ? 'No results' : 'No conversations yet'}</p>
          </div>
        ) : conversations.map((conv: any) => {
          const isActive = activeUserId === conv.other_user?.id
          const isUnread = conv.unread_count > 0
          return (
            <Link key={conv.other_user?.id} href={`/messages?user=${conv.other_user?.id}`}
              className={cn("flex items-center gap-3 px-4 py-3.5 hover:bg-bg-card/50 transition-colors",
                isActive && "bg-primary/8 border-l-[3px] border-primary")}>
              <div className="relative flex-shrink-0">
                <Avatar user={conv.other_user} size={48} />
                {isUnread && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-primary rounded-full text-[9px] text-white flex items-center justify-center font-bold border-2 border-bg px-1">
                    {conv.unread_count > 9 ? '9+' : conv.unread_count}
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className={cn("text-sm truncate", isUnread ? "font-bold text-text" : "font-semibold text-text-secondary")}>
                    {conv.other_user?.display_name || conv.other_user?.username}
                  </span>
                  <span className="text-[11px] text-text-muted flex-shrink-0 ml-2">
                    {conv.last_message?.created_at ? getRelativeTime(conv.last_message.created_at) : ''}
                  </span>
                </div>
                <p className={cn("text-xs truncate", isUnread ? "text-text font-medium" : "text-text-muted")}>
                  {conv.last_message?.content || ''}
                </p>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
})

// ── Message Bubble ─────────────────────────────────────────────
function isVideoUrl(url: string) {
  if (!url) return false
  const lower = url.toLowerCase()
  return /\.(mp4|webm|mov|avi|mkv|m4v|ogg)(\?|$)/i.test(lower) || lower.includes('/video')
}

function MessageBubble({ msg, isMine, onDelete, otherUser }: any) {
  const [hovered, setHovered] = useState(false)
  if (msg.content === 'Message deleted') {
    return (
      <div className={cn("flex", isMine ? "justify-end" : "justify-start")}>
        <p className="text-xs text-text-muted italic px-3 py-1">Message deleted</p>
      </div>
    )
  }
  const hasMedia = !!msg.image_url
  const isVideo = hasMedia && (msg.content === '🎥 Video' || isVideoUrl(msg.image_url))
  return (
    <div className={cn("flex gap-2 items-end group", isMine ? "flex-row-reverse" : "")}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {!isMine && <Avatar user={otherUser} size={28} className="flex-shrink-0 mb-1" />}
      <div className={cn(
        "max-w-[72%] rounded-2xl text-sm leading-relaxed break-words shadow-sm",
        hasMedia ? "p-0 overflow-hidden" : "px-3.5 py-2.5",
        isMine ? "bg-primary text-white rounded-br-sm" : "bg-bg-card border border-border/50 text-text rounded-bl-sm"
      )}>
        {hasMedia && isVideo ? (
          <video src={msg.image_url} controls playsInline preload="metadata"
            className="max-w-[260px] max-h-[340px] rounded-t-2xl bg-black" />
        ) : hasMedia ? (
          <a href={msg.image_url} target="_blank" rel="noreferrer">
            <img src={msg.image_url} alt="" className="max-w-[260px] max-h-[340px] object-cover" loading="lazy" />
          </a>
        ) : null}
        {msg.content && msg.content !== '📷 Photo' && msg.content !== '🎥 Video' && (
          <p className={hasMedia ? "px-3.5 py-2" : ""}>{msg.content}</p>
        )}
        <div className={cn("flex items-center gap-1 text-[10px] mt-0.5",
          msg.image_url ? "px-3.5 pb-2" : "",
          isMine ? "text-white/60 justify-end" : "text-text-muted justify-end")}>
          <span>{getRelativeTime(msg.created_at)}</span>
          {isMine && (msg.is_read ? <CheckCheck size={11} className="text-blue-300" /> : <Check size={11} />)}
        </div>
      </div>
      {isMine && hovered && (
        <button onClick={() => onDelete(msg.id)} className="text-text-muted hover:text-red-400 p-1 mb-1 transition-colors">
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}

// ── Chat Area ──────────────────────────────────────────────────
function ChatArea({ userId }: { userId: string }) {
  const { profile } = useAuth()
  const chatParams   = useSearchParams()
  const autoAnswer   = chatParams.get('action') === 'answer'
  const autoCallType = (chatParams.get('type') || 'audio') as 'audio'|'video'

  const call = useCall(profile?.id || null, userId)
  const { callState, startCall, setIncomingCall, channelRef: callChannelRef } = call

  const messagesRef   = useRef<HTMLDivElement>(null)
  const bottomRef     = useRef<HTMLDivElement>(null)
  const textareaRef   = useRef<HTMLTextAreaElement>(null)
  const channelRef    = useRef<any>(null)
  const typingTimeout = useRef<ReturnType<typeof setTimeout>|null>(null)

  const [message,       setMessage]       = useState('')
  const [sending,       setSending]       = useState(false)
  const [myTyping,      setMyTyping]      = useState(false)
  const [otherTyping,   setOtherTyping]   = useState(false)
  const [isNearBottom,  setIsNearBottom]  = useState(true)
  const [uploadingFile, setUploadingFile] = useState(false)

  const { data: userData } = useSWR(`/api/users/${userId}/full`, swrFetcher, { revalidateOnFocus: false })
  const otherUser = userData?.data?.user

  const { data: msgsRes, mutate } = useSWR(
    `/api/messages/thread/${userId}`, swrFetcher,
    { revalidateOnFocus: true, keepPreviousData: true, refreshInterval: 4000 }
  )
  const { data: permRes, mutate: mutatePermission } = useSWR(
    `/api/messages/permission?user_id=${userId}`, swrFetcher,
    { revalidateOnFocus: false }
  )
  const dmPermission = (permRes as any)?.permission || 'free'
  const canCall = (permRes as any)?.can_call ?? false
  const messages: any[] = (msgsRes as any)?.data || []

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (isNearBottom) setTimeout(() => bottomRef.current?.scrollIntoView({ behavior:'smooth' }), 50)
  }, [messages.length]) // eslint-disable-line

  // Scroll on mount + mark messages as read
  useEffect(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior:'auto' }), 100)
    // Mark messages as read when conversation opens
    if (profile?.id) {
      // 1. OPTIMISTIC: Immediately clear badge in SWR cache (no server roundtrip)
      globalMutate('/api/messages/conversations', (current: any) => {
        if (!current?.data) return current
        return {
          ...current,
          data: current.data.map((c: any) =>
            c.other_user?.id === userId ? { ...c, unread_count: 0 } : c
          )
        }
      }, false) // false = don't revalidate yet

      // 2. SERVER: Mark as read in database
      api.patch('/api/messages/send', { conversation_with: userId })
        .then(() => {
          // 3. REVALIDATE: Refetch from server to confirm
          setTimeout(() => globalMutate('/api/messages/conversations'), 500)
          setTimeout(() => globalMutate('/api/messages/conversations'), 2000)
        })
        .catch((err) => {
          console.error('[messages] mark-as-read failed:', err)
          // Revalidate anyway to get correct state
          globalMutate('/api/messages/conversations')
        })
    }
  }, [userId, profile?.id])

  // Auto-answer from GlobalCallUI — user already accepted in the overlay,
  // so skip the Accept/Decline UI and directly answer the call
  const autoAnswered = useRef(false)
  useEffect(() => {
    if (autoAnswer && callState === 'idle' && profile?.id && !autoAnswered.current) {
      autoAnswered.current = true
      // Set call type first (needed by answerCall for getUserMedia)
      setIncomingCall(autoCallType)
      // Wait for channel to be ready, then request offer and auto-answer
      const t = setTimeout(async () => {
        // Request the caller to resend their offer (we just navigated here)
        if (callChannelRef?.current) {
          callChannelRef.current.send({ type:'broadcast', event:'request-offer', payload:{ from:profile.id } })
        }
        // Give time for offer to arrive, then auto-answer (skips the UI)
        setTimeout(() => {
          call.answerCall()
        }, 1500)
      }, 1000)
      return () => clearTimeout(t)
    }
  }, [autoAnswer, profile?.id]) // eslint-disable-line

  // Realtime subscription — listen for both incoming AND outgoing messages
  useEffect(() => {
    if (!profile?.id) return
    const channelId = [profile.id, userId].sort().join('-')
    const ch = supabase.channel(`dm:${channelId}`)
      // Listen for incoming messages from the other user
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'direct_messages',
        filter:`receiver_id=eq.${profile.id}` },
        (p: any) => {
          if (p.new?.sender_id === userId) mutate()
          // OPTIMISTIC: Immediately clear badge in SWR cache
          globalMutate('/api/messages/conversations', (current: any) => {
            if (!current?.data) return current
            return { ...current, data: current.data.map((c: any) =>
              c.other_user?.id === userId ? { ...c, unread_count: 0 } : c
            )}
          }, false)
          // SERVER: Mark as read in database
          api.patch('/api/messages/send', { conversation_with: userId }).then(() => {
            globalMutate('/api/messages/conversations')
          }).catch(() => {})
        })
      // Listen for messages we sent (confirms delivery)
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'direct_messages',
        filter:`sender_id=eq.${profile.id}` },
        (p: any) => { if (p.new?.receiver_id === userId) mutate() })
      // Listen for read receipts and updates
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'direct_messages',
        filter:`receiver_id=eq.${profile.id}` }, () => {
          mutate()
          // Optimistic clear then revalidate
          globalMutate('/api/messages/conversations', (current: any) => {
            if (!current?.data) return current
            return { ...current, data: current.data.map((c: any) =>
              c.other_user?.id === userId ? { ...c, unread_count: 0 } : c
            )}
          }, false)
          setTimeout(() => globalMutate('/api/messages/conversations'), 500)
        })
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'direct_messages',
        filter:`sender_id=eq.${profile.id}` }, () => mutate())
      .on('broadcast', { event:'typing' }, ({ payload }: any) => {
        if (payload.user_id !== profile.id) { setOtherTyping(true); setTimeout(() => setOtherTyping(false), 3000) }
      })
      .on('broadcast', { event:'stop-typing' }, ({ payload }: any) => {
        if (payload.user_id !== profile.id) setOtherTyping(false)
      })
      .subscribe()
    channelRef.current = ch
    return () => { supabase.removeChannel(ch); channelRef.current = null }
  }, [profile?.id, userId, mutate])

  const handleTyping = useCallback((val: string) => {
    setMessage(val)
    if (!profile?.id || !channelRef.current) return
    if (!myTyping) {
      setMyTyping(true)
      channelRef.current.send({ type:'broadcast', event:'typing', payload:{ user_id:profile.id } })
    }
    if (typingTimeout.current) clearTimeout(typingTimeout.current)
    typingTimeout.current = setTimeout(() => {
      setMyTyping(false)
      channelRef.current?.send({ type:'broadcast', event:'stop-typing', payload:{ user_id:profile.id } })
    }, 2000)
  }, [profile?.id, myTyping])

  async function sendMessage() {
    const content = message.trim()
    if (!content || sending) return
    const v = validate(sendMessageSchema, { to_user_id: userId, content })
    if (!v.success) { toast.error(v.error); return }
    setMessage('')
    if (textareaRef.current) textareaRef.current.style.height = '40px'
    setSending(true)
    channelRef.current?.send({ type:'broadcast', event:'stop-typing', payload:{ user_id:profile?.id } })
    try {
      await api.post('/api/messages/send', { to_user_id:userId, content }, { requireAuth:true })
      analytics.track('message_send')
      mutate()
    } catch(e: any) {
      toast.error(getErrorMessage(e)); setMessage(content)
    } finally { setSending(false) }
  }

  async function sendFile(file: File) {
    setUploadingFile(true)
    try {
      const { uploadToImageKit } = await import('@/lib/upload')
      const isVideo = file.type.startsWith('video/')
      const result = await uploadToImageKit(file, isVideo ? 'videos' : 'images')
      if (!result?.url) throw new Error('Upload returned no URL')
      await api.post('/api/messages/send', {
        to_user_id: userId,
        content: isVideo ? '🎥 Video' : '📷 Photo',
        image_url: result.url,
      }, { requireAuth: true, timeout: 15000 })
      mutate()
      analytics.track('message_file_send')
    } catch (err: any) {
      const msg = err?.message || 'Failed to send file'
      toast.error(msg.includes('sign in') ? 'Please sign in again to send files' : msg)
    } finally { setUploadingFile(false) }
  }

  async function sendMultipleFiles(files: FileList) {
    for (let i = 0; i < files.length; i++) {
      await sendFile(files[i])
    }
  }

  async function deleteMessage(msgId: string) {
    try {
      await fetch('/api/messages/send', { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ message_id:msgId }) })
      mutate()
    } catch { toast.error('Failed to delete') }
  }

  const displayName = otherUser?.display_name || otherUser?.full_name || otherUser?.username || '…'

  return (
    <div className="flex flex-col h-full relative bg-bg">
      <CallOverlay call={call} otherUser={otherUser} autoAnswering={autoAnswer} />

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-bg/98 backdrop-blur flex-shrink-0 safe-top">
        <Link href="/messages" className="text-text-muted hover:text-text transition-colors lg:hidden flex-shrink-0">
          <ArrowLeft size={20} />
        </Link>
        {otherUser ? (
          <>
            <Link href={`/profile/${userId}`} className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity">
              <Avatar user={otherUser} size={38} />
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{displayName}</p>
                <p className="text-xs truncate">
                  {otherTyping ? <span className="text-primary animate-pulse">typing…</span> : <span className="text-text-muted">@{otherUser.username}</span>}
                </p>
              </div>
            </Link>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => {
                if (!canCall) { toast.error('Both users must follow each other to call'); return }
                startCall('audio')
              }} className={cn("w-9 h-9 rounded-xl hover:bg-bg-card2 flex items-center justify-center transition-all", canCall ? "text-text-muted hover:text-text" : "text-text-muted/30 cursor-not-allowed")}
                title={canCall ? 'Voice call' : 'Both users must follow each other to call'}>
                <PhoneIcon size={17} />
              </button>
              <button onClick={() => {
                if (!canCall) { toast.error('Both users must follow each other to call'); return }
                startCall('video')
              }} className={cn("w-9 h-9 rounded-xl hover:bg-bg-card2 flex items-center justify-center transition-all", canCall ? "text-text-muted hover:text-text" : "text-text-muted/30 cursor-not-allowed")}
                title={canCall ? 'Video call' : 'Both users must follow each other to call'}>
                <Video size={17} />
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 h-4 bg-bg-card2 rounded animate-pulse max-w-[140px]" />
        )}
      </div>

      {/* Messages */}
      <div ref={messagesRef}
        onScroll={() => {
          const el = messagesRef.current
          if (el) setIsNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
        }}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-2 hide-scrollbar">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            {otherUser && <Avatar user={otherUser} size={64} />}
            <div>
              <p className="font-semibold text-base">{displayName}</p>
              <p className="text-sm text-text-muted mt-1">Say hello! 👋</p>
            </div>
          </div>
        ) : messages.map((msg: any) => (
          <MessageBubble key={msg.id} msg={msg} isMine={msg.sender_id === profile?.id}
            onDelete={deleteMessage} otherUser={otherUser} />
        ))}
        {otherTyping && (
          <div className="flex gap-2 items-end">
            <Avatar user={otherUser} size={28} className="flex-shrink-0 mb-1" />
            <div className="bg-bg-card border border-border/50 rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1">
                {[0,1,2].map(i => <div key={i} className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay:`${i*0.15}s` }} />)}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} className="h-1" />
      </div>

      {!isNearBottom && (
        <button onClick={() => bottomRef.current?.scrollIntoView({ behavior:'smooth' })}
          className="absolute bottom-24 right-4 bg-primary text-white text-xs px-3 py-1.5 rounded-full shadow-lg z-10 hover:bg-primary/90 transition-colors">
          ↓ New messages
        </button>
      )}

      {/* Input */}
      {dmPermission === 'request_needed' ? (
        <div className="px-4 py-4 border-t border-border text-center bg-bg">
          <p className="text-sm text-text-muted mb-3">Send a message request first</p>
          <button onClick={async () => {
            try {
              await api.post('/api/messages/requests', { to_user_id:userId }, { requireAuth:true })
              mutatePermission(); toast.success('Request sent!')
            } catch(e: any) { toast.error(getErrorMessage(e)) }
          }} className="btn-primary text-sm px-6 py-2">Send Message Request</button>
        </div>
      ) : dmPermission === 'request_pending' ? (
        <div className="px-4 py-4 border-t border-border text-center bg-bg">
          <p className="text-sm text-text-muted">⏳ Message request pending approval</p>
        </div>
      ) : dmPermission === 'request_declined' ? (
        <div className="px-4 py-4 border-t border-border text-center bg-bg">
          <p className="text-sm text-text-muted">🚫 Cannot message this user</p>
        </div>
      ) : (
        <div className="px-3 py-2.5 border-t border-border flex items-end gap-2 bg-bg flex-shrink-0 safe-bottom">
          <label className={cn("w-9 h-9 rounded-full flex items-center justify-center cursor-pointer transition-all flex-shrink-0",
            uploadingFile ? "bg-primary/15" : "bg-bg-card2 hover:bg-bg-card border border-border")}>
            <input type="file" className="hidden" accept="image/*,video/*" multiple disabled={uploadingFile}
              onChange={e => { const files = e.target.files; if (files && files.length > 1) sendMultipleFiles(files); else if (files?.[0]) sendFile(files[0]); e.target.value = '' }} />
            {uploadingFile ? <Loader2 size={15} className="animate-spin text-primary" /> : <ImageIcon size={15} className="text-text-muted" />}
          </label>
          <textarea ref={textareaRef} value={message} rows={1}
            onChange={e => {
              handleTyping(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            placeholder="Message…" maxLength={1000}
            className="flex-1 bg-bg-card2 border border-border rounded-2xl px-4 py-2.5 text-sm outline-none focus:border-primary/60 transition-colors placeholder:text-text-muted resize-none leading-relaxed"
            style={{ minHeight:'40px', maxHeight:'120px' }}
          />
          <button onClick={sendMessage} disabled={!message.trim() || sending}
            className="w-9 h-9 rounded-full bg-primary disabled:opacity-40 flex items-center justify-center text-white active:scale-90 transition-all flex-shrink-0 shadow-sm">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main Export ────────────────────────────────────────────────
export default function MessagesContent() {
  const { isLoggedIn, loading } = useAuth()
  const router    = useRouter()
  const params    = useSearchParams()
  const withUser  = params.get('user')

  useEffect(() => {
    if (!loading && !isLoggedIn) router.push('/login?redirect=/messages')
  }, [loading, isLoggedIn, router])

  if (loading) return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="w-7 h-7 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  )
  if (!isLoggedIn) return null

  return (
    <>
      {/* Mobile */}
      <div className="lg:hidden flex flex-col" style={{ height:'100dvh' }}>
        {withUser ? (
          <ChatArea userId={withUser} />
        ) : (
          <>
            <div className="flex-shrink-0 border-b border-border bg-bg/90 backdrop-blur sticky top-0 z-40 safe-top">
              <div className="flex items-center gap-3 px-4 py-3">
                <Link href="/" className="text-text-muted"><ArrowLeft size={20} /></Link>
                <h1 className="font-bold">Messages</h1>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto"><ConversationList activeUserId={null} /></div>
            <BottomNav />
          </>
        )}
      </div>

      {/* Desktop */}
      <div className="hidden lg:flex h-screen overflow-hidden">
        <DesktopSidebar />
        <div className="w-80 border-r border-border flex flex-col flex-shrink-0 bg-bg">
          <ConversationList activeUserId={withUser} />
        </div>
        <div className="flex-1 flex flex-col min-w-0 bg-bg">
          {withUser ? <ChatArea userId={withUser} /> : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
              <div className="w-16 h-16 rounded-full bg-bg-card2 flex items-center justify-center">
                <MessageCircle size={28} className="text-text-muted opacity-30" />
              </div>
              <div>
                <p className="font-semibold text-text-secondary">Your Messages</p>
                <p className="text-sm text-text-muted mt-1">Select a conversation to start chatting</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
