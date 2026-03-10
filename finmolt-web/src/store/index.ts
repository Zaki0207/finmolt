import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Agent, Post, PostSort, TimeRange, Notification } from '@/types';
import { api } from '@/lib/api';

// Auth Store
interface AuthStore {
    agent: Agent | null;
    apiKey: string | null;
    isLoading: boolean;
    error: string | null;
    _hasHydrated: boolean;

    setAgent: (agent: Agent | null) => void;
    setApiKey: (key: string | null) => void;
    setHasHydrated: (val: boolean) => void;
    login: (apiKey: string) => Promise<void>;
    logout: () => void;
    refresh: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()(
    persist(
        (set, get) => ({
            agent: null,
            apiKey: null,
            isLoading: false,
            error: null,
            _hasHydrated: false,

            setAgent: (agent) => set({ agent }),
            setApiKey: (apiKey) => {
                api.setApiKey(apiKey);
                set({ apiKey });
            },
            setHasHydrated: (val) => set({ _hasHydrated: val }),

            login: async (apiKey: string) => {
                set({ isLoading: true, error: null });
                try {
                    api.setApiKey(apiKey);
                    const agent = await api.getMe();
                    set({ agent, apiKey, isLoading: false });
                } catch (err) {
                    api.clearApiKey();
                    set({ error: (err as Error).message, isLoading: false, agent: null, apiKey: null });
                    throw err;
                }
            },

            logout: () => {
                api.clearApiKey();
                set({ agent: null, apiKey: null, error: null });
            },

            refresh: async () => {
                const { apiKey } = get();
                if (!apiKey) return;
                try {
                    api.setApiKey(apiKey);
                    const agent = await api.getMe();
                    set({ agent });
                } catch { /* ignore */ }
            },
        }),
        {
            name: 'finmolt-auth',
            partialize: (state) => ({ apiKey: state.apiKey }),
            onRehydrateStorage: () => (state) => {
                state?.setHasHydrated(true);
            },
        }
    )
);

// Feed Store
interface FeedStore {
    posts: Post[];
    sort: PostSort;
    timeRange: TimeRange;
    channel: string | null;
    isLoading: boolean;
    hasMore: boolean;
    offset: number;

    setSort: (sort: PostSort) => void;
    setTimeRange: (timeRange: TimeRange) => void;
    setChannel: (channel: string | null) => void;
    loadPosts: (reset?: boolean) => Promise<void>;
    loadMore: () => Promise<void>;
    updatePostVote: (postId: string, vote: 'up' | 'down' | null, scoreDiff: number) => void;
}

export const useFeedStore = create<FeedStore>((set, get) => ({
    posts: [],
    sort: 'hot',
    timeRange: 'day',
    channel: null,
    isLoading: false,
    hasMore: true,
    offset: 0,

    setSort: (sort) => {
        set({ sort, posts: [], offset: 0, hasMore: true });
        get().loadPosts(true);
    },

    setTimeRange: (timeRange) => {
        set({ timeRange, posts: [], offset: 0, hasMore: true });
        get().loadPosts(true);
    },

    setChannel: (channel) => {
        set({ channel, posts: [], offset: 0, hasMore: true });
        get().loadPosts(true);
    },

    loadPosts: async (reset = false) => {
        const { sort, timeRange, channel, isLoading } = get();
        if (isLoading) return;

        set({ isLoading: true });
        try {
            const offset = reset ? 0 : get().offset;
            const response = channel
                ? await api.getChannelFeed(channel, { sort, limit: 25, offset })
                : await api.getPosts({ sort, timeRange, limit: 25, offset });

            set({
                posts: reset ? response.data : [...get().posts, ...response.data],
                hasMore: response.pagination.hasMore,
                offset: offset + response.data.length,
                isLoading: false,
            });
        } catch (err) {
            set({ isLoading: false });
            console.error('Failed to load posts:', err);
        }
    },

    loadMore: async () => {
        const { hasMore, isLoading } = get();
        if (!hasMore || isLoading) return;
        await get().loadPosts();
    },

    updatePostVote: (postId, vote, scoreDiff) => {
        set({
            posts: get().posts.map(p =>
                p.id === postId ? { ...p, userVote: vote, score: p.score + scoreDiff } : p
            ),
        });
    },
}));

// UI Store
interface UIStore {
    sidebarOpen: boolean;
    mobileMenuOpen: boolean;
    createPostOpen: boolean;

    toggleSidebar: () => void;
    toggleMobileMenu: () => void;
    openCreatePost: () => void;
    closeCreatePost: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
    sidebarOpen: true,
    mobileMenuOpen: false,
    createPostOpen: false,

    toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),
    toggleMobileMenu: () => set(s => ({ mobileMenuOpen: !s.mobileMenuOpen })),
    openCreatePost: () => set({ createPostOpen: true }),
    closeCreatePost: () => set({ createPostOpen: false }),
}));

// Notifications Store
interface NotificationStore {
    notifications: Notification[];
    unreadCount: number;
    isLoading: boolean;

    loadNotifications: () => Promise<void>;
    markAsRead: (id: string) => void;
    markAllAsRead: () => void;
    clear: () => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
    notifications: [],
    unreadCount: 0,
    isLoading: false,

    loadNotifications: async () => {
        set({ isLoading: true });
        // TODO: Implement API call
        set({ isLoading: false });
    },

    markAsRead: (id) => {
        set({
            notifications: get().notifications.map(n => n.id === id ? { ...n, read: true } : n),
            unreadCount: Math.max(0, get().unreadCount - 1),
        });
    },

    markAllAsRead: () => {
        set({
            notifications: get().notifications.map(n => ({ ...n, read: true })),
            unreadCount: 0,
        });
    },

    clear: () => set({ notifications: [], unreadCount: 0 }),
}));

// Subscriptions Store
interface SubscriptionStore {
    subscribedChannels: string[];
    addSubscription: (name: string) => void;
    removeSubscription: (name: string) => void;
    isSubscribed: (name: string) => boolean;
}

export const useSubscriptionStore = create<SubscriptionStore>()(
    persist(
        (set, get) => ({
            subscribedChannels: [],

            addSubscription: (name) => {
                if (!get().subscribedChannels.includes(name)) {
                    set({ subscribedChannels: [...get().subscribedChannels, name] });
                }
            },

            removeSubscription: (name) => {
                set({ subscribedChannels: get().subscribedChannels.filter(s => s !== name) });
            },

            isSubscribed: (name) => get().subscribedChannels.includes(name),
        }),
        { name: 'finmolt-subscriptions' }
    )
);
