'use client'

/**
 * useRealtimePostCounts
 * 
 * Subscribes to realtime changes for a specific post's:
 * - reaction_count (reactions table INSERT/DELETE)
 * - comment_count (comments table INSERT/DELETE)
 * 
 * Returns live counts that override stale SWR data.
 * Used in FeedCard so counts update without full refetch.
 */

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

interface LiveCounts {
  reaction_count?: number
  comment_count?: number
}

export function useRealtimePostCounts(postId: string, initial: LiveCounts = {}) {
  const [counts, setCounts] = useState<LiveCounts>(initial)

  useEffect(() => {
    if (!postId) return

    // Listen to post UPDATE directly (reaction_count, comment_count are
    // updated by DB triggers when reactions/comments are added)
    const channel = supabase
      .channel(`post-counts:${postId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'posts',
        filter: `id=eq.${postId}`,
      }, (payload) => {
        const p = payload.new as any
        setCounts({
          reaction_count: p.reaction_count,
          comment_count:  p.comment_count,
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [postId])

  return counts
}
