import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowDown,
  Loader2,
  PanelLeft,
  Plus,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { auth } from './lib/firebase';
import type {
  ChatMessage,
  Conversation,
  MessageAttachment,
  PendingAttachment,
} from './types/chat';
import {
  preparePendingAttachment,
  validateAttachmentBatch,
  validateOutgoingPayload,
} from './lib/fileValidation';
import {
  deriveConversationTitle,
  loadAllConversations,
  removeConversation,
  saveConversation,
} from './lib/storage';
import {
  fetchFollowUpSuggestions,
  fetchHealthStatus,
  streamChatCompletion,
  toChatApiError,
} from './lib/api';
import {
  isChatSubmissionInFlight,
  releaseChatSubmission,
  tryAcquireChatSubmission,
} from './lib/submissionGuard';
import { detectContentBlockType } from './lib/contentDetector';
import {
  getSoundEnabled,
  playClickSound,
  playResponseSound,
  playSendSound,
  setSoundEnabledPref,
} from './lib/sound';
import { AuthScreen } from './components/AuthScreen';
import { ChatComposer } from './components/ChatComposer';
import { GlassBrandLogo } from './components/GlassBrandLogo';
import { MediaLightbox } from './components/MediaLightbox';
import { MessageBubble } from './components/MessageBubble';
import { Sidebar } from './components/Sidebar';
import { WelcomeScreen } from './components/WelcomeScreen';

// Disabled by default to keep each chat turn to a single primary Gemini API request.
const AUTO_FOLLOWUP_SUGGESTIONS_ENABLED = false;

function createBlankConversation(ownerUid?: string): Conversation {
  const now = Date.now();
  return {
    id: `conv-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ...(ownerUid ? { ownerUid } : {}),
    title: 'New Conversation',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [isStorageReady, setIsStorageReady] = useState(false);

  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 1024;
    }
    return false;
  });

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);

  const [lightboxMedia, setLightboxMedia] = useState<{ url: string; name: string } | null>(
    null
  );
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => getSoundEnabled());

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const submissionLockRef = useRef<symbol | null>(null);
  const activeUidRef = useRef<string | null>(null);
  const sessionFileCacheRef = useRef<Map<string, File[]>>(new Map());
  const dragDepthRef = useRef(0);

  const resetAccountSessionState = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    releaseChatSubmission(submissionLockRef);
    setIsStreaming(false);
    sessionFileCacheRef.current.clear();
    setConversations([]);
    setActiveId('');
    setIsStorageReady(false);
    setInput('');
    setAttachments((prev) => {
      for (const att of prev) {
        if (att.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl);
        }
      }
      return [];
    });
    setAttachmentError(null);
    setLightboxMedia(null);
    setShowScrollBottom(false);
    setIsDraggingFile(false);
    dragDepthRef.current = 0;
    userScrolledUpRef.current = false;
  }, []);

  // Monitor Firebase Authentication session state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      const nextUid = firebaseUser?.uid ?? null;
      if (activeUidRef.current !== nextUid) {
        activeUidRef.current = nextUid;
        resetAccountSessionState();
      }
      setUser(firebaseUser);
      setIsAuthLoading(false);
    });
    return () => {
      unsubscribe();
    };
  }, [resetAccountSessionState]);

  // Load persisted conversations & check backend health once authenticated
  useEffect(() => {
    const uid = user?.uid ?? null;
    if (!uid) {
      activeUidRef.current = null;
      resetAccountSessionState();
      return;
    }

    let active = true;
    activeUidRef.current = uid;
    setConversations([]);
    setActiveId('');
    setIsStorageReady(false);

    loadAllConversations(uid).then((loaded) => {
      if (!active || activeUidRef.current !== uid) return;
      if (loaded.length > 0) {
        setConversations(loaded);
        setActiveId((prev) =>
          prev && loaded.some((c) => c.id === prev) ? prev : loaded[0].id
        );
      } else {
        const fresh = createBlankConversation(uid);
        setConversations([fresh]);
        setActiveId(fresh.id);
      }
      setIsStorageReady(true);
    });

    fetchHealthStatus()
      .then((health) => {
        if (active && activeUidRef.current === uid) {
          setApiKeyConfigured(health.apiKeyConfigured);
        }
      })
      .catch(() => {
        if (active && activeUidRef.current === uid) {
          setApiKeyConfigured(true);
        }
      });

    return () => {
      active = false;
    };
  }, [user?.uid, resetAccountSessionState]);

  const activeConversation = useMemo(() => {
    return conversations.find((c) => c.id === activeId) ?? conversations[0] ?? null;
  }, [conversations, activeId]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    userScrolledUpRef.current = false;
    setShowScrollBottom(false);
  }, []);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > 120;
    userScrolledUpRef.current = scrolledUp;
    setShowScrollBottom(scrolledUp);
  };

  // Auto-scroll during active conversation updates unless user scrolled up
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      scrollToBottom(isStreaming ? 'auto' : 'smooth');
    }
  }, [activeConversation?.messages.length, activeConversation?.messages[activeConversation.messages.length - 1]?.content, isStreaming, scrollToBottom]);

  const updateConversation = useCallback(
    (
      convId: string,
      updater: (prev: Conversation) => Conversation,
      persist = true,
      expectedUid: string | null = activeUidRef.current
    ) => {
      if (!expectedUid || activeUidRef.current !== expectedUid) {
        return;
      }
      setConversations((prevList) => {
        if (activeUidRef.current !== expectedUid) {
          return prevList;
        }
        let updatedConv: Conversation | null = null;
        const nextList = prevList.map((conv) => {
          if (conv.id === convId && (!conv.ownerUid || conv.ownerUid === expectedUid)) {
            const next = updater(conv);
            updatedConv = { ...next, ownerUid: expectedUid };
            return updatedConv;
          }
          return conv;
        });
        nextList.sort((a, b) => b.updatedAt - a.updatedAt);
        if (persist && updatedConv && activeUidRef.current === expectedUid) {
          void saveConversation(expectedUid, updatedConv);
        }
        return nextList;
      });
    },
    []
  );

  const handleNewChat = useCallback(() => {
    if (isStreaming || isChatSubmissionInFlight(submissionLockRef)) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      releaseChatSubmission(submissionLockRef);
      setIsStreaming(false);
    }
    const current = conversations.find((c) => c.id === activeId);
    if (current && current.messages.length === 0) {
      return;
    }
    const uid = activeUidRef.current;
    if (!uid) return;
    const fresh = createBlankConversation(uid);
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setInput('');
    setAttachments([]);
    setAttachmentError(null);
    userScrolledUpRef.current = false;
  }, [activeId, conversations, isStreaming]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      if (isStreaming || isChatSubmissionInFlight(submissionLockRef)) {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        releaseChatSubmission(submissionLockRef);
        setIsStreaming(false);
      }
      setActiveId(id);
      setAttachmentError(null);
      userScrolledUpRef.current = false;
    },
    [isStreaming]
  );

  const handleRenameConversation = useCallback(
    (id: string, newTitle: string) => {
      updateConversation(id, (conv) => ({
        ...conv,
        title: newTitle,
        updatedAt: Date.now(),
      }));
    },
    [updateConversation]
  );

  const handleDeleteConversation = useCallback(
    (id: string) => {
      if ((isStreaming || isChatSubmissionInFlight(submissionLockRef)) && id === activeId) {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        releaseChatSubmission(submissionLockRef);
        setIsStreaming(false);
      }
      const uid = activeUidRef.current;
      if (uid) {
        void removeConversation(uid, id);
      }
      setConversations((prev) => {
        const remaining = prev.filter((c) => c.id !== id);
        if (remaining.length === 0) {
          const fresh = createBlankConversation(uid ?? undefined);
          setActiveId(fresh.id);
          return [fresh];
        }
        if (id === activeId) {
          setActiveId(remaining[0].id);
        }
        return remaining;
      });
    },
    [activeId, isStreaming]
  );

  const handleAddFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      if (incoming.length === 0) return;

      setAttachmentError(null);
      const { accepted, errors } = validateAttachmentBatch(incoming, attachments);
      const prepared: PendingAttachment[] = [];

      for (const file of accepted) {
        const item = await preparePendingAttachment(file);
        prepared.push(item);
      }

      if (errors.length > 0) {
        setAttachmentError(errors[0]);
      }
      if (prepared.length > 0) {
        setAttachments((prev) => [...prev, ...prepared]);
      }
    },
    [attachments]
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
    setAttachmentError(null);
  }, []);

  const executeStreamTurn = useCallback(
    async (params: {
      ownerUid: string;
      conversationId: string;
      history: ChatMessage[];
      userPrompt: string;
      files: File[];
      assistantMsgId: string;
      useWebSearch: boolean;
      submissionToken: symbol;
    }) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setIsStreaming(true);

      let accumulatedText = '';

      try {
        await streamChatCompletion({
          history: params.history,
          message: params.userPrompt,
          webSearch: params.useWebSearch,
          files: params.files,
          signal: controller.signal,
          onStatus: (phase) => {
            updateConversation(
              params.conversationId,
              (conv) => ({
                ...conv,
                messages: conv.messages.map((m) =>
                  m.id === params.assistantMsgId ? { ...m, streamPhase: phase } : m
                ),
              }),
              false,
              params.ownerUid
            );
          },
          onDelta: (delta) => {
            accumulatedText += delta;
            updateConversation(
              params.conversationId,
              (conv) => ({
                ...conv,
                messages: conv.messages.map((m) =>
                  m.id === params.assistantMsgId
                    ? { ...m, content: accumulatedText }
                    : m
                ),
              }),
              false,
              params.ownerUid
            );
          },
          onDone: (grounding) => {
            playResponseSound();
            updateConversation(
              params.conversationId,
              (conv) => ({
                ...conv,
                updatedAt: Date.now(),
                messages: conv.messages.map((m) =>
                  m.id === params.assistantMsgId
                    ? {
                        ...m,
                        content: accumulatedText,
                        grounding,
                        isStreaming: false,
                        streamPhase: undefined,
                      }
                    : m
                ),
              }),
              true,
              params.ownerUid
            );

            if (
              AUTO_FOLLOWUP_SUGGESTIONS_ENABLED &&
              accumulatedText.trim().length >= 70 &&
              !controller.signal.aborted
            ) {
              const detectedType = detectContentBlockType(
                params.userPrompt,
                accumulatedText,
                false
              );
              fetchFollowUpSuggestions({
                userMessage: params.userPrompt,
                assistantMessage: accumulatedText,
                contentType: detectedType,
                signal: controller.signal,
              }).then((suggestions) => {
                if (suggestions.length === 0 || controller.signal.aborted) return;
                updateConversation(
                  params.conversationId,
                  (conv) => ({
                    ...conv,
                    messages: conv.messages.map((m) =>
                      m.id === params.assistantMsgId && !m.error
                        ? { ...m, followUpSuggestions: suggestions }
                        : m
                    ),
                  }),
                  true,
                  params.ownerUid
                );
              });
            }
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          updateConversation(
            params.conversationId,
            (conv) => ({
              ...conv,
              updatedAt: Date.now(),
              messages: conv.messages.map((m) =>
                m.id === params.assistantMsgId
                  ? {
                      ...m,
                      content: accumulatedText || 'Generation stopped.',
                      isStreaming: false,
                      streamPhase: undefined,
                    }
                  : m
              ),
            }),
            true,
            params.ownerUid
          );
        } else {
          const apiError = toChatApiError(err);
          updateConversation(
            params.conversationId,
            (conv) => ({
              ...conv,
              updatedAt: Date.now(),
              messages: conv.messages.map((m) =>
                m.id === params.assistantMsgId
                  ? {
                      ...m,
                      content: accumulatedText,
                      isStreaming: false,
                      streamPhase: undefined,
                      error: apiError.message,
                      errorKind: apiError.kind,
                    }
                  : m
              ),
            }),
            true,
            params.ownerUid
          );
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (
          submissionLockRef.current === null ||
          submissionLockRef.current === params.submissionToken
        ) {
          releaseChatSubmission(submissionLockRef, params.submissionToken);
          setIsStreaming(false);
        }
      }
    },
    [updateConversation]
  );

  const handleSendMessage = useCallback(
    async (overridePrompt?: string, overrideWebSearch?: boolean) => {
      const ownerUid = activeUidRef.current;
      if (
        !ownerUid ||
        !activeConversation ||
        isStreaming ||
        isChatSubmissionInFlight(submissionLockRef)
      ) {
        return;
      }

      const promptText = typeof overridePrompt === 'string' ? overridePrompt : input;
      const trimmedPrompt = promptText.trim();
      const pending = typeof overridePrompt === 'string' ? [] : attachments;
      const useSearch =
        typeof overrideWebSearch === 'boolean' ? overrideWebSearch : webSearch;

      if (!trimmedPrompt && pending.length === 0) return;

      const filesToSend = pending.map((att) => att.file);
      const preValidation = validateOutgoingPayload({
        message: trimmedPrompt,
        files: filesToSend,
      });
      if (!preValidation.valid) {
        setAttachmentError(
          preValidation.error ?? 'Please check your message or attached files and try again.'
        );
        return;
      }

      const submissionToken = tryAcquireChatSubmission(submissionLockRef, isStreaming);
      if (!submissionToken) return;
      playSendSound();

      try {
        const convId = activeConversation.id;
        const priorMessages = activeConversation.messages.filter(
          (m) => !m.error && !m.isStreaming
        );

        const messageAttachments: MessageAttachment[] = pending.map((att) => ({
          id: att.id,
          name: att.name,
          size: att.size,
          mimeType: att.mimeType,
          kind: att.kind,
          previewUrl: att.previewUrl,
        }));

        const userMsgId = `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const assistantMsgId = `msg-ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        if (filesToSend.length > 0) {
          sessionFileCacheRef.current.set(userMsgId, filesToSend);
        }

        const userMessage: ChatMessage = {
          id: userMsgId,
          role: 'user',
          content: trimmedPrompt,
          createdAt: Date.now(),
          ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
        };

        const assistantPlaceholder: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          isStreaming: true,
          streamPhase: filesToSend.length > 0 ? 'processing_files' : 'generating',
        };

        const shouldAutoTitle =
          activeConversation.messages.length === 0 &&
          activeConversation.title === 'New Conversation';

        updateConversation(
          convId,
          (conv) => ({
            ...conv,
            title: shouldAutoTitle
              ? deriveConversationTitle(
                  promptText,
                  messageAttachments.map((a) => a.name)
                )
              : conv.title,
            updatedAt: Date.now(),
            messages: [...conv.messages, userMessage, assistantPlaceholder],
          }),
          true,
          ownerUid
        );

        if (typeof overridePrompt !== 'string') {
          setInput('');
          setAttachments([]);
        }
        setAttachmentError(null);
        userScrolledUpRef.current = false;

        await executeStreamTurn({
          ownerUid,
          conversationId: convId,
          history: priorMessages,
          userPrompt: trimmedPrompt,
          files: filesToSend,
          assistantMsgId,
          useWebSearch: useSearch,
          submissionToken,
        });
      } finally {
        releaseChatSubmission(submissionLockRef, submissionToken);
      }
    },
    [
      activeConversation,
      attachments,
      executeStreamTurn,
      input,
      isStreaming,
      updateConversation,
      webSearch,
    ]
  );

  const handleRetryLastAssistant = useCallback(async () => {
    const ownerUid = activeUidRef.current;
    if (
      !ownerUid ||
      !activeConversation ||
      isStreaming ||
      isChatSubmissionInFlight(submissionLockRef)
    ) {
      return;
    }
    const msgs = activeConversation.messages;
    if (msgs.length < 2) return;

    const lastMsg = msgs[msgs.length - 1];
    const userMsg = msgs[msgs.length - 2];
    if (lastMsg.role !== 'assistant' || userMsg.role !== 'user') return;

    const effectiveErrorKind =
      lastMsg.errorKind ??
      (lastMsg.error ? toChatApiError(new Error(lastMsg.error)).kind : undefined);
    if (effectiveErrorKind === 'quota' || effectiveErrorKind === 'auth') {
      return;
    }

    const cachedFiles = sessionFileCacheRef.current.get(userMsg.id) ?? [];
    if (userMsg.attachments && userMsg.attachments.length > 0 && cachedFiles.length === 0) {
      updateConversation(
        activeConversation.id,
        (conv) => ({
          ...conv,
          messages: conv.messages.map((m) =>
            m.id === lastMsg.id
              ? {
                  ...m,
                  error:
                    'Original attached files are no longer in memory after reloading. Please re-attach the files to re-analyze them.',
                  errorKind: 'retryable',
                }
              : m
          ),
        }),
        false
      );
      return;
    }

    const retryValidation = validateOutgoingPayload({
      message: userMsg.content,
      files: cachedFiles,
    });
    if (!retryValidation.valid) {
      updateConversation(
        activeConversation.id,
        (conv) => ({
          ...conv,
          messages: conv.messages.map((m) =>
            m.id === lastMsg.id
              ? {
                  ...m,
                  error:
                    retryValidation.error ??
                    'Message or attached files exceed allowed limits.',
                  errorKind: 'retryable',
                }
              : m
          ),
        }),
        false
      );
      return;
    }

    const submissionToken = tryAcquireChatSubmission(submissionLockRef, isStreaming);
    if (!submissionToken) return;
    playSendSound();

    try {
      const priorHistory = msgs.slice(0, -2).filter((m) => !m.error && !m.isStreaming);
      const assistantMsgId = lastMsg.id;

      updateConversation(
        activeConversation.id,
        (conv) => ({
          ...conv,
          messages: conv.messages.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: '',
                  error: undefined,
                  errorKind: undefined,
                  grounding: undefined,
                  followUpSuggestions: undefined,
                  isStreaming: true,
                  streamPhase:
                    cachedFiles.length > 0 ? 'processing_files' : 'generating',
                }
              : m
          ),
        }),
        false,
        ownerUid
      );

      await executeStreamTurn({
        ownerUid,
        conversationId: activeConversation.id,
        history: priorHistory,
        userPrompt: userMsg.content,
        files: cachedFiles,
        assistantMsgId,
        useWebSearch: webSearch,
        submissionToken,
      });
    } finally {
      releaseChatSubmission(submissionLockRef, submissionToken);
    }
  }, [activeConversation, executeStreamTurn, isStreaming, updateConversation, webSearch]);

  const handleStopStreaming = useCallback(() => {
    playClickSound();
    abortControllerRef.current?.abort();
  }, []);

  const handleToggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;
      setSoundEnabledPref(next);
      if (next) {
        playClickSound();
      }
      return next;
    });
  }, []);

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const previousUid = activeUidRef.current;
    try {
      activeUidRef.current = null;
      resetAccountSessionState();
      await signOut(auth);
    } catch (err) {
      console.error('Sign out failed:', err);
      const currentUid = auth.currentUser?.uid ?? null;
      if (currentUid && currentUid === previousUid) {
        activeUidRef.current = currentUid;
        const loaded = await loadAllConversations(currentUid);
        if (activeUidRef.current === currentUid) {
          const next = loaded.length > 0 ? loaded : [createBlankConversation(currentUid)];
          setConversations(next);
          setActiveId(next[0].id);
          setIsStorageReady(true);
        }
      }
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut, resetAccountSessionState]);

  // Drag & Drop handlers on the main chat canvas
  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingFile(true);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFile(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleAddFiles(e.dataTransfer.files);
    }
  };

  const messages = activeConversation?.messages ?? [];

  if (isAuthLoading) {
    return (
      <div className="veyric-backdrop relative flex h-dvh w-full items-center justify-center px-4 text-white">
        <div className="glass-panel veyric-panel-enter flex flex-col items-center gap-4 rounded-[30px] px-8 py-7 text-center">
          <div className="veyric-loading-orb">
            <GlassBrandLogo size={42} />
          </div>
          <div className="flex items-center gap-2 text-sm font-medium text-white/95">
            <Loader2 className="h-4 w-4 animate-spin text-white/90" />
            <span>Checking your session…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <div className="veyric-backdrop relative flex h-dvh w-full overflow-hidden text-white">
      {/* Frosted Glass Conversation History Sidebar */}
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversation?.id ?? ''}
        isOpen={isSidebarOpen}
        user={user}
        isSigningOut={isSigningOut}
        onSignOut={handleSignOut}
        onClose={() => setIsSidebarOpen(false)}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
      />

      {/* Main Conversation Workspace */}
      <main
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Compact Frosted Glass Header */}
        <header className="sticky top-0 z-20 px-3 pt-3 sm:px-6 sm:pt-3">
          <div className="glass-floating mx-auto flex h-14 max-w-4xl items-center justify-between gap-3 rounded-[22px] px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  playClickSound();
                  setIsSidebarOpen((prev) => !prev);
                }}
                className="glass-control flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white/85 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                aria-label={isSidebarOpen ? 'Hide chat history' : 'Show chat history'}
              >
                <PanelLeft className="h-4.5 w-4.5" />
              </button>

              <div className="flex min-w-0 items-center gap-2.5">
                <GlassBrandLogo size={24} className="shrink-0" />
                <span className="font-display text-sm font-semibold tracking-wide text-white whitespace-nowrap shrink-0">
                  VEYRIC AI
                </span>
                {activeConversation && activeConversation.messages.length > 0 && (
                  <>
                    <span className="hidden text-white/50 sm:inline" aria-hidden="true">
                      /
                    </span>
                    <span className="hidden truncate text-xs text-white/85 sm:inline">
                      {activeConversation.title}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={handleToggleSound}
                aria-pressed={soundEnabled}
                aria-label={soundEnabled ? 'Turn off sound effects' : 'Turn on sound effects'}
                title={soundEnabled ? 'Sound On' : 'Sound Off'}
                className="glass-control flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white/85 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                {soundEnabled ? (
                  <Volume2 className="h-4 w-4" />
                ) : (
                  <VolumeX className="h-4 w-4 text-white/60" />
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  playClickSound();
                  handleNewChat();
                }}
                className="glass-control inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-white whitespace-nowrap focus-visible:outline-2 focus-visible:outline-white"
                aria-label="Start new chat"
              >
                <Plus className="h-4 w-4" />
                <span>New Chat</span>
              </button>
            </div>
          </div>
        </header>

        {/* Server API Key Configuration Notice (only shown if server reports missing key) */}
        {apiKeyConfigured === false && (
          <div className="mx-auto mt-3 w-full max-w-3xl px-4 sm:px-6">
            <div
              role="alert"
              className="glass-surface flex items-start gap-3 rounded-2xl border-amber-300/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100 sm:text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <span>
                Server Gemini API key is not configured yet. Add <code className="font-mono">GEMINI_API_KEY</code> in Settings &gt; Secrets to enable live AI responses.
              </span>
            </div>
          </div>
        )}

        {/* Scrollable Conversation Area */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="glass-scroll relative flex flex-1 flex-col overflow-y-auto px-3 pb-4 pt-4 sm:px-6"
        >
          {!isStorageReady ? (
            <div className="mx-auto flex w-full max-w-3xl flex-1 items-center justify-center">
              <div className="glass-surface veyric-panel-enter flex items-center gap-2.5 rounded-2xl px-5 py-3 text-sm text-white/90">
                <span className="veyric-loading-orb h-2 w-2 rounded-full bg-white/90" aria-hidden="true" />
                <span>Loading conversations…</span>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <WelcomeScreen
              onSelectPrompt={(prompt, enableWebSearch) => {
                handleSendMessage(prompt, enableWebSearch);
              }}
            />
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 pb-4">
              {messages.map((msg, idx) => {
                const precedingUserPrompt =
                  msg.role === 'assistant' && idx > 0 && messages[idx - 1].role === 'user'
                    ? messages[idx - 1].content
                    : '';
                const isLastAssistant =
                  msg.role === 'assistant' && idx === messages.length - 1;

                return (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    precedingUserPrompt={precedingUserPrompt}
                    isLatestAssistant={isLastAssistant}
                    canRetry={isLastAssistant}
                    onRetry={handleRetryLastAssistant}
                    onReauthenticate={handleSignOut}
                    onSelectFollowUp={(suggestion) => handleSendMessage(suggestion)}
                    onPreviewImage={(url, name) => setLightboxMedia({ url, name })}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Scroll to Bottom Floating Control */}
        {showScrollBottom && messages.length > 0 && (
          <div className="pointer-events-none relative mx-auto flex w-full max-w-3xl justify-center">
            <button
              type="button"
              onClick={() => {
                playClickSound();
                scrollToBottom('smooth');
              }}
              className="pointer-events-auto glass-floating absolute -top-12 flex h-10 w-10 items-center justify-center rounded-full text-white/90 transition-transform duration-150 hover:scale-105 hover:text-white active:scale-95 focus-visible:outline-2 focus-visible:outline-white"
              aria-label="Scroll to latest messages"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Floating Glass Composer */}
        <ChatComposer
          input={input}
          onInputChange={setInput}
          attachments={attachments}
          onAddFiles={handleAddFiles}
          onRemoveAttachment={handleRemoveAttachment}
          attachmentError={attachmentError}
          onDismissAttachmentError={() => setAttachmentError(null)}
          webSearch={webSearch}
          onToggleWebSearch={() => setWebSearch((prev) => !prev)}
          isStreaming={isStreaming}
          onSend={() => handleSendMessage()}
          onStop={handleStopStreaming}
        />

        {/* Drag & Drop Frosted Glass Overlay (blur confined strictly to card, wallpaper stays sharp) */}
        {isDraggingFile && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-6">
            <div className="glass-panel veyric-panel-enter flex max-w-md flex-col items-center rounded-[28px] border-dashed border-white/60 px-8 py-10 text-center">
              <GlassBrandLogo size={40} />
              <p className="mt-4 font-display text-lg font-semibold text-white">
                Drop files to attach
              </p>
              <p className="mt-1 text-xs text-white/85">
                Supports JPG, PNG, WEBP, MP4, MOV, WEBM, PDF, TXT, and DOCX (up to 25 MB)
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Lightbox for Full-Size Image Inspection */}
      <MediaLightbox
        imageUrl={lightboxMedia?.url ?? null}
        alt={lightboxMedia?.name ?? ''}
        onClose={() => setLightboxMedia(null)}
      />
    </div>
  );
}
