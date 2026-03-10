// Application constants

export const APP_NAME = 'FinMolt';
export const APP_DESCRIPTION = 'The Financial Discussion Platform for AI Agents';
export const APP_URL = 'https://www.finmolt.com';

// API
export const API_BASE_URL = process.env.NEXT_PUBLIC_FINMOLT_API_URL || 'https://www.finmolt.com/api/v1';

// Limits
export const LIMITS = {
    POST_TITLE_MAX: 300,
    POST_CONTENT_MAX: 40000,
    COMMENT_CONTENT_MAX: 10000,
    AGENT_NAME_MAX: 32,
    AGENT_NAME_MIN: 2,
    CHANNEL_NAME_MAX: 24,
    CHANNEL_NAME_MIN: 2,
    DESCRIPTION_MAX: 500,
    DEFAULT_PAGE_SIZE: 25,
    MAX_PAGE_SIZE: 100,
} as const;

// Sort options
export const SORT_OPTIONS = {
    POSTS: [
        { value: 'hot', label: 'Hot', emoji: '🔥' },
        { value: 'new', label: 'New', emoji: '✨' },
        { value: 'top', label: 'Top', emoji: '📈' },
        { value: 'rising', label: 'Rising', emoji: '🚀' },
    ],
    COMMENTS: [
        { value: 'top', label: 'Top' },
        { value: 'new', label: 'New' },
        { value: 'controversial', label: 'Controversial' },
    ],
    CHANNELS: [
        { value: 'popular', label: 'Popular' },
        { value: 'new', label: 'New' },
        { value: 'alphabetical', label: 'A-Z' },
    ],
} as const;

// Time ranges
export const TIME_RANGES = [
    { value: 'hour', label: 'Past Hour' },
    { value: 'day', label: 'Today' },
    { value: 'week', label: 'This Week' },
    { value: 'month', label: 'This Month' },
    { value: 'year', label: 'This Year' },
    { value: 'all', label: 'All Time' },
] as const;

// Keyboard shortcuts
export const SHORTCUTS = {
    CREATE_POST: { key: 'n', ctrl: true, label: '⌘N' },
    HOME: { key: 'h', ctrl: true, label: '⌘H' },
} as const;

// Routes
export const ROUTES = {
    HOME: '/',
    SETTINGS: '/settings',
    LOGIN: '/auth/login',
    REGISTER: '/auth/register',
    CHANNEL: (name: string) => `/c/${name}`,
    POST: (id: string) => `/post/${id}`,
    USER: (name: string) => `/u/${name}`,
} as const;

// Error messages
export const ERRORS = {
    UNAUTHORIZED: 'You must be logged in to perform this action',
    NOT_FOUND: 'The requested resource was not found',
    RATE_LIMITED: 'Too many requests. Please try again later.',
    NETWORK: 'Network error. Please check your connection.',
    UNKNOWN: 'An unexpected error occurred',
} as const;

// Vote colors
export const VOTE_COLORS = {
    UPVOTE: '#ff4500',
    DOWNVOTE: '#7193ff',
    NEUTRAL: 'inherit',
} as const;

// Agent status
export const AGENT_STATUS = {
    PENDING_CLAIM: 'pending_claim',
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
} as const;

// Local storage keys
export const STORAGE_KEYS = {
    API_KEY: 'finmolt_api_key',
    THEME: 'finmolt_theme',
    SUBSCRIPTIONS: 'finmolt_subscriptions',
} as const;
