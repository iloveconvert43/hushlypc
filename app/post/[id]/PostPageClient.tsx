'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'

import Link from 'next/link'
import { ArrowLeft, Send, Loader2, Trash2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { getRelativeTime } from '@/lib/utils'
import { api, getErrorMessage, swrFetcher } from '@/lib/api'
const fetcher = swrFetcher
import BottomNav from '@/components/layout/BottomNav'
import DesktopSidebar from '@/components/layout/DesktopSidebar'
import FeedCard from '@/components/feed/FeedCard'
import Avatar from '@/components/ui/Avatar'
import { PostSkeleton } from '@/components/ui/Skeleton'
import toast from 'react-hot-toast'
import { analytics } from '@/lib/analytics'
import type { Comment } from '@/types'

export default function PostPageClient({ id }: { id: string }) {

  return (
    <div className="min-h-screen bg-bg">
      <div className="lg:hidden">
        <div className="sticky top-0 z-50 bg-bg/90 backdrop-blur-xl border-b border-border safe-top">
          <div className="flex items-center gap-3 px-4 py-3">
            <Link href="/" className="text-text-muted hover:text-text transition-colors">
              <ArrowLeft size={22} />
            </Link>
            <h1 className="font-bold">Post</h1>
          </div>
        </div>
        <main className="pb-nav">
          <PostContent postId={id} />
        </main>
        <BottomNav />
      </div>
      <div className="hidden lg:flex h-screen overflow-hidden">
        <DesktopSidebar />
        <main className="flex-1 overflow-y-auto hide-scrollbar border-x border-border">
          <div className="sticky top-0 z-40 bg-bg/90 backdrop-blur-xl border-b border-border px-6 py-3 flex items-center gap-3">
            <Link href="/" className="text-text-muted hover:text-text transition-colors">
              <ArrowLeft size={20} />
            </Link>
            <h1 className="font-bold">Post</h1>
          </div>
          <div className="max-w-2xl mx-auto">
            <PostContent postId={id} />
          </div>
        </main>
      </div>
    </div>
  )
}

function PostContent({ postId }: { postId: string }) {
  const { profile, isLoggedIn } = useAuth()
  const router = useRouter()

  // FIX #3: correct SWR key — was wrongly using /api/feed
  const { data: postData, isLoading: postLoading, error: postError } = useSWR(
    `/api/posts/${postId}`,
    fetcher
  )
  const { data: commentsData, mutate: mutateComments } = useSWR(
    `/api/posts/${postId}/comments`,
    fetcher
  )

  const [comment, setComment] = useState('')
  const [replyTo, setReplyTo] = useState<Comment | null>(null)
  const [loading, setLoading] = useState(false)

  const post = postData?.data ?? null
  const comments: Comment[] = commentsData?.data || []

  // Signal: opening a post detail = strong positive intent (weight 1.5)
  useEffect(() => {
    if (!post || !isLoggedIn) return
    fetch('/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ post_id: postId, action: 'dwell', dwell_ms: 5000 }]),
      keepalive: true
    }).catch(() => {})
  }, [post?.id]) // eslint-disable-line

  async function submitComment() {
    if (!comment.trim()) return
    if (!isLoggedIn) { toast.error('Sign in to comment'); return }
    setLoading(true)
    try {
      await api.post(`/api/posts/${postId}/comments`, {
        content: comment.trim(),
        parent_id: replyTo?.id || null }, { requireAuth: true })
      setComment('')
      setReplyTo(null)
      mutateComments()
    } catch {
      toast.error('Could not post comment')
    } finally {
      setLoading(false)
    }
  }

  async function deletePost() {
    if (!confirm('Delete this post? This cannot be undone.')) return
    try {
      // Delete R2 media + soft-delete post in one call
      await api.post('/api/upload/delete', { post_id: postId }, { requireAuth: true })
      toast.success('Post deleted')
      router.push('/')
    } catch {
      // Fallback: just soft-delete if R2 cleanup fails
      try {
        await api.delete(`/api/posts/${postId}`, { requireAuth: true })
        toast.success('Post deleted')
        router.push('/')
      } catch (err) {
        toast.error(getErrorMessage(err))
      }
    }
  }

  if (postLoading) return <PostSkeleton />
  if (postError || !post) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center px-8">
        <div className="text-4xl mb-4">😕</div>
        <h3 className="font-semibold mb-2">Post not found</h3>
        <p className="text-sm text-text-secondary mb-4">It may have been deleted.</p>
        <Link href="/" className="btn-primary text-sm">Back to feed</Link>
      </div>
    )
  }

  const isOwner = profile && post.user_id === profile.id

  return (
    <div>
      <div className="border-b border-border">
        <FeedCard post={post} />
        {isOwner && (
          <div className="px-4 pb-3 flex justify-end">
            <button
              onClick={deletePost}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-accent-red transition-colors"
            >
              <Trash2 size={13} /> Delete post
            </button>
          </div>
        )}
      </div>

      {/* Comments list */}
      <div className="divide-y divide-border px-4 pt-2">
        {comments.length === 0 ? (
          <p className="text-center text-sm text-text-muted py-12">No comments yet. Be the first!</p>
        ) : (
          comments.map((c) => (
            <CommentItem key={c.id} comment={c} onReply={setReplyTo} />
          ))
        )}
      </div>

      {/* Comment input */}
      <div className="sticky bottom-16 lg:bottom-0 bg-bg/95 backdrop-blur-xl border-t border-border px-4 py-3">
        {replyTo && (
          <div className="flex items-center justify-between mb-2 text-xs text-text-muted bg-bg-card2 px-3 py-1.5 rounded-lg">
            <span>Replying to @{replyTo.user?.username || 'someone'}</span>
            <button onClick={() => setReplyTo(null)} className="hover:text-text">✕</button>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Avatar user={profile} size={32} />
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && submitComment()}
            placeholder={isLoggedIn ? 'Write a comment…' : 'Sign in to comment'}
            disabled={!isLoggedIn}
            maxLength={500}
            className="flex-1 bg-bg-card2 border border-border rounded-full px-4 py-2 text-sm outline-none focus:border-primary transition-colors placeholder:text-text-muted disabled:opacity-50"
          />
          <button
            onClick={submitComment}
            disabled={!comment.trim() || loading || !isLoggedIn}
            className="w-8 h-8 rounded-full bg-primary disabled:opacity-40 flex items-center justify-center text-white transition-opacity active:scale-95"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}

function CommentItem({ comment, onReply }: { comment: Comment; onReply: (c: Comment) => void }) {
  const displayName = comment.is_anonymous
    ? 'Anonymous'
    : (comment.user?.display_name || comment.user?.username || 'User')

  return (
    <div className="py-3">
      <div className="flex gap-3">
        {comment.is_anonymous ? (
          <div className="w-8 h-8 rounded-full bg-bg-card2 flex items-center justify-center text-sm flex-shrink-0">🕵️</div>
        ) : (
          <Link href={`/profile/${comment.user_id}`}>
            <Avatar user={comment.user} size={32} />
          </Link>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold">{displayName}</span>
            <span className="text-xs text-text-muted">{getRelativeTime(comment.created_at)}</span>
          </div>
          <p className="text-sm text-text leading-relaxed break-words">{comment.content}</p>
          <button
            onClick={() => onReply(comment)}
            className="text-xs text-text-muted hover:text-primary mt-1 transition-colors"
          >
            Reply
          </button>
          {comment.replies?.map((reply) => (
            <div key={reply.id} className="flex gap-2 mt-3 ml-2 pl-3 border-l border-border">
              {reply.is_anonymous ? (
                <div className="w-6 h-6 rounded-full bg-bg-card2 flex items-center justify-center text-xs flex-shrink-0">🕵️</div>
              ) : (
                <Link href={`/profile/${reply.user_id}`}>
                  <Avatar user={reply.user} size={24} />
                </Link>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">
                    {reply.is_anonymous ? 'Anonymous' : (reply.user?.display_name || reply.user?.username)}
                  </span>
                  <span className="text-xs text-text-muted">{getRelativeTime(reply.created_at)}</span>
                </div>
                <p className="text-sm text-text leading-relaxed break-words">{reply.content}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
