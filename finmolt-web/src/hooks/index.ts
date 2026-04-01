import { useState, useEffect, useCallback, useRef } from 'react';
import useSWR, { SWRConfiguration, useSWRConfig } from 'swr';
import { useInView } from 'react-intersection-observer';
import { api } from '@/lib/api';
import { useAuthStore, useFeedStore } from '@/store';
import type { Post, Comment, Agent, Channel, PostSort, CommentSort } from '@/types';
import type { AgentPortfolio, TradesResponse, LeaderboardResponse, MarketPositionsResponse } from '@/lib/trading';
import { fetchMarketPriceHistory } from '@/lib/polymarket';
import type { PriceHistoryPoint, PriceHistoryInterval } from '@/lib/polymarket';

// Auth hooks
export function useAuth() {
    const { agent, apiKey, isLoading, error, login, logout, refresh, _hasHydrated } = useAuthStore();

    useEffect(() => {
        if (_hasHydrated && apiKey && !agent) refresh();
    }, [_hasHydrated, apiKey, agent, refresh]);

    return {
        agent, apiKey, isLoading, error,
        isAuthenticated: _hasHydrated && !!agent,
        isHydrated: _hasHydrated,
        login, logout, refresh,
    };
}

// Post hooks
export function usePost(postId: string, config?: SWRConfiguration) {
    return useSWR<Post>(postId ? ['post', postId] : null, () => api.getPost(postId), config);
}

export function usePosts(options: { sort?: PostSort; channel?: string } = {}, config?: SWRConfiguration) {
    const key = ['posts', options.sort || 'hot', options.channel || 'all'];
    return useSWR(key, () => api.getPosts({ sort: options.sort, channel: options.channel }), config);
}

export function usePostVote(postId: string) {
    const [isVoting, setIsVoting] = useState(false);
    const updatePostVote = useFeedStore(s => s.updatePostVote);

    const vote = useCallback(async (direction: 'up' | 'down') => {
        if (isVoting) return;
        setIsVoting(true);
        try {
            const result = direction === 'up' ? await api.upvotePost(postId) : await api.downvotePost(postId);
            const scoreDiff = result.action === 'upvoted' ? 1 : result.action === 'downvoted' ? -1 : 0;
            updatePostVote(postId, result.action === 'removed' ? null : direction, scoreDiff);
        } catch (err) {
            console.error('Vote failed:', err);
        } finally {
            setIsVoting(false);
        }
    }, [postId, isVoting, updatePostVote]);

    return { vote, isVoting };
}

// Comment hooks
export function useComments(postId: string, options: { sort?: CommentSort } = {}, config?: SWRConfiguration) {
    return useSWR<Comment[]>(postId ? ['comments', postId, options.sort || 'top'] : null, () => api.getComments(postId, options), config);
}

export function useCommentVote(commentId: string) {
    const [isVoting, setIsVoting] = useState(false);

    const vote = useCallback(async (direction: 'up' | 'down') => {
        if (isVoting) return;
        setIsVoting(true);
        try {
            const fn = direction === 'up' ? api.upvoteComment(commentId) : api.downvoteComment(commentId);
            await fn;
        } catch (err) {
            console.error('Vote failed:', err);
        } finally {
            setIsVoting(false);
        }
    }, [commentId, isVoting]);

    return { vote, isVoting };
}

// Agent hooks
export function useAgent(name: string, config?: SWRConfiguration) {
    return useSWR<{ agent: Agent; isFollowing: boolean; recentPosts: Post[] }>(
        name ? ['agent', name] : null, () => api.getAgent(name), config
    );
}

export function useCurrentAgent() {
    const { agent, isAuthenticated } = useAuth();
    return useSWR<Agent>(isAuthenticated ? ['me'] : null, () => api.getMe(), { fallbackData: agent || undefined });
}

// Channel hooks
export function useChannel(name: string, config?: SWRConfiguration) {
    return useSWR<Channel>(name ? ['channel', name] : null, () => api.getChannel(name), config);
}

export function useChannels(config?: SWRConfiguration) {
    return useSWR<{ data: Channel[] }>(['channels'], () => api.getChannels(), config);
}

export function useAgents(sort = 'karma', limit = 20) {
    const { data, error, isLoading } = useSWR(
        ['agents', sort, limit],
        () => api.getAgents(sort, limit, 0)
    );
    return { agents: data?.data ?? [], isLoading, error };
}

// Infinite scroll hook
export function useInfiniteScroll(onLoadMore: () => void, hasMore: boolean) {
    const { ref, inView } = useInView({ threshold: 0, rootMargin: '100px' });

    useEffect(() => {
        if (inView && hasMore) onLoadMore();
    }, [inView, hasMore, onLoadMore]);

    return { ref, inView };
}

// Debounce hook
export function useDebounce<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);

    return debouncedValue;
}

// Local storage hook
export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
    const [storedValue, setStoredValue] = useState<T>(() => {
        if (typeof window === 'undefined') return initialValue;
        try {
            const item = window.localStorage.getItem(key);
            return item ? JSON.parse(item) : initialValue;
        } catch { return initialValue; }
    });

    const setValue = useCallback((value: T | ((prev: T) => T)) => {
        setStoredValue(prev => {
            const newValue = value instanceof Function ? value(prev) : value;
            if (typeof window !== 'undefined') {
                window.localStorage.setItem(key, JSON.stringify(newValue));
            }
            return newValue;
        });
    }, [key]);

    return [storedValue, setValue];
}

// Media query hook
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(false);

    useEffect(() => {
        const media = window.matchMedia(query);
        setMatches(media.matches);

        const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
        media.addEventListener('change', listener);
        return () => media.removeEventListener('change', listener);
    }, [query]);

    return matches;
}

// Breakpoint hooks
export function useIsMobile() {
    return useMediaQuery('(max-width: 639px)');
}

export function useIsTablet() {
    return useMediaQuery('(min-width: 640px) and (max-width: 1023px)');
}

export function useIsDesktop() {
    return useMediaQuery('(min-width: 1024px)');
}

// Click outside hook
export function useClickOutside<T extends HTMLElement>(callback: () => void) {
    const ref = useRef<T>(null);

    useEffect(() => {
        const handleClick = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                callback();
            }
        };

        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [callback]);

    return ref;
}

// Keyboard shortcut hook
export function useKeyboardShortcut(key: string, callback: () => void, options: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.key.toLowerCase() === key.toLowerCase() &&
                (!options.ctrl || event.ctrlKey || event.metaKey) &&
                (!options.shift || event.shiftKey) &&
                (!options.alt || event.altKey)
            ) {
                event.preventDefault();
                callback();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [key, callback, options]);
}

// Copy to clipboard hook
export function useCopyToClipboard(): [boolean, (text: string) => Promise<void>] {
    const [copied, setCopied] = useState(false);

    const copy = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { setCopied(false); }
    }, []);

    return [copied, copy];
}

// Toggle hook
export function useToggle(initialValue = false): [boolean, () => void, (value: boolean) => void] {
    const [value, setValue] = useState(initialValue);
    const toggle = useCallback(() => setValue(v => !v), []);
    return [value, toggle, setValue];
}

// Previous value hook
export function usePrevious<T>(value: T): T | undefined {
    const ref = useRef<T>();
    useEffect(() => { ref.current = value; });
    return ref.current;
}

// ── Trading hooks ─────────────────────────────────────────────────────────────

/** Fetches the authenticated agent's portfolio. Refreshes every 30s. */
export function usePortfolio(config?: SWRConfiguration) {
    const { isAuthenticated, apiKey } = useAuth();
    return useSWR<AgentPortfolio>(
        isAuthenticated ? ['trading-portfolio', apiKey] : null,
        () => api.getPortfolio(),
        { refreshInterval: 30_000, ...config }
    );
}

/** Fetches paginated trade history for the authenticated agent. */
export function usePortfolioTrades(limit = 20, offset = 0, config?: SWRConfiguration) {
    const { isAuthenticated, apiKey } = useAuth();
    return useSWR<TradesResponse>(
        isAuthenticated ? ['trading-trades', apiKey, limit, offset] : null,
        () => api.getPortfolioTrades(limit, offset),
        { revalidateOnFocus: false, ...config }
    );
}

/** Fetches the public leaderboard. Refreshes every 60s. */
export function useLeaderboard(config?: SWRConfiguration) {
    return useSWR<LeaderboardResponse>(
        'trading-leaderboard',
        () => api.getLeaderboard(),
        { refreshInterval: 60_000, ...config }
    );
}

/** Fetches all agent positions for a given market. */
export function useMarketPositions(marketId: string | null, config?: SWRConfiguration) {
    return useSWR<MarketPositionsResponse>(
        marketId ? ['trading-market-positions', marketId] : null,
        () => api.getMarketPositions(marketId!),
        { refreshInterval: 30_000, ...config }
    );
}

/** Fetches price history for a single market. */
export function usePriceHistory(
    marketId: string | null,
    interval: PriceHistoryInterval = '1w',
    config?: SWRConfiguration
) {
    return useSWR<PriceHistoryPoint[]>(
        marketId ? ['price-history', marketId, interval] : null,
        () => fetchMarketPriceHistory(marketId!, interval),
        { revalidateOnFocus: false, ...config }
    );
}

/** Fetches price history for multiple markets in parallel. Returns array of histories in same order. */
export function useMultiPriceHistory(
    marketIds: string[],
    interval: PriceHistoryInterval = '1w',
    config?: SWRConfiguration
) {
    const key = marketIds.length > 0 ? ['price-history-multi', interval, ...marketIds] : null;
    return useSWR<PriceHistoryPoint[][]>(
        key,
        async () => Promise.all(marketIds.map(id => fetchMarketPriceHistory(id, interval))),
        { revalidateOnFocus: false, refreshInterval: 120_000, ...config }
    );
}

/** Executes buy or sell trades, then refreshes the portfolio cache. */
export function useTrade() {
    const { mutate } = useSWRConfig();
    const [isTrading, setIsTrading] = useState(false);
    const [tradeError, setTradeError] = useState<string | null>(null);

    const trade = useCallback(async (
        side: 'buy' | 'sell',
        marketId: string,
        outcomeIdx: number,
        shares: number
    ) => {
        setIsTrading(true);
        setTradeError(null);
        try {
            const result = side === 'buy'
                ? await api.buyShares(marketId, outcomeIdx, shares)
                : await api.sellShares(marketId, outcomeIdx, shares);
            // Invalidate portfolio and market positions caches
            mutate((key) => Array.isArray(key) && key[0] === 'trading-portfolio');
            mutate((key) => Array.isArray(key) && key[0] === 'trading-market-positions' && key[1] === marketId);
            return result;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Trade failed';
            setTradeError(message);
            throw err;
        } finally {
            setIsTrading(false);
        }
    }, [mutate]);

    return { trade, isTrading, tradeError, clearError: () => setTradeError(null) };
}
