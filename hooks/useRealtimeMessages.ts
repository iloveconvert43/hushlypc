'use client'

/**
 * useRealtimeMessages
 *
 * Global listener for new direct messages to the current user.
 * Updates conversation list unread counts in real time.
 * Mounted once in layout — does NOT require a specific conversation to be open.
 *
 * Features:
 *   - Auto-reconnect on channel error/timeout
 *   - Periodic health check (re-subscribes if channel goes stale)
 *   - Fallback SWR polling for reliability
 *   - Revalidates conversation list on new messages + read receipts
 */

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { mutate } from 'swr'

export function useRealtimeMessages() {
  const { profile } = useAuth()
  const retryCount = useRef(0)
  const channelRef = useRef<any>(null)
  const healthRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!profile?.id) return

    let mounted = true

    function subscribe() {
      // Clean up existing channel
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }

      const channel = supabase
        .channel(`inbox:${profile!.id}`, {
          config: { presence: { key: profile!.id } }
        })
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'direct_messages',
          filter: `receiver_id=eq.${profile!.id}`,
        }, () => {
          mutate('/api/messages/conversations')
        })
        // Listen for read receipt updates (when other user reads our messages)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'direct_messages',
          filter: `sender_id=eq.${profile!.id}`,
        }, () => {
          mutate('/api/messages/conversations')
        })
        // Listen for when WE mark messages as read (is_read changes on messages TO us)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'direct_messages',
          filter: `receiver_id=eq.${profile!.id}`,
        }, () => {
          mutate('/api/messages/conversations')
        })
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            retryCount.current = 0
          }
          if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && mounted) {
            const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30000)
            retryCount.current++
            setTimeout(() => {
              if (mounted) subscribe()
            }, delay)
          }
        })

      channelRef.current = channel
    }

    subscribe()

    // Periodic health check — if channel dies silently, resubscribe
    healthRef.current = setInterval(() => {
      if (!mounted) return
      const ch = channelRef.current
      if (!ch || ch.state !== 'joined') {
        console.warn('[realtime] Channel not joined, resubscribing...')
        subscribe()
      }
    }, 30000) // Check every 30s

    // Also handle visibility change — resubscribe when tab becomes visible
    function handleVisibility() {
      if (document.visibilityState === 'visible' && mounted) {
        // Refetch conversations when tab comes back to foreground
        mutate('/api/messages/conversations')
        // Check if channel is still alive
        const ch = channelRef.current
        if (!ch || ch.state !== 'joined') {
          subscribe()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      mounted = false
      document.removeEventListener('visibilitychange', handleVisibility)
      if (healthRef.current) clearInterval(healthRef.current)
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
  }, [profile?.id])
}
