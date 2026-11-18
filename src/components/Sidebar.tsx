import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Check,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  User as UserIcon,
  X,
} from 'lucide-react';
import type { Conversation } from '../types/chat';
import { GlassBrandLogo } from './GlassBrandLogo';

interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: string;
  isOpen: boolean;
  user: User;
  isSigningOut: boolean;
  onSignOut: () => void;
  onClose: () => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (id: string, newTitle: string) => void;
  onDeleteConversation: (id: string) => void;
}

type DateGroup = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Older';

function getDateGroup(timestamp: number): DateGroup {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const oneDay = 24 * 60 * 60 * 1000;

  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfToday - oneDay) return 'Yesterday';
  if (timestamp >= startOfToday - 7 * oneDay) return 'Previous 7 Days';
  return 'Older';
}

export function Sidebar({
  conversations,
  activeConversationId,
  isOpen,
  user,
  isSigningOut,
  onSignOut,
  onClose,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    setAvatarError(false);
  }, [user.photoURL]);

  const groupedConversations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = conversations.filter((conv) => {
      if (!query) return true;
      if (conv.title.toLowerCase().includes(query)) return true;
      return conv.messages.some((m) => m.content.toLowerCase().includes(query));
    });

    const groups: Record<DateGroup, Conversation[]> = {
      Today: [],
      Yesterday: [],
      'Previous 7 Days': [],
      Older: [],
    };

    for (const conv of filtered) {
      groups[getDateGroup(conv.updatedAt)].push(conv);
    }

    return (['Today', 'Yesterday', 'Previous 7 Days', 'Older'] as DateGroup[])
      .map((label) => ({ label, items: groups[label] }))
      .filter((g) => g.items.length > 0);
  }, [conversations, searchQuery]);

  const startEditing = (conv: Conversation) => {
    setConfirmDeleteId(null);
    setEditingId(conv.id);
    setEditingTitle(conv.title);
  };

  const commitRename = (id: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      onRenameConversation(id, trimmed);
    }
    setEditingId(null);
    setEditingTitle('');
  };

  return (
    <>
      {/* Mobile / Tablet backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="Conversation history"
        className={`glass-panel fixed inset-y-3 left-3 z-40 flex w-[290px] flex-col rounded-3xl transition-transform duration-200 ease-out lg:static lg:inset-auto lg:my-3 lg:ml-3 lg:h-[calc(100%-1.5rem)] lg:w-[296px] lg:shrink-0 lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-[calc(100%+1.5rem)] lg:hidden'
        }`}
      >
        {/* Top Brand + Close (mobile) */}
        <div className="flex items-center justify-between gap-3 border-b border-white/25 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <GlassBrandLogo size={26} />
            <span className="font-display text-sm font-semibold tracking-wide text-white whitespace-nowrap">
              VEYRIC AI
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="glass-control flex h-10 w-10 items-center justify-center rounded-xl text-white/75 hover:text-white focus-visible:outline-2 focus-visible:outline-white lg:hidden"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* New Chat + Search */}
        <div className="space-y-2.5 p-3.5">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onClose();
            }}
            className="glass-control flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl bg-white/[0.09] px-4 py-2.5 text-sm font-medium text-white hover:bg-white/[0.15] focus-visible:outline-2 focus-visible:outline-white"
          >
            <Plus className="h-4 w-4" />
            <span className="whitespace-nowrap">New Chat</span>
          </button>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/70" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="min-h-[40px] w-full rounded-xl border border-white/28 bg-white/[0.12] pl-9 pr-3 text-xs text-white placeholder:text-white/65 focus:border-white/55 focus:bg-white/[0.18] focus:outline-none"
            />
          </div>
        </div>

        {/* Conversation List */}
        <div className="glass-scroll flex-1 overflow-y-auto px-2.5 pb-4">
          {groupedConversations.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <p className="text-xs text-white/50">
                {searchQuery.trim()
                  ? 'No matching conversations found.'
                  : 'Your saved conversations will appear here.'}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {groupedConversations.map((group) => (
                <div key={group.label}>
                  <p className="px-2.5 pb-1.5 text-[11px] font-medium text-white/70">
                    {group.label}
                  </p>
                  <ul className="space-y-1">
                    {group.items.map((conv) => {
                      const isActive = conv.id === activeConversationId;
                      const isEditing = editingId === conv.id;
                      const isConfirmingDelete = confirmDeleteId === conv.id;

                      return (
                        <li key={conv.id}>
                          {isEditing ? (
                            <div className="flex items-center gap-1.5 rounded-2xl border border-white/20 bg-white/10 p-1.5">
                              <input
                                type="text"
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitRename(conv.id);
                                  if (e.key === 'Escape') {
                                    setEditingId(null);
                                    setEditingTitle('');
                                  }
                                }}
                                autoFocus
                                aria-label="Rename conversation"
                                className="min-h-[34px] min-w-0 flex-1 rounded-lg bg-black/30 px-2.5 text-xs text-white focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => commitRename(conv.id)}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15 text-white hover:bg-white/25"
                                aria-label="Save name"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingId(null);
                                  setEditingTitle('');
                                }}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white"
                                aria-label="Cancel rename"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : isConfirmingDelete ? (
                            <div className="flex items-center justify-between gap-2 rounded-2xl border border-rose-300/25 bg-rose-500/10 px-3 py-2">
                              <span className="truncate text-xs text-rose-100">
                                Delete chat?
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    onDeleteConversation(conv.id);
                                    setConfirmDeleteId(null);
                                  }}
                                  className="min-h-[30px] rounded-lg bg-rose-500/35 px-2.5 text-xs font-medium text-white hover:bg-rose-500/50"
                                >
                                  Delete
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="min-h-[30px] rounded-lg px-2 text-xs text-white/70 hover:bg-white/10 hover:text-white"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div
                              className={`group flex min-h-[44px] items-center justify-between gap-1.5 rounded-2xl px-2.5 py-1.5 transition-colors ${
                                isActive
                                  ? 'border border-white/45 bg-white/[0.22] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]'
                                  : 'border border-transparent text-white/85 hover:border-white/25 hover:bg-white/[0.12] hover:text-white'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  onSelectConversation(conv.id);
                                  onClose();
                                }}
                                className="flex min-h-[36px] min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-white"
                              >
                                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-white/70" />
                                <span className="truncate py-0.5 text-[13px] font-medium leading-[1.6]">
                                  {conv.title}
                                </span>
                              </button>

                              <div className="flex shrink-0 items-center gap-0.5 opacity-90 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startEditing(conv);
                                  }}
                                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white/55 hover:bg-white/10 hover:text-white focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white"
                                  aria-label={`Rename ${conv.title}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingId(null);
                                    setConfirmDeleteId(conv.id);
                                  }}
                                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white/55 hover:bg-rose-500/20 hover:text-rose-200 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white"
                                  aria-label={`Delete ${conv.title}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Account & Sign Out Footer */}
        <div className="border-t border-white/20 p-3.5">
          <div className="flex items-center justify-between gap-2.5 rounded-2xl border border-white/25 bg-white/[0.08] px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              {user.photoURL && !avatarError ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName ?? user.email ?? 'Account avatar'}
                  referrerPolicy="no-referrer"
                  onError={() => setAvatarError(true)}
                  className="h-8 w-8 shrink-0 rounded-full border border-white/40 object-cover"
                />
              ) : (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/35 bg-white/[0.16] text-white">
                  <UserIcon className="h-4 w-4" />
                </div>
              )}

              <div className="min-w-0">
                <p className="truncate py-0.5 text-xs font-medium leading-[1.4] text-white">
                  {user.displayName || user.email?.split('@')[0] || 'VEYRIC User'}
                </p>
                {user.email && (
                  <p className="truncate text-[11px] leading-[1.35] text-white/70">
                    {user.email}
                  </p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={onSignOut}
              disabled={isSigningOut}
              className="glass-control inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium text-white/90 hover:text-white disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-white"
              aria-label="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>{isSigningOut ? 'Signing out…' : 'Sign Out'}</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
